// @nestjs/config ships ESM-only; mock it so the CommonJS test runner can load
// the service graph (GeoapifyService imports ConfigService).
jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import {
  LocationsService,
  DETECT_RATE_LIMIT,
  REVERSE_GEOCODE_CACHE_TTL_SECONDS,
} from './locations.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoapifyService } from './geoapify/geoapify.service';
import { ValkeyService } from '../../valkey/valkey.service';
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';

describe('LocationsService', () => {
  let service: LocationsService;

  const mockPrisma = {
    state: { findMany: jest.fn(), findFirst: jest.fn() },
    city: { findMany: jest.fn(), findFirst: jest.fn() },
    area: { findMany: jest.fn() },
  };

  const mockGeoapify = { reverseGeocode: jest.fn() };

  const mockValkey = {
    eval: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
  };

  const resolved = {
    latitude: 19.076,
    longitude: 72.878,
    state: 'Maharashtra',
    city: 'Mumbai',
    area: 'Bandra',
    pincode: '400050',
    country: 'India',
    formattedAddress: 'Bandra, Mumbai',
  };

  const expectedServiceable = {
    serviceable: true,
    state: { id: 'state-1', name: 'Maharashtra' },
    city: { id: 'city-1', name: 'Mumbai' },
    area: { id: 'area-1', name: 'Bandra' },
    pincode: '400050',
    latitude: 19.076,
    longitude: 72.878,
    formattedAddress: 'Bandra, Mumbai',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Defaults: first request in window, cache miss, provider resolves.
    mockValkey.eval.mockResolvedValue(1);
    mockValkey.get.mockResolvedValue(null);
    mockValkey.set.mockResolvedValue('OK');
    mockGeoapify.reverseGeocode.mockResolvedValue(resolved);

    // Default active catalog setup
    mockPrisma.state.findMany.mockResolvedValue([
      { id: 'state-1', name: 'Maharashtra' },
    ]);
    mockPrisma.city.findMany.mockResolvedValue([
      { id: 'city-1', name: 'Mumbai' },
    ]);
    mockPrisma.area.findMany.mockResolvedValue([
      { id: 'area-1', name: 'Bandra', pincode: '400050' },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: GeoapifyService, useValue: mockGeoapify },
        { provide: ValkeyService, useValue: mockValkey },
      ],
    }).compile();
    service = module.get<LocationsService>(LocationsService);
  });

  describe('detectLocation — rate limiting', () => {
    it('1/2. allows requests 1..5 in the window', async () => {
      for (let i = 1; i <= DETECT_RATE_LIMIT; i++) {
        mockValkey.eval.mockResolvedValueOnce(i);
        await expect(
          service.detectLocation('user-1', 19.076, 72.878),
        ).resolves.toEqual(expectedServiceable);
      }
    });

    it('3. rejects the 6th request with HTTP 429', async () => {
      mockValkey.eval.mockResolvedValueOnce(DETECT_RATE_LIMIT + 1);
      let status: number | undefined;
      try {
        await service.detectLocation('user-1', 19.076, 72.878);
      } catch (e) {
        status = (e as HttpException).getStatus();
      }
      expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
      // A throttled call must not reach the cache or the provider.
      expect(mockValkey.get).not.toHaveBeenCalled();
      expect(mockGeoapify.reverseGeocode).not.toHaveBeenCalled();
    });

    it('5. keys the rate limit on the JWT user id', async () => {
      await service.detectLocation('user-xyz', 19.076, 72.878);
      expect(mockValkey.eval).toHaveBeenCalledWith(
        expect.any(String),
        ['locations:detect:ratelimit:user-xyz'],
        ['60'],
      );
    });

    it('4. different customers use independent rate-limit keys', async () => {
      await service.detectLocation('user-A', 19.076, 72.878);
      await service.detectLocation('user-B', 19.076, 72.878);
      const keys = mockValkey.eval.mock.calls.map((c) => c[1][0]);
      expect(keys).toEqual([
        'locations:detect:ratelimit:user-A',
        'locations:detect:ratelimit:user-B',
      ]);
    });

    it('a cache hit still counts toward the rate limit', async () => {
      mockValkey.get.mockResolvedValueOnce(JSON.stringify(resolved));
      await service.detectLocation('user-1', 19.076, 72.878);
      expect(mockValkey.eval).toHaveBeenCalledTimes(1);
    });
  });

  describe('detectLocation — caching', () => {
    it('7. cache HIT returns cached result and matches against catalog without calling Geoapify', async () => {
      mockValkey.get.mockResolvedValueOnce(JSON.stringify(resolved));
      const result = await service.detectLocation('user-1', 19.076, 72.878);
      expect(result).toEqual(expectedServiceable);
      expect(mockGeoapify.reverseGeocode).not.toHaveBeenCalled();
      expect(mockValkey.set).not.toHaveBeenCalled();
    });

    it('8/9/10. cache MISS calls Geoapify and caches raw result for 24h', async () => {
      const result = await service.detectLocation('user-1', 19.076, 72.878);
      expect(mockGeoapify.reverseGeocode).toHaveBeenCalledWith(19.076, 72.878);
      expect(mockValkey.set).toHaveBeenCalledWith(
        'locations:reverse-geocode:19.076:72.878',
        JSON.stringify(resolved),
        REVERSE_GEOCODE_CACHE_TTL_SECONDS,
      );
      expect(REVERSE_GEOCODE_CACHE_TTL_SECONDS).toBe(86400);
      expect(result).toEqual(expectedServiceable);
    });

    it('11. does NOT cache a Geoapify failure', async () => {
      mockGeoapify.reverseGeocode.mockRejectedValueOnce(new Error('503'));
      await expect(
        service.detectLocation('user-1', 19.076, 72.878),
      ).rejects.toThrow();
      expect(mockValkey.set).not.toHaveBeenCalled();
    });

    it('14. nearby coordinates round to the same cache key', async () => {
      await service.detectLocation('user-1', 19.0761, 72.8777);
      await service.detectLocation('user-1', 19.0764, 72.8783);
      const keys = mockValkey.get.mock.calls.map((c) => c[0]);
      expect(keys[0]).toBe('locations:reverse-geocode:19.076:72.878');
      expect(keys[1]).toBe(keys[0]);
    });
  });

  describe('detectLocation — Catalog Matching & Serviceability', () => {
    it('GPS -> Geoapify successful and catalog match successful (case & space insensitive)', async () => {
      mockGeoapify.reverseGeocode.mockResolvedValueOnce({
        ...resolved,
        state: '  maharashtra ',
        city: 'mumbai',
        area: 'BANDRA ',
      });

      const result = await service.detectLocation('user-1', 19.076, 72.878);
      expect(result).toEqual(expectedServiceable);
    });

    it('GPS -> no catalog match when state is not in catalog', async () => {
      mockPrisma.state.findMany.mockResolvedValueOnce([]); // No active state matches

      const result = await service.detectLocation('user-1', 19.076, 72.878);
      expect(result).toEqual({
        serviceable: false,
        state: 'Maharashtra',
        city: 'Mumbai',
        area: 'Bandra',
        pincode: '400050',
        latitude: 19.076,
        longitude: 72.878,
        formattedAddress: 'Bandra, Mumbai',
      });
    });

    it('GPS -> no catalog match when city is not under the state', async () => {
      mockPrisma.city.findMany.mockResolvedValueOnce([]); // City not found under state

      const result = await service.detectLocation('user-1', 19.076, 72.878);
      expect(result).toEqual({
        serviceable: false,
        state: 'Maharashtra',
        city: 'Mumbai',
        area: 'Bandra',
        pincode: '400050',
        latitude: 19.076,
        longitude: 72.878,
        formattedAddress: 'Bandra, Mumbai',
      });
    });

    it('GPS -> no catalog match when area is not under the city', async () => {
      mockPrisma.area.findMany.mockResolvedValueOnce([]); // Area not found under city

      const result = await service.detectLocation('user-1', 19.076, 72.878);
      expect(result).toEqual({
        serviceable: false,
        state: 'Maharashtra',
        city: 'Mumbai',
        area: 'Bandra',
        pincode: '400050',
        latitude: 19.076,
        longitude: 72.878,
        formattedAddress: 'Bandra, Mumbai',
      });
    });

    it('returns unserviceable when Geoapify pincode conflicts with catalog area pincode', async () => {
      mockGeoapify.reverseGeocode.mockResolvedValueOnce({
        ...resolved,
        pincode: '999999', // Different pincode
      });

      const result = await service.detectLocation('user-1', 19.076, 72.878);
      expect(result).toEqual({
        serviceable: false,
        state: 'Maharashtra',
        city: 'Mumbai',
        area: 'Bandra',
        pincode: '999999',
        latitude: 19.076,
        longitude: 72.878,
        formattedAddress: 'Bandra, Mumbai',
      });
    });
  });

  describe('detectLocation — Valkey unavailable (graceful degradation)', () => {
    it('12a. rate-limit infra failure fails open and still serves the request', async () => {
      mockValkey.eval.mockRejectedValueOnce(
        new Error('VALKEY down: user=secret host=... password=hunter2'),
      );
      const result = await service.detectLocation('user-1', 19.076, 72.878);
      // Request succeeds; no internal error is surfaced to the caller.
      expect(result).toEqual(expectedServiceable);
    });

    it('12b. cache read failure falls back to Geoapify', async () => {
      mockValkey.get.mockRejectedValueOnce(new Error('VALKEY read error'));
      const result = await service.detectLocation('user-1', 19.076, 72.878);
      expect(mockGeoapify.reverseGeocode).toHaveBeenCalled();
      expect(result).toEqual(expectedServiceable);
    });

    it('cache write failure does not break the response', async () => {
      mockValkey.set.mockRejectedValueOnce(new Error('VALKEY write error'));
      const result = await service.detectLocation('user-1', 19.076, 72.878);
      expect(result).toEqual(expectedServiceable);
    });
  });

  describe('getStates', () => {
    it('16a. returns only active states', async () => {
      mockPrisma.state.findMany.mockResolvedValue([
        { id: 's1', name: 'Maharashtra' },
      ]);

      const result = await service.getStates();

      expect(result).toEqual([{ id: 's1', name: 'Maharashtra' }]);
      expect(mockPrisma.state.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });
  });

  describe('getCities', () => {
    it('13b. returns active cities for an active state', async () => {
      mockPrisma.state.findFirst.mockResolvedValue({ id: 's1' });
      mockPrisma.city.findMany.mockResolvedValue([
        { id: 'c1', name: 'Mumbai', stateId: 's1' },
      ]);

      const result = await service.getCities('s1');

      expect(result).toEqual([{ id: 'c1', name: 'Mumbai', stateId: 's1' }]);
      expect(mockPrisma.city.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { stateId: 's1', isActive: true } }),
      );
    });

    it('14c. throws NotFound for a missing/inactive state (invalid state)', async () => {
      mockPrisma.state.findFirst.mockResolvedValue(null);
      await expect(service.getCities('bad')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.city.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getAreas', () => {
    it('14d. returns active areas for an active city', async () => {
      mockPrisma.city.findFirst.mockResolvedValue({ id: 'c1' });
      mockPrisma.area.findMany.mockResolvedValue([
        { id: 'a1', name: 'Bandra', cityId: 'c1', pincode: '400050' },
      ]);

      const result = await service.getAreas('c1');

      expect(result).toEqual([
        { id: 'a1', name: 'Bandra', cityId: 'c1', pincode: '400050' },
      ]);
      expect(mockPrisma.area.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { cityId: 'c1', isActive: true } }),
      );
    });

    it('15b. throws NotFound for a missing/inactive city (invalid city)', async () => {
      mockPrisma.city.findFirst.mockResolvedValue(null);
      await expect(service.getAreas('bad')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.area.findMany).not.toHaveBeenCalled();
    });
  });
});
