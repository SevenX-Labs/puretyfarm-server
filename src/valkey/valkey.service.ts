import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GlideClient, TimeUnit } from '@valkey/valkey-glide';

@Injectable()
export class ValkeyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ValkeyService.name);
  private client: GlideClient | null = null;

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
        useTLS: isTls || true,
        requestTimeout: 5000,
        advancedConfiguration: {
          connectionTimeout: 5000,
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

  async set(
    key: string,
    value: string,
    ttl?: number,
  ): Promise<string | null> {
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
}
