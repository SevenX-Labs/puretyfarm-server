import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Provider-agnostic result of resolving a coordinate pair into a human
 * location. Every field except the echoed coordinates is optional because a
 * reverse-geocode lookup does not always resolve every level of the hierarchy.
 */
export interface ResolvedLocation {
  latitude: number;
  longitude: number;
  state: string | null;
  city: string | null;
  area: string | null;
  pincode: string | null;
  country: string | null;
  formattedAddress: string | null;
}

/** Shape of a single entry in Geoapify's `format=json` response. */
interface GeoapifyResult {
  state?: string;
  city?: string;
  county?: string;
  town?: string;
  village?: string;
  suburb?: string;
  district?: string;
  neighbourhood?: string;
  quarter?: string;
  postcode?: string;
  country?: string;
  formatted?: string;
}

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Isolates all Geoapify-specific HTTP and parsing logic behind a normalized
 * {@link ResolvedLocation} result so the provider can be swapped without
 * touching callers. The API key is read from configuration and is never
 * logged or returned to clients.
 */
@Injectable()
export class GeoapifyService {
  private readonly logger = new Logger(GeoapifyService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Reverse-geocodes a coordinate pair into a normalized location. Throws
   * ServiceUnavailableException on configuration, network, timeout or upstream
   * errors so the controller surfaces a 503 rather than leaking provider
   * details.
   */
  async reverseGeocode(
    latitude: number,
    longitude: number,
  ): Promise<ResolvedLocation> {
    const apiKey = this.configService.get<string>('GEOAPIFY_API_KEY');
    const baseUrl = this.configService.get<string>('GEOAPIFY_BASE_URL');

    if (!apiKey || !baseUrl) {
      // Startup validation guards this; treat as a server misconfiguration
      // rather than silently returning empty data.
      this.logger.error('Geoapify is not configured');
      throw new ServiceUnavailableException(
        'Location service is not configured',
      );
    }

    const url = new URL('/v1/geocode/reverse', baseUrl);
    url.searchParams.set('lat', String(latitude));
    url.searchParams.set('lon', String(longitude));
    url.searchParams.set('format', 'json');
    url.searchParams.set('apiKey', apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
    } catch (error) {
      // Network failure or timeout (abort). Never include the URL (it carries
      // the API key) in the log.
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? 'timed out'
          : 'network error';
      this.logger.warn(`Geoapify reverse geocode ${reason}`);
      throw new ServiceUnavailableException('Location service is unavailable');
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      this.logger.warn(
        `Geoapify reverse geocode returned status ${response.status}`,
      );
      throw new ServiceUnavailableException('Location service is unavailable');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      this.logger.warn('Geoapify reverse geocode returned invalid JSON');
      throw new ServiceUnavailableException('Location service is unavailable');
    }

    const result = this.firstResult(body);

    return {
      latitude,
      longitude,
      state: this.pick(result?.state),
      city: this.pick(
        result?.city,
        result?.town,
        result?.village,
        result?.county,
      ),
      area: this.pick(
        result?.suburb,
        result?.neighbourhood,
        result?.district,
        result?.quarter,
      ),
      pincode: this.pick(result?.postcode),
      country: this.pick(result?.country),
      formattedAddress: this.pick(result?.formatted),
    };
  }

  /** Safely extracts the first result from Geoapify's `format=json` payload. */
  private firstResult(body: unknown): GeoapifyResult | undefined {
    if (
      body &&
      typeof body === 'object' &&
      Array.isArray((body as { results?: unknown[] }).results)
    ) {
      const results = (body as { results: unknown[] }).results;
      const first = results[0];
      if (first && typeof first === 'object') {
        return first;
      }
    }
    return undefined;
  }

  /** Returns the first non-empty trimmed string, or null. */
  private pick(...values: Array<string | undefined>): string | null {
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  }
}
