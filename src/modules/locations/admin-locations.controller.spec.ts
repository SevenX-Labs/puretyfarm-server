// @nestjs/config and @nestjs/jwt ship ESM-only; mock them so the CommonJS test
// runner can load the JwtAuthGuard imported by the controller.
jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock('@nestjs/jwt', () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { AdminLocationsController } from './admin-locations.controller';
import { LocationsService } from './locations.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

describe('AdminLocationsController', () => {
  let controller: AdminLocationsController;

  const mockService = {
    createState: jest.fn().mockResolvedValue({ id: 's1' }),
    getAdminStates: jest.fn().mockResolvedValue([{ id: 's1' }]),
    updateState: jest.fn().mockResolvedValue({ id: 's1' }),
    deleteState: jest.fn().mockResolvedValue({ id: 's1', deleted: true }),
    createCity: jest.fn().mockResolvedValue({ id: 'c1' }),
    getAdminCities: jest.fn().mockResolvedValue([{ id: 'c1' }]),
    updateCity: jest.fn().mockResolvedValue({ id: 'c1' }),
    deleteCity: jest.fn().mockResolvedValue({ id: 'c1', deleted: true }),
    createArea: jest.fn().mockResolvedValue({ id: 'a1' }),
    getAdminAreas: jest.fn().mockResolvedValue([{ id: 'a1' }]),
    updateArea: jest.fn().mockResolvedValue({ id: 'a1' }),
    deleteArea: jest.fn().mockResolvedValue({ id: 'a1', deleted: true }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminLocationsController],
      providers: [{ provide: LocationsService, useValue: mockService }],
    })
      // The guard's role logic is asserted in its own suite; stub it here.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AdminLocationsController>(AdminLocationsController);
  });

  // ----- Auth wiring --------------------------------------------------------

  it('is protected by JwtAuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', AdminLocationsController);
    expect(guards).toContain(JwtAuthGuard);
  });

  it('requires the ADMIN role (so a customer token is rejected with 403)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminLocationsController);
    expect(roles).toEqual(['ADMIN']);
  });

  // ----- Delegation ---------------------------------------------------------

  it('createState delegates to the service', async () => {
    await controller.createState({ name: 'Maharashtra' });
    expect(mockService.createState).toHaveBeenCalledWith({
      name: 'Maharashtra',
    });
  });

  it('getStates returns admin (active + inactive) list', async () => {
    await controller.getStates();
    expect(mockService.getAdminStates).toHaveBeenCalled();
  });

  it('updateState delegates with id + body', async () => {
    await controller.updateState('s1', { isActive: false });
    expect(mockService.updateState).toHaveBeenCalledWith('s1', {
      isActive: false,
    });
  });

  it('deleteState delegates with id', async () => {
    await controller.deleteState('s1');
    expect(mockService.deleteState).toHaveBeenCalledWith('s1');
  });

  it('createCity delegates to the service', async () => {
    await controller.createCity({ stateId: 's1', name: 'Thane' });
    expect(mockService.createCity).toHaveBeenCalledWith({
      stateId: 's1',
      name: 'Thane',
    });
  });

  it('getCities delegates with stateId', async () => {
    await controller.getCities('s1');
    expect(mockService.getAdminCities).toHaveBeenCalledWith('s1');
  });

  it('updateCity delegates with id + body', async () => {
    await controller.updateCity('c1', { name: 'Kalyan' });
    expect(mockService.updateCity).toHaveBeenCalledWith('c1', {
      name: 'Kalyan',
    });
  });

  it('deleteCity delegates with id', async () => {
    await controller.deleteCity('c1');
    expect(mockService.deleteCity).toHaveBeenCalledWith('c1');
  });

  it('createArea delegates to the service', async () => {
    await controller.createArea({
      cityId: 'c1',
      name: 'Diva',
      pincode: '400612',
    });
    expect(mockService.createArea).toHaveBeenCalledWith({
      cityId: 'c1',
      name: 'Diva',
      pincode: '400612',
    });
  });

  it('getAreas delegates with cityId', async () => {
    await controller.getAreas('c1');
    expect(mockService.getAdminAreas).toHaveBeenCalledWith('c1');
  });

  it('updateArea delegates with id + body', async () => {
    await controller.updateArea('a1', { pincode: '400700' });
    expect(mockService.updateArea).toHaveBeenCalledWith('a1', {
      pincode: '400700',
    });
  });

  it('deleteArea delegates with id', async () => {
    await controller.deleteArea('a1');
    expect(mockService.deleteArea).toHaveBeenCalledWith('a1');
  });
});
