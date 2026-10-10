import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoapifyService, ResolvedLocation } from './geoapify/geoapify.service';
import { ValkeyService } from '../../valkey/valkey.service';
import { CreateStateDto } from './dto/admin/create-state.dto';
import { UpdateStateDto } from './dto/admin/update-state.dto';
import { CreateCityDto } from './dto/admin/create-city.dto';
import { UpdateCityDto } from './dto/admin/update-city.dto';
import { CreateAreaDto } from './dto/admin/create-area.dto';
import { UpdateAreaDto } from './dto/admin/update-area.dto';

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
  ServiceableLocationResponse | UnserviceableLocationResponse;

// Admin-facing catalog shapes. Unlike the customer responses these expose the
// isActive flag and timestamps so admins can manage the full catalog, but they
// deliberately select only location fields (no unrelated DB columns).
export interface AdminStateResponse {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminCityResponse {
  id: string;
  name: string;
  stateId: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminAreaResponse {
  id: string;
  name: string;
  cityId: string;
  pincode: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Explicit column selections so admin responses never leak future, unrelated
// columns that might be added to these models.
const ADMIN_STATE_SELECT = {
  id: true,
  name: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ADMIN_CITY_SELECT = {
  id: true,
  name: true,
  stateId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ADMIN_AREA_SELECT = {
  id: true,
  name: true,
  cityId: true,
  pincode: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

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
    if (!val) return '';
    return val
      .trim()
      .toLowerCase()
      .replace(/[\s\-_]+/g, ' ');
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
        'Location detect rate-limit check failed; allowing request (fail-open)',
      );
      return;
    }

    if (count > DETECT_RATE_LIMIT) {
      throw new HttpException(
        'Too many location requests. Please try again in a minute.',
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
      this.logger.warn('Location cache read failed; falling back to provider');
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
      this.logger.warn('Location cache write failed; ignoring');
    }
  }

  /** Lists active states, alphabetically. */
  async getStates(): Promise<StateResponse[]> {
    const states = await this.prisma.state.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
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
      throw new NotFoundException('State not found');
    }

    return this.prisma.city.findMany({
      where: { stateId, isActive: true },
      orderBy: { name: 'asc' },
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
      throw new NotFoundException('City not found');
    }

    return this.prisma.area.findMany({
      where: { cityId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, cityId: true, pincode: true },
    });
  }

  // ==========================================================================
  // ADMIN CATALOG MANAGEMENT
  //
  // These methods mutate the SAME State/City/Area catalog the customer readers
  // and matchCatalog() above query. They add no new serviceability flag: the
  // existing isActive columns are the single source of truth, so toggling
  // isActive here immediately changes what customers can see and match.
  // Deletes never cascade into customer data — they refuse (409) when dependent
  // records exist.
  // ==========================================================================

  // ----- States -------------------------------------------------------------

  /** Creates a state. The DTO has already trimmed the name. */
  async createState(dto: CreateStateDto): Promise<AdminStateResponse> {
    try {
      return await this.prisma.state.create({
        data: { name: dto.name },
        select: ADMIN_STATE_SELECT,
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('A state with this name already exists');
      }
      throw error;
    }
  }

  /** Lists ALL states (active + inactive) for admin management. */
  async getAdminStates(): Promise<AdminStateResponse[]> {
    return this.prisma.state.findMany({
      orderBy: { name: 'asc' },
      select: ADMIN_STATE_SELECT,
    });
  }

  /** Renames and/or enables/disables a state. 404 if it does not exist. */
  async updateState(
    stateId: string,
    dto: UpdateStateDto,
  ): Promise<AdminStateResponse> {
    await this.getStateOr404(stateId);

    const data: Prisma.StateUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    try {
      return await this.prisma.state.update({
        where: { id: stateId },
        data,
        select: ADMIN_STATE_SELECT,
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('A state with this name already exists');
      }
      throw error;
    }
  }

  /**
   * Deletes a state ONLY when nothing depends on it. A state with cities, or
   * referenced by any customer address, cannot be hard-deleted (that would
   * either cascade into the catalog subtree or orphan saved addresses); the
   * caller is told to disable it instead.
   */
  async deleteState(stateId: string): Promise<{ id: string; deleted: true }> {
    await this.getStateOr404(stateId);

    const cityCount = await this.prisma.city.count({ where: { stateId } });
    if (cityCount > 0) {
      throw new ConflictException(
        'State has dependent cities and cannot be deleted. Disable it instead.',
      );
    }

    const addressCount = await this.prisma.customerAddress.count({
      where: { stateId },
    });
    if (addressCount > 0) {
      throw new ConflictException(
        'State is referenced by customer addresses and cannot be deleted. Disable it instead.',
      );
    }

    await this.prisma.state.delete({ where: { id: stateId } });
    return { id: stateId, deleted: true };
  }

  // ----- Cities -------------------------------------------------------------

  /**
   * Creates a city under an existing state. The parent state must be active —
   * a city cannot be introduced under a disabled state.
   */
  async createCity(dto: CreateCityDto): Promise<AdminCityResponse> {
    const state = await this.prisma.state.findUnique({
      where: { id: dto.stateId },
      select: { id: true, isActive: true },
    });
    if (!state) {
      throw new NotFoundException('State not found');
    }
    if (!state.isActive) {
      throw new ConflictException(
        'Cannot create a city under an inactive state',
      );
    }

    try {
      return await this.prisma.city.create({
        data: { name: dto.name, stateId: dto.stateId },
        select: ADMIN_CITY_SELECT,
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          'A city with this name already exists in this state',
        );
      }
      throw error;
    }
  }

  /**
   * Lists ALL cities (active + inactive) under a state for admin management.
   * 404 if the state does not exist.
   */
  async getAdminCities(stateId: string): Promise<AdminCityResponse[]> {
    await this.getStateOr404(stateId);

    return this.prisma.city.findMany({
      where: { stateId },
      orderBy: { name: 'asc' },
      select: ADMIN_CITY_SELECT,
    });
  }

  /** Renames and/or enables/disables a city. 404 if it does not exist. */
  async updateCity(
    cityId: string,
    dto: UpdateCityDto,
  ): Promise<AdminCityResponse> {
    await this.getCityOr404(cityId);

    const data: Prisma.CityUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    try {
      return await this.prisma.city.update({
        where: { id: cityId },
        data,
        select: ADMIN_CITY_SELECT,
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          'A city with this name already exists in this state',
        );
      }
      throw error;
    }
  }

  /**
   * Deletes a city ONLY when nothing depends on it. A city with areas, or
   * referenced by any customer address, cannot be hard-deleted.
   */
  async deleteCity(cityId: string): Promise<{ id: string; deleted: true }> {
    await this.getCityOr404(cityId);

    const areaCount = await this.prisma.area.count({ where: { cityId } });
    if (areaCount > 0) {
      throw new ConflictException(
        'City has dependent areas and cannot be deleted. Disable it instead.',
      );
    }

    const addressCount = await this.prisma.customerAddress.count({
      where: { cityId },
    });
    if (addressCount > 0) {
      throw new ConflictException(
        'City is referenced by customer addresses and cannot be deleted. Disable it instead.',
      );
    }

    await this.prisma.city.delete({ where: { id: cityId } });
    return { id: cityId, deleted: true };
  }

  // ----- Areas --------------------------------------------------------------

  /**
   * Creates an area under an existing city. The parent city must be active.
   */
  async createArea(dto: CreateAreaDto): Promise<AdminAreaResponse> {
    const city = await this.prisma.city.findUnique({
      where: { id: dto.cityId },
      select: { id: true, isActive: true },
    });
    if (!city) {
      throw new NotFoundException('City not found');
    }
    if (!city.isActive) {
      throw new ConflictException(
        'Cannot create an area under an inactive city',
      );
    }

    try {
      return await this.prisma.area.create({
        data: { name: dto.name, cityId: dto.cityId, pincode: dto.pincode },
        select: ADMIN_AREA_SELECT,
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          'An area with this name already exists in this city',
        );
      }
      throw error;
    }
  }

  /**
   * Lists ALL areas (active + inactive) under a city for admin management.
   * 404 if the city does not exist.
   */
  async getAdminAreas(cityId: string): Promise<AdminAreaResponse[]> {
    await this.getCityOr404(cityId);

    return this.prisma.area.findMany({
      where: { cityId },
      orderBy: { name: 'asc' },
      select: ADMIN_AREA_SELECT,
    });
  }

  /**
   * Renames, repincodes, and/or enables/disables an area. 404 if it does not
   * exist. Toggling isActive directly controls customer serviceability.
   */
  async updateArea(
    areaId: string,
    dto: UpdateAreaDto,
  ): Promise<AdminAreaResponse> {
    await this.getAreaOr404(areaId);

    const data: Prisma.AreaUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.pincode !== undefined) data.pincode = dto.pincode;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    try {
      return await this.prisma.area.update({
        where: { id: areaId },
        data,
        select: ADMIN_AREA_SELECT,
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          'An area with this name already exists in this city',
        );
      }
      throw error;
    }
  }

  /**
   * Deletes an area ONLY when no customer address references it. Customer data
   * is never cascade-deleted.
   */
  async deleteArea(areaId: string): Promise<{ id: string; deleted: true }> {
    await this.getAreaOr404(areaId);

    const addressCount = await this.prisma.customerAddress.count({
      where: { areaId },
    });
    if (addressCount > 0) {
      throw new ConflictException(
        'Area is referenced by customer addresses and cannot be deleted. Disable it instead.',
      );
    }

    await this.prisma.area.delete({ where: { id: areaId } });
    return { id: areaId, deleted: true };
  }

  // ----- Shared admin helpers ----------------------------------------------

  /** Loads a state or throws 404. */
  private async getStateOr404(stateId: string): Promise<{ id: string }> {
    const state = await this.prisma.state.findUnique({
      where: { id: stateId },
      select: { id: true },
    });
    if (!state) {
      throw new NotFoundException('State not found');
    }
    return state;
  }

  /** Loads a city or throws 404. */
  private async getCityOr404(cityId: string): Promise<{ id: string }> {
    const city = await this.prisma.city.findUnique({
      where: { id: cityId },
      select: { id: true },
    });
    if (!city) {
      throw new NotFoundException('City not found');
    }
    return city;
  }

  /** Loads an area or throws 404. */
  private async getAreaOr404(areaId: string): Promise<{ id: string }> {
    const area = await this.prisma.area.findUnique({
      where: { id: areaId },
      select: { id: true },
    });
    if (!area) {
      throw new NotFoundException('Area not found');
    }
    return area;
  }

  /** True when the error is a Prisma unique-constraint (P2002) violation. */
  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
