// @nestjs/config and @nestjs/jwt ship ESM-only; mock them so the CommonJS test
// runner can load the JwtAuthGuard imported by the controller.
jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock('@nestjs/jwt', () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

describe('LocationsController', () => {
  let controller: LocationsController;

  const mockService = {
    detectLocation: jest.fn().mockResolvedValue({ state: 'Maharashtra' }),
    getStates: jest.fn().mockResolvedValue([{ id: 's1', name: 'Maharashtra' }]),
    getCities: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Mumbai' }]),
    getAreas: jest.fn().mockResolvedValue([{ id: 'a1', name: 'Bandra' }]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LocationsController],
      providers: [{ provide: LocationsService, useValue: mockService }],
    })
      // Auth is asserted in the guard's own suite; stub it here.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<LocationsController>(LocationsController);
  });

  it('9. is protected by JwtAuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', LocationsController);
    expect(guards).toContain(JwtAuthGuard);
  });

  const jwtUser = {
    sub: 'user-1',
    role: 'CUSTOMER',
    sessionId: 'session-1',
    type: 'access' as const,
  };

  it('1/5/6. detect uses JWT.sub (never a body userId) for identity', async () => {
    await controller.detect(jwtUser, {
      latitude: 19.076,
      longitude: 72.8777,
    });
    expect(mockService.detectLocation).toHaveBeenCalledWith(
      'user-1',
      19.076,
      72.8777,
    );
  });

  it('11. getStates returns the service result', async () => {
    const res = await controller.getStates();
    expect(res).toEqual([{ id: 's1', name: 'Maharashtra' }]);
  });

  it('12. getCities passes the stateId through', async () => {
    await controller.getCities('s1');
    expect(mockService.getCities).toHaveBeenCalledWith('s1');
  });

  it('13. getAreas passes the cityId through', async () => {
    await controller.getAreas('c1');
    expect(mockService.getAreas).toHaveBeenCalledWith('c1');
  });
});
