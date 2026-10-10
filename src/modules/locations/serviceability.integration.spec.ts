// @nestjs/config ships ESM-only; mock it so the CommonJS test runner can load
// the service graph (GeoapifyService imports ConfigService).
jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { LocationsService } from './locations.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoapifyService } from './geoapify/geoapify.service';
import { ValkeyService } from '../../valkey/valkey.service';

/**
 * End-to-end-ish check that admin isActive edits flow straight into the
 * EXISTING customer matching logic (detectLocation -> matchCatalog), with NO
 * separate serviceability flag. The prisma mock is backed by a mutable catalog
 * and its findMany honours the `isActive: true` filter the customer path uses,
 * so flipping isActive on a row is exactly what an admin disable/enable does.
 */
describe('Serviceability integration (admin isActive -> customer matching)', () => {
  let service: LocationsService;

  // Mutable backing catalog. Admin enable/disable is modelled by flipping
  // isActive here; the customer readers below filter on it.
  const catalog = {
    states: [{ id: 'state-1', name: 'Maharashtra', isActive: true }],
    cities: [
      { id: 'city-1', name: 'Thane', stateId: 'state-1', isActive: true },
    ],
    areas: [
      {
        id: 'area-1',
        name: 'Diva',
        cityId: 'city-1',
        pincode: '400612',
        isActive: true,
      },
    ],
  };

  const mockPrisma = {
    state: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          catalog.states.filter((s) => (where?.isActive ? s.isActive : true)),
        ),
      ),
    },
    city: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          catalog.cities.filter(
            (c) =>
              c.stateId === where.stateId &&
              (where?.isActive ? c.isActive : true),
          ),
        ),
      ),
    },
    area: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          catalog.areas.filter(
            (a) =>
              a.cityId === where.cityId &&
              (where?.isActive ? a.isActive : true),
          ),
        ),
      ),
    },
  };

  const geoResult = {
    latitude: 19.21,
    longitude: 73.01,
    state: 'Maharashtra',
    city: 'Thane',
    area: 'Diva',
    pincode: '400612',
    country: 'India',
    formattedAddress: 'Diva, Thane',
  };

  const mockGeoapify = {
    reverseGeocode: jest.fn().mockResolvedValue(geoResult),
  };
  const mockValkey = {
    eval: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };

  const detect = () => service.detectLocation('user-1', 19.21, 73.01);

  beforeEach(async () => {
    // Reset the catalog to all-active between tests.
    catalog.states[0].isActive = true;
    catalog.cities[0].isActive = true;
    catalog.areas[0].isActive = true;
    catalog.areas[0].pincode = '400612';
    jest.clearAllMocks();
    mockValkey.eval.mockResolvedValue(1);
    mockValkey.get.mockResolvedValue(null);
    mockValkey.set.mockResolvedValue('OK');
    mockGeoapify.reverseGeocode.mockResolvedValue(geoResult);

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

  it('1. active State + City + Area + matching pincode -> serviceable true', async () => {
    const result = await detect();
    expect(result.serviceable).toBe(true);
  });

  it('2. disabled State -> serviceable false', async () => {
    catalog.states[0].isActive = false;
    const result = await detect();
    expect(result.serviceable).toBe(false);
  });

  it('3. disabled City -> serviceable false', async () => {
    catalog.cities[0].isActive = false;
    const result = await detect();
    expect(result.serviceable).toBe(false);
  });

  it('4. disabled Area -> serviceable false', async () => {
    catalog.areas[0].isActive = false;
    const result = await detect();
    expect(result.serviceable).toBe(false);
  });

  it('5. pincode mismatch -> serviceable false', async () => {
    catalog.areas[0].pincode = '999999';
    const result = await detect();
    expect(result.serviceable).toBe(false);
  });

  it('6. re-enabling the Area makes the location serviceable again', async () => {
    catalog.areas[0].isActive = false;
    expect((await detect()).serviceable).toBe(false);

    catalog.areas[0].isActive = true;
    expect((await detect()).serviceable).toBe(true);
  });
});
