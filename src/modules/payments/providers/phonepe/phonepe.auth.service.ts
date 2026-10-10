import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PHONEPE_GRANT_TYPE,
  PHONEPE_PROD_AUTH_URL,
  PHONEPE_PROD_PG_BASE_URL,
  PHONEPE_REQUEST_TIMEOUT_MS,
  PHONEPE_SANDBOX_AUTH_URL,
  PHONEPE_SANDBOX_PG_BASE_URL,
  PHONEPE_TOKEN_REFRESH_MARGIN_SECONDS,
} from './phonepe.constants';
import { PhonePeAuthTokenResponse } from './phonepe.types';

/** Resolved PhonePe credentials. Never logged, never returned to a client. */
interface PhonePeCredentials {
  clientId: string;
  clientSecret: string;
  clientVersion: string;
}

/**
 * Owns PhonePe configuration and the OAuth access token.
 *
 * Every PhonePe API call is authenticated with an `O-Bearer` token obtained
 * from the identity-manager OAuth endpoint, so this class sits in front of
 * {@link PhonePeClient}. The token is cached in memory until shortly before
 * `expires_at`, and concurrent callers share one in-flight refresh so a burst
 * of payments does not produce a burst of token calls.
 *
 * Credential values are read from the environment on every use and are never
 * logged, persisted or included in an error message. A missing or malformed
 * credential surfaces as a generic ServiceUnavailableException, matching the
 * PayU client's behaviour, so a misconfiguration never leaks which secret is
 * absent to an API consumer.
 */
@Injectable()
export class PhonePeAuthService {
  private readonly logger = new Logger(PhonePeAuthService.name);

  /** Cached token and its absolute expiry, in epoch SECONDS. */
  private cachedToken: { value: string; expiresAtSeconds: number } | null =
    null;

  /** The single in-flight token request, shared by concurrent callers. */
  private inFlight: Promise<string> | null = null;

  constructor(private readonly configService: ConfigService) {}

  /**
   * True when PHONEPE_ENV names anything other than production. Defaults to
   * PRODUCTION: an unset or unrecognised value must never silently point live
   * traffic at the sandbox.
   */
  private isSandbox(): boolean {
    const env = (this.configService.get<string>('PHONEPE_ENV') ?? 'PRODUCTION')
      .trim()
      .toUpperCase();
    return env === 'SANDBOX' || env === 'UAT' || env === 'PREPROD';
  }

  /** Base URL of the Payment Gateway APIs for the configured environment. */
  getPgBaseUrl(): string {
    return this.isSandbox()
      ? PHONEPE_SANDBOX_PG_BASE_URL
      : PHONEPE_PROD_PG_BASE_URL;
  }

  private getAuthUrl(): string {
    return this.isSandbox() ? PHONEPE_SANDBOX_AUTH_URL : PHONEPE_PROD_AUTH_URL;
  }

  /**
   * Reads the merchant credentials.
   *
   * Reports only the NAMES of missing variables to the server log, never a
   * value, and throws a message with no configuration detail in it.
   */
  private getCredentials(): PhonePeCredentials {
    const clientId = this.configService.get<string>('PHONEPE_CLIENT_ID');
    const clientSecret = this.configService.get<string>(
      'PHONEPE_CLIENT_SECRET',
    );
    const clientVersion = this.configService.get<string>(
      'PHONEPE_CLIENT_VERSION',
    );

    const missing: string[] = [];
    if (!clientId?.trim()) missing.push('PHONEPE_CLIENT_ID');
    if (!clientSecret?.trim()) missing.push('PHONEPE_CLIENT_SECRET');
    if (!clientVersion?.trim()) missing.push('PHONEPE_CLIENT_VERSION');

    if (missing.length > 0) {
      this.logger.error(
        `PhonePe is not configured; missing: ${missing.join(', ')}`,
      );
      throw new ServiceUnavailableException(
        'Payment provider is not configured',
      );
    }

    return {
      clientId: clientId!.trim(),
      clientSecret: clientSecret!.trim(),
      clientVersion: clientVersion!.trim(),
    };
  }

  /**
   * Returns a usable access token, refreshing it when the cached one is within
   * {@link PHONEPE_TOKEN_REFRESH_MARGIN_SECONDS} of expiry.
   */
  async getAccessToken(): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (
      this.cachedToken &&
      this.cachedToken.expiresAtSeconds - PHONEPE_TOKEN_REFRESH_MARGIN_SECONDS >
        nowSeconds
    ) {
      return this.cachedToken.value;
    }

    // Collapse a concurrent burst into one token request.
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetchToken().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  /** Drops the cached token so the next call re-authenticates. */
  invalidateToken(): void {
    this.cachedToken = null;
  }

  /**
   * Calls the OAuth endpoint.
   *
   * The credentials go in a form-urlencoded body, which is what PhonePe
   * documents. Neither the body nor the response is ever logged: the response
   * contains a bearer token and the request contains the client secret.
   */
  private async fetchToken(): Promise<string> {
    const credentials = this.getCredentials();

    const body = new URLSearchParams();
    body.set('client_id', credentials.clientId);
    body.set('client_version', credentials.clientVersion);
    body.set('client_secret', credentials.clientSecret);
    body.set('grant_type', PHONEPE_GRANT_TYPE);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PHONEPE_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(this.getAuthUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Status code only. The error body can echo request parameters.
        this.logger.error(`PhonePe OAuth returned HTTP ${response.status}`);
        throw new ServiceUnavailableException(
          'Payment provider authentication failed',
        );
      }

      const parsed = (await response.json()) as PhonePeAuthTokenResponse;

      if (!parsed.access_token || typeof parsed.access_token !== 'string') {
        this.logger.error('PhonePe OAuth response contained no access token');
        throw new ServiceUnavailableException(
          'Payment provider authentication failed',
        );
      }

      // `expires_at` is epoch seconds. If PhonePe omits it, cache for a short
      // window only rather than treating the token as valid indefinitely.
      const expiresAtSeconds =
        typeof parsed.expires_at === 'number' && parsed.expires_at > 0
          ? parsed.expires_at
          : Math.floor(Date.now() / 1000) +
            PHONEPE_TOKEN_REFRESH_MARGIN_SECONDS * 2;

      this.cachedToken = { value: parsed.access_token, expiresAtSeconds };

      return parsed.access_token;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      // Network failure or the AbortController timeout. Logged by error class
      // name only so no credential material reaches the log.
      this.logger.error(
        `PhonePe OAuth call failed: ${
          error instanceof Error ? error.name : 'UnknownError'
        }`,
      );
      throw new ServiceUnavailableException(
        'Payment provider is currently unavailable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
