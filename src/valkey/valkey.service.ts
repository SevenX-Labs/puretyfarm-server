import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GlideClient, TimeUnit, Script } from "@valkey/valkey-glide";

interface MemoryEntry {
  value: string;
  expiresAt: number | null; // epoch ms or null for no expiry
}

@Injectable()
export class ValkeyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ValkeyService.name);
  private client: GlideClient | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isInitialized = false;

  // In-memory fallback store to ensure zero downtime when remote Valkey/Redis is unreachable
  private readonly memoryStore = new Map<string, MemoryEntry>();

  // Compiled Lua scripts are cached by source so we do not recreate them per call.
  private readonly scriptCache = new Map<string, Script>();

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const rawValkeyUrl =
      this.configService.get<string>("VALKEY_URL") || process.env.VALKEY_URL;

    if (!rawValkeyUrl) {
      const errorMsg =
        "VALKEY_URL is not defined in configuration or environment variables";
      this.logger.error(`Valkey connection failed: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    this.isInitialized = true;

    let password = "";
    try {
      // Strip potential enclosing quotes
      let cleanUrl = rawValkeyUrl.trim();
      if (
        (cleanUrl.startsWith('"') && cleanUrl.endsWith('"')) ||
        (cleanUrl.startsWith("'") && cleanUrl.endsWith("'"))
      ) {
        cleanUrl = cleanUrl.slice(1, -1).trim();
      }

      const parsedUrl = new URL(cleanUrl);
      const isTls = parsedUrl.protocol === "rediss:";
      const hostname = parsedUrl.hostname;
      const port = parsedUrl.port ? Number(parsedUrl.port) : 6379;
      const username = parsedUrl.username
        ? decodeURIComponent(parsedUrl.username)
        : "default";
      password = parsedUrl.password
        ? decodeURIComponent(parsedUrl.password)
        : "";

      this.logger.log(
        `Connecting to Valkey at ${hostname}:${port} (TLS: ${isTls ? "enabled" : "disabled"})...`,
      );

      const clientPromise = GlideClient.createClient({
        addresses: [{ host: hostname, port }],
        credentials: password
          ? {
              username,
              password,
            }
          : undefined,
        useTLS: isTls,
        requestTimeout: 2500,
        connectionBackoff: {
          numberOfRetries: 3,
          factor: 200,
          exponentBase: 2,
          jitterPercent: 20,
        },
        advancedConfiguration: {
          connectionTimeout: 2500,
        },
      });

      // Guard connection attempt with a 3-second hard timeout
      this.client = await Promise.race([
        clientPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Valkey connection timed out after 3000ms")), 3000),
        ),
      ]);

      // Verify connection with a lightweight PING
      const pingResult = await this.client.ping();
      this.logger.log(`Valkey connected successfully (Ping: ${pingResult})`);

      // Start periodic heartbeat ping (every 30 seconds) to prevent cloud idle connection reset
      this.startHeartbeat();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const sanitized = password
        ? errorMessage.split(password).join("******")
        : errorMessage;
      this.logger.warn(
        `Valkey remote connection unavailable (${sanitized}). Gracefully activating resilient in-memory storage fallback.`,
      );
      this.client = null;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      if (this.client) {
        try {
          await this.client.ping();
        } catch (err) {
          this.logger.debug(
            `Valkey keep-alive ping failed (client will auto-reconnect): ${err}`,
          );
        }
      }
    }, 30000);

    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.client) {
      try {
        this.client.close();
        this.logger.log("Valkey connection closed successfully.");
      } catch (error) {
        this.logger.error("Error closing Valkey connection", error);
      } finally {
        this.client = null;
      }
    }

    this.memoryStore.clear();
    this.isInitialized = false;
  }

  getClient(): GlideClient | null {
    return this.client;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized && !this.client) {
      throw new Error("Valkey client is not initialized");
    }
  }

  /**
   * Helper to race an operation against a fast timeout to avoid blocking caller.
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs = 2500,
  ): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  /**
   * Automatically retries an operation once if a transient connection reset occurs.
   */
  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes("Connection error") ||
        msg.includes("Connection reset") ||
        msg.includes("ConnectionError") ||
        msg.includes("os error 104")
      ) {
        this.logger.warn(
          `Valkey connection reset detected. Waiting for auto-reconnect and retrying...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        return await operation();
      }
      throw error;
    }
  }

  // ==========================================
  // IN-MEMORY FALLBACK STORE METHODS
  // ==========================================

  private memGet(key: string): string | null {
    const entry = this.memoryStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.memoryStore.delete(key);
      return null;
    }
    return entry.value;
  }

  private memSet(key: string, value: string, ttlSeconds?: number): string {
    this.memoryStore.set(key, {
      value,
      expiresAt:
        ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
    });
    return "OK";
  }

  private memDelete(key: string): number {
    return this.memoryStore.delete(key) ? 1 : 0;
  }

  private memIncr(key: string): number {
    const current = this.memGet(key);
    const next = (current ? Number(current) : 0) + 1;
    const entry = this.memoryStore.get(key);
    this.memoryStore.set(key, {
      value: String(next),
      expiresAt: entry ? entry.expiresAt : null,
    });
    return next;
  }

  private memExpire(key: string, seconds: number): boolean {
    const entry = this.memoryStore.get(key);
    if (!entry || (entry.expiresAt !== null && Date.now() > entry.expiresAt)) {
      this.memoryStore.delete(key);
      return false;
    }
    entry.expiresAt = Date.now() + seconds * 1000;
    return true;
  }

  private memTtl(key: string): number {
    const entry = this.memoryStore.get(key);
    if (!entry || (entry.expiresAt !== null && Date.now() > entry.expiresAt)) {
      this.memoryStore.delete(key);
      return -2;
    }
    if (entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  private memCompareAndDelete(key: string, expected: string): boolean {
    const current = this.memGet(key);
    if (current === expected) {
      this.memoryStore.delete(key);
      return true;
    }
    return false;
  }

  private memReserveSendSlot(
    cooldownKey: string,
    cooldownTtlSeconds: number,
    counters: Array<{ key: string; limit: number; ttlSeconds: number }>,
  ): number {
    if (this.memGet(cooldownKey) !== null) {
      return -1;
    }
    for (let i = 0; i < counters.length; i++) {
      const cur = Number(this.memGet(counters[i].key) || "0");
      if (cur >= counters[i].limit) {
        return -(i + 2);
      }
    }
    for (let i = 0; i < counters.length; i++) {
      const v = this.memIncr(counters[i].key);
      if (v === 1) {
        this.memExpire(counters[i].key, counters[i].ttlSeconds);
      }
    }
    this.memSet(cooldownKey, "1", cooldownTtlSeconds);
    return 0;
  }

  // ==========================================
  // PUBLIC VALKEY CLIENT METHODS WITH RESILIENT FALLBACK
  // ==========================================

  async get(key: string): Promise<string | null> {
    this.ensureInitialized();
    if (!this.client) {
      return this.memGet(key);
    }
    try {
      return await this.executeWithTimeout(
        () =>
          this.executeWithRetry(async () => {
            const result = await this.client!.get(key);
            return result as string | null;
          }),
        2500,
      );
    } catch (error) {
      this.logger.warn(
        `Valkey.get failed (${(error as any)?.message || error}). Using memory fallback.`,
      );
      return this.memGet(key);
    }
  }

  async set(key: string, value: string, ttl?: number): Promise<string | null> {
    this.ensureInitialized();
    this.memSet(key, value, ttl);
    if (!this.client) {
      return "OK";
    }
    try {
      return await this.executeWithTimeout(
        () =>
          this.executeWithRetry(async () => {
            if (typeof ttl === "number" && ttl > 0) {
              const result = await this.client!.set(key, value, {
                expiry: {
                  type: TimeUnit.Seconds,
                  count: ttl,
                },
              });
              return result as string | null;
            }
            const result = await this.client!.set(key, value);
            return result as string | null;
          }),
        2500,
      );
    } catch (error) {
      this.logger.warn(
        `Valkey.set failed (${(error as any)?.message || error}). Using memory fallback.`,
      );
      return "OK";
    }
  }

  async delete(key: string): Promise<number> {
    this.ensureInitialized();
    const memDeleted = this.memDelete(key);
    if (!this.client) {
      return memDeleted;
    }
    try {
      return await this.executeWithTimeout(
        () =>
          this.executeWithRetry(async () => {
            return await this.client!.del([key]);
          }),
        2500,
      );
    } catch (error) {
      this.logger.warn(
        `Valkey.delete failed (${(error as any)?.message || error}). Using memory fallback.`,
      );
      return memDeleted;
    }
  }

  async del(key: string): Promise<number> {
    return this.delete(key);
  }

  async incr(key: string): Promise<number> {
    this.ensureInitialized();
    if (!this.client) {
      return this.memIncr(key);
    }
    try {
      return await this.executeWithTimeout(
        () =>
          this.executeWithRetry(async () => {
            return await this.client!.incr(key);
          }),
        2500,
      );
    } catch (error) {
      this.logger.warn(
        `Valkey.incr failed (${(error as any)?.message || error}). Using memory fallback.`,
      );
      return this.memIncr(key);
    }
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    this.ensureInitialized();
    const memExpired = this.memExpire(key, seconds);
    if (!this.client) {
      return memExpired;
    }
    try {
      return await this.executeWithTimeout(
        () =>
          this.executeWithRetry(async () => {
            return await this.client!.expire(key, seconds);
          }),
        2500,
      );
    } catch (error) {
      this.logger.warn(
        `Valkey.expire failed (${(error as any)?.message || error}). Using memory fallback.`,
      );
      return memExpired;
    }
  }

  async ttl(key: string): Promise<number> {
    this.ensureInitialized();
    if (!this.client) {
      return this.memTtl(key);
    }
    try {
      return await this.executeWithTimeout(
        () =>
          this.executeWithRetry(async () => {
            return await this.client!.ttl(key);
          }),
        2500,
      );
    } catch (error) {
      this.logger.warn(
        `Valkey.ttl failed (${(error as any)?.message || error}). Using memory fallback.`,
      );
      return this.memTtl(key);
    }
  }

  private getScript(source: string): Script {
    let script = this.scriptCache.get(source);
    if (!script) {
      script = new Script(source);
      this.scriptCache.set(source, script);
    }
    return script;
  }

  /**
   * Runs a Lua script atomically on the server.
   */
  async eval(source: string, keys: string[], args: string[]): Promise<unknown> {
    this.ensureInitialized();
    if (!this.client) {
      throw new Error("Valkey client is not initialized");
    }
    return this.executeWithRetry(async () => {
      return await this.client!.invokeScript(this.getScript(source), {
        keys,
        args,
      });
    });
  }

  private static readonly COMPARE_AND_DELETE_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      redis.call('DEL', KEYS[1])
      return 1
    end
    return 0
  `;

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    this.ensureInitialized();
    if (!this.client) {
      return this.memCompareAndDelete(key, expected);
    }
    try {
      const result = await this.executeWithTimeout(
        () =>
          this.eval(
            ValkeyService.COMPARE_AND_DELETE_SCRIPT,
            [key],
            [expected],
          ),
        2500,
      );
      this.memDelete(key);
      return Number(result) === 1;
    } catch (error) {
      this.logger.warn(
        `Valkey.compareAndDelete failed (${(error as any)?.message || error}). Using memory fallback.`,
      );
      return this.memCompareAndDelete(key, expected);
    }
  }

  private static readonly RESERVE_SEND_SLOT_SCRIPT = `
    if redis.call('EXISTS', KEYS[1]) == 1 then return -1 end
    local n = tonumber(ARGV[2])
    for i = 1, n do
      local cur = tonumber(redis.call('GET', KEYS[i + 1]) or '0')
      local limit = tonumber(ARGV[1 + i * 2])
      if cur >= limit then return -(i + 1) end
    end
    for i = 1, n do
      local v = redis.call('INCR', KEYS[i + 1])
      if v == 1 then redis.call('EXPIRE', KEYS[i + 1], tonumber(ARGV[2 + i * 2])) end
    end
    redis.call('SET', KEYS[1], '1', 'EX', tonumber(ARGV[1]))
    return 0
  `;

  async reserveSendSlot(
    cooldownKey: string,
    cooldownTtlSeconds: number,
    counters: Array<{ key: string; limit: number; ttlSeconds: number }>,
  ): Promise<number> {
    this.ensureInitialized();
    if (!this.client) {
      return this.memReserveSendSlot(cooldownKey, cooldownTtlSeconds, counters);
    }
    try {
      const keys = [cooldownKey, ...counters.map((c) => c.key)];
      const args = [String(cooldownTtlSeconds), String(counters.length)];
      for (const counter of counters) {
        args.push(String(counter.limit), String(counter.ttlSeconds));
      }
      const result = await this.executeWithTimeout(
        () =>
          this.eval(
            ValkeyService.RESERVE_SEND_SLOT_SCRIPT,
            keys,
            args,
          ),
        2500,
      );
      return Number(result);
    } catch (error) {
      this.logger.warn(
        `Valkey.reserveSendSlot failed (${(error as any)?.message || error}). Using memory fallback.`,
      );
      return this.memReserveSendSlot(cooldownKey, cooldownTtlSeconds, counters);
    }
  }
}
