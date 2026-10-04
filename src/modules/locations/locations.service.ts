import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { GeoapifyService, ResolvedLocation } from "./geoapify/geoapify.service";
import { ValkeyService } from "../../valkey/valkey.service";

export interface StateResponse {
  id: string;
  name: string;
}

export interface CityResponse {
  id: string;
  name: string;
  stateId: string;
}

export interface AreaResponse {
  id: string;
  name: string;
  cityId: string;
  pincode: string | null;
}

export interface ServiceableLocationResponse {
  serviceable: true;
  state: {
    id: string;
    name: string;
  };
  city: {
    id: string;
    name: string;
  };
  area: {
    id: string;
    name: string;
  };
  pincode: string | null;
  latitude: number;
  longitude: number;
  formattedAddress: string | null;
}

export interface UnserviceableLocationResponse {
  serviceable: false;
  state: string | null;
  city: string | null;
  area: string | null;
  pincode: string | null;
  latitude: number;
  longitude: number;
  formattedAddress: string | null;
}

export type DetectLocationResponse =
  | ServiceableLocationResponse
  | UnserviceableLocationResponse;

// Rate limit: at most 5 detect requests per rolling 60s window per customer.
export const DETECT_RATE_LIMIT = 5;
export const DETECT_RATE_WINDOW_SECONDS = 60;
// Reverse-geocode results for a rounded coordinate are stable, so cache them
// for a day. Nothing sensitive and no provider secret is stored.
export const REVERSE_GEOCODE_CACHE_TTL_SECONDS = 24 * 60 * 60;

// Atomic fixed-window counter: INCR the key and, on first creation, arm its
// TTL. Running this as one script keeps the limit correct across backend
// instances and under concurrency.
const RATE_LIMIT_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  end
  return count
`;

/**
 * Customer-facing location logic:
 *  - "detect" reverse-geocodes GPS coordinates via Geoapify, protected by a
 *    per-customer Valkey rate limit and backed by a Valkey result cache.
 *  - the state/city/area readers expose only ACTIVE catalog entries and
 *    enforce the parent->child hierarchy so invalid combinations 404.
 */
@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoapify: GeoapifyService,
    private readonly valkey: ValkeyService,
  ) {}

  /**
   * Resolves a coordinate pair into a normalized location matched against
   * PuretyFarm's active database catalog. Order:
   *   1. per-customer rate limit (counts every call, even cache hits)
   *   2. Valkey cache lookup for raw Geoapify result
   *   3. Geoapify on miss, then cache raw Geoapify result
   *   4. Match against active DB catalog (State -> City -> Area)
   */
  async detectLocation(
    userId: string,
    latitude: number,
    longitude: number,
  ): Promise<DetectLocationResponse> {
    // 1. Rate limit first — a repeated call still consumes the budget even if
    //    it would have been served from cache.
    await this.enforceDetectRateLimit(userId);

    const cacheKey = this.reverseGeocodeCacheKey(latitude, longitude);

    // 2. Cache lookup (best-effort; infra failure falls through to Geoapify).
    let resolved = await this.readCachedLocation(cacheKey);
    if (!resolved) {
      // 3. Cache miss -> call the provider. A provider failure throws (503) and
      //    is deliberately NOT cached.
      resolved = await this.geoapify.reverseGeocode(latitude, longitude);
      await this.cacheLocation(cacheKey, resolved);
    }

    // 4. Match against active database catalog
    return this.matchCatalog(resolved);
  }

  private normalizeName(val: string | null | undefined): string {
    if (!val) return "";
    return val.trim().toLowerCase().replace(/[\s\-_]+/g, " ");
  }

  private async matchCatalog(
    geoResult: ResolvedLocation,
  ): Promise<DetectLocationResponse> {
    const {
      state: geoState,
      city: geoCity,
      area: geoArea,
      pincode: geoPincode,
      latitude,
      longitude,
      formattedAddress,
    } = geoResult;

    const unserviceableResponse: UnserviceableLocationResponse = {
      serviceable: false,
      state: geoState,
      city: geoCity,
      area: geoArea,
      pincode: geoPincode,
      latitude,
      longitude,
      formattedAddress,
    };

    if (!geoState || !geoCity || !geoArea) {
      return unserviceableResponse;
    }

    const normGeoState = this.normalizeName(geoState);
    const normGeoCity = this.normalizeName(geoCity);
    const normGeoArea = this.normalizeName(geoArea);

    // 1. Match active State in database
    const activeStates = await this.prisma.state.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });

    const matchedState = activeStates.find(
      (s) => this.normalizeName(s.name) === normGeoState,
    );
    if (!matchedState) {
      return unserviceableResponse;
    }

    // 2. Match active City under matchedState
    const activeCities = await this.prisma.city.findMany({
      where: { stateId: matchedState.id, isActive: true },
      select: { id: true, name: true },
    });

    const matchedCity = activeCities.find(
      (c) => this.normalizeName(c.name) === normGeoCity,
    );
    if (!matchedCity) {
      return unserviceableResponse;
    }

    // 3. Match active Area under matchedCity
    const activeAreas = await this.prisma.area.findMany({
      where: { cityId: matchedCity.id, isActive: true },
      select: { id: true, name: true, pincode: true },
    });

    const matchedArea = activeAreas.find(
      (a) => this.normalizeName(a.name) === normGeoArea,
    );
    if (!matchedArea) {
      return unserviceableResponse;
    }

    // 4. Supporting pincode check
    if (geoPincode && matchedArea.pincode) {
      const normGeoPincode = geoPincode.trim();
      const normAreaPincode = matchedArea.pincode.trim();
      if (normGeoPincode !== normAreaPincode) {
        return unserviceableResponse;
      }
    }

    const resolvedPincode =
      geoPincode?.trim() || matchedArea.pincode?.trim() || null;

    return {
      serviceable: true,
      state: { id: matchedState.id, name: matchedState.name },
      city: { id: matchedCity.id, name: matchedCity.name },
      area: { id: matchedArea.id, name: matchedArea.name },
      pincode: resolvedPincode,
      latitude,
      longitude,
      formattedAddress,
    };
  }

  /**
   * Enforces 5 requests / 60s / customer using an atomic Valkey counter keyed
   * on the authenticated user id. Throws 429 when exceeded. If Valkey itself is
   * unavailable the request is allowed through (fail-open) so a cache/infra
   * outage does not take the endpoint down.
   */
  private async enforceDetectRateLimit(userId: string): Promise<void> {
    const key = `locations:detect:ratelimit:${userId}`;
    let count: number;
    try {
      const raw = await this.valkey.eval(
        RATE_LIMIT_SCRIPT,
        [key],
        [String(DETECT_RATE_WINDOW_SECONDS)],
      );
      count = Number(raw);
    } catch {
      // Never surface internal Valkey errors; fail open.
      this.logger.warn(
        "Location detect rate-limit check failed; allowing request (fail-open)",
      );
      return;
    }

    if (count > DETECT_RATE_LIMIT) {
      throw new HttpException(
        "Too many location requests. Please try again in a minute.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Builds the cache key from coordinates rounded to 3 decimal places, so
   * nearby points share a cache entry. The provider API key is never part of
   * the key.
   */
  private reverseGeocodeCacheKey(latitude: number, longitude: number): string {
    const lat = latitude.toFixed(3);
    const lon = longitude.toFixed(3);
    return `locations:reverse-geocode:${lat}:${lon}`;
  }

  /** Reads a cached normalized location, swallowing infra/parse errors. */
  private async readCachedLocation(
    key: string,
  ): Promise<ResolvedLocation | null> {
    try {
      const raw = await this.valkey.get(key);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as ResolvedLocation;
    } catch {
      this.logger.warn("Location cache read failed; falling back to provider");
      return null;
    }
  }

  /** Stores the normalized location for 24h, swallowing infra errors. */
  private async cacheLocation(
    key: string,
    value: ResolvedLocation,
  ): Promise<void> {
    try {
      await this.valkey.set(
        key,
        JSON.stringify(value),
        REVERSE_GEOCODE_CACHE_TTL_SECONDS,
      );
    } catch {
      this.logger.warn("Location cache write failed; ignoring");
    }
  }

  /** Lists active states, alphabetically. */
  async getStates(): Promise<StateResponse[]> {
    const states = await this.prisma.state.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    return states;
  }

  /**
   * Lists active cities for an active state. 404s if the state does not exist
   * or is inactive, so a city can never be read under an invalid state.
   */
  async getCities(stateId: string): Promise<CityResponse[]> {
    const state = await this.prisma.state.findFirst({
      where: { id: stateId, isActive: true },
      select: { id: true },
    });
    if (!state) {
      throw new NotFoundException("State not found");
    }

    return this.prisma.city.findMany({
      where: { stateId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, stateId: true },
    });
  }

  /**
   * Lists active areas for an active city. 404s if the city does not exist or
   * is inactive, enforcing the city->area hierarchy.
   */
  async getAreas(cityId: string): Promise<AreaResponse[]> {
    const city = await this.prisma.city.findFirst({
      where: { id: cityId, isActive: true },
      select: { id: true },
    });
    if (!city) {
      throw new NotFoundException("City not found");
    }

    return this.prisma.area.findMany({
      where: { cityId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, cityId: true, pincode: true },
    });
  }
}
