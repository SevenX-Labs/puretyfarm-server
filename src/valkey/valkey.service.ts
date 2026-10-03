import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GlideClient, TimeUnit, Script } from '@valkey/valkey-glide';

@Injectable()
export class ValkeyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ValkeyService.name);
  private client: GlideClient | null = null;
  // Compiled Lua scripts are cached by source so we do not recreate them per call.
  private readonly scriptCache = new Map<string, Script>();

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const rawValkeyUrl =
      this.configService.get<string>('VALKEY_URL') || process.env.VALKEY_URL;

    if (!rawValkeyUrl) {
      const errorMsg =
        'VALKEY_URL is not defined in configuration or environment variables';
      this.logger.error(`Valkey connection failed: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    let password = '';
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
      const isTls = parsedUrl.protocol === 'rediss:';
      const hostname = parsedUrl.hostname;
      const port = parsedUrl.port ? Number(parsedUrl.port) : 6379;
      const username = parsedUrl.username
        ? decodeURIComponent(parsedUrl.username)
        : 'default';
      password = parsedUrl.password
        ? decodeURIComponent(parsedUrl.password)
        : '';

      this.logger.log(
        `Connecting to Valkey at ${hostname}:${port} (TLS: ${isTls ? 'enabled' : 'disabled'})...`,
      );

      this.client = await GlideClient.createClient({
        addresses: [{ host: hostname, port }],
        credentials: password
          ? {
              username,
              password,
            }
          : undefined,
        useTLS: isTls,
        requestTimeout: 10000,
        advancedConfiguration: {
          connectionTimeout: 10000,
        },
      });

      // Verify connection with a lightweight PING
      const pingResult = await this.client.ping();
      this.logger.log(`Valkey connected successfully (Ping: ${pingResult})`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const sanitized = password
        ? errorMessage.split(password).join('******')
        : errorMessage;
      this.logger.error(`Valkey connection failed: ${sanitized}`);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        this.client.close();
        this.logger.log('Valkey connection closed successfully.');
      } catch (error) {
        this.logger.error('Error closing Valkey connection', error);
      } finally {
        this.client = null;
      }
    }
  }

  getClient(): GlideClient | null {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) {
      throw new Error('Valkey client is not initialized');
    }
    const result = await this.client.get(key);
    return result as string | null;
  }

  async set(key: string, value: string, ttl?: number): Promise<string | null> {
    if (!this.client) {
      throw new Error('Valkey client is not initialized');
    }
    if (typeof ttl === 'number' && ttl > 0) {
      const result = await this.client.set(key, value, {
        expiry: {
          type: TimeUnit.Seconds,
          count: ttl,
        },
      });
      return result as string | null;
    }
    const result = await this.client.set(key, value);
    return result as string | null;
  }

  async delete(key: string): Promise<number> {
    if (!this.client) {
      throw new Error('Valkey client is not initialized');
    }
    return await this.client.del([key]);
  }

  async del(key: string): Promise<number> {
    return this.delete(key);
  }

  async incr(key: string): Promise<number> {
    if (!this.client) {
      throw new Error('Valkey client is not initialized');
    }
    return await this.client.incr(key);
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    if (!this.client) {
      throw new Error('Valkey client is not initialized');
    }
    return await this.client.expire(key, seconds);
  }

  async ttl(key: string): Promise<number> {
    if (!this.client) {
      throw new Error('Valkey client is not initialized');
    }
    return await this.client.ttl(key);
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
    if (!this.client) {
      throw new Error('Valkey client is not initialized');
    }
    return await this.client.invokeScript(this.getScript(source), {
      keys,
      args,
    });
  }

  // Atomically deletes `key` only if its current value equals `expected`.
  // Returns true when this call performed the delete (i.e. it "won" the race).
  private static readonly COMPARE_AND_DELETE_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      redis.call('DEL', KEYS[1])
      return 1
    end
    return 0
  `;

  /**
   * Compare-and-delete: deletes the key only if its value still matches
   * `expected`. Used to make a credential single-use even when two requests
   * read the same value concurrently — only one delete succeeds.
   */
  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    const result = await this.eval(
      ValkeyService.COMPARE_AND_DELETE_SCRIPT,
      [key],
      [expected],
    );
    return Number(result) === 1;
  }

  // Atomic send-slot reservation: cooldown check + N windowed counters, all
  // checked and incremented in a single server round-trip so concurrent
  // requests cannot bypass the limits.
  //   KEYS[1]            cooldown key
  //   KEYS[2..]          counter keys
  //   ARGV[1]            cooldown TTL (seconds)
  //   ARGV[2]            number of counters (n)
  //   ARGV[1+i*2]        limit for counter i
  //   ARGV[2+i*2]        TTL for counter i (applied only when first created)
  // Returns 0 on success, -1 if in cooldown, -(i+1) if counter i is exhausted.
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

  /**
   * Atomically reserves one "send" slot: verifies there is no active cooldown
   * and that no windowed counter has reached its limit, then increments every
   * counter (setting each counter's TTL on first creation) and arms the
   * cooldown. All of this happens in one atomic script.
   *
   * @returns 0 on success; -1 if still in cooldown; -(index+2) if the counter
   *          at `counters[index]` is already at its limit.
   */
  async reserveSendSlot(
    cooldownKey: string,
    cooldownTtlSeconds: number,
    counters: Array<{ key: string; limit: number; ttlSeconds: number }>,
  ): Promise<number> {
    const keys = [cooldownKey, ...counters.map((c) => c.key)];
    const args = [String(cooldownTtlSeconds), String(counters.length)];
    for (const counter of counters) {
      args.push(String(counter.limit), String(counter.ttlSeconds));
    }
    const result = await this.eval(
      ValkeyService.RESERVE_SEND_SLOT_SCRIPT,
      keys,
      args,
    );
    return Number(result);
  }
}
