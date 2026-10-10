// @nestjs/config and @nestjs/jwt ship ESM-only; mock them so the CommonJS test
// runner can load the JwtAuthGuard imported by the controller.
jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock('@nestjs/jwt', () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { AddressController } from './address.controller';
import { AddressService } from './address.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateAddressDto } from './dto/customer/create-address.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

describe('AddressController', () => {
  let controller: AddressController;

  const mockService = {
    createAddress: jest.fn().mockResolvedValue({ id: 'addr-1' }),
    getAddresses: jest.fn().mockResolvedValue([{ id: 'addr-1' }]),
    getAddress: jest.fn().mockResolvedValue({ id: 'addr-1' }),
    updateAddress: jest.fn().mockResolvedValue({ id: 'addr-1' }),
    deleteAddress: jest.fn().mockResolvedValue(undefined),
  };

  const jwtUser = {
    sub: 'user-1',
    role: 'CUSTOMER',
    sessionId: 'session-1',
    type: 'access' as const,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AddressController],
      providers: [{ provide: AddressService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AddressController>(AddressController);
  });

  it('is protected by JwtAuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', AddressController);
    expect(guards).toContain(JwtAuthGuard);
  });

  describe('endpoints always use JWT.sub as the identity', () => {
    const dto = { fullName: 'Sahil' } as CreateAddressDto;

    it('18. create uses user.sub', async () => {
      await controller.create(jwtUser, dto);
      expect(mockService.createAddress).toHaveBeenCalledWith('user-1', dto);
    });

    it('20. findAll uses user.sub', async () => {
      await controller.findAll(jwtUser);
      expect(mockService.getAddresses).toHaveBeenCalledWith('user-1');
    });

    it('22. findOne uses user.sub and the id', async () => {
      await controller.findOne(jwtUser, 'addr-1');
      expect(mockService.getAddress).toHaveBeenCalledWith('user-1', 'addr-1');
    });

    it('24. update uses user.sub and the id', async () => {
      await controller.update(jwtUser, 'addr-1', { landmark: 'x' });
      expect(mockService.updateAddress).toHaveBeenCalledWith(
        'user-1',
        'addr-1',
        { landmark: 'x' },
      );
    });

    it('26. remove uses user.sub and the id', async () => {
      await controller.remove(jwtUser, 'addr-1');
      expect(mockService.deleteAddress).toHaveBeenCalledWith(
        'user-1',
        'addr-1',
      );
    });
  });

  describe('28. CreateAddressDto validation', () => {
    const validObj = {
      fullName: 'Sahil Hode',
      mobile: '+919876543210',
      houseNumber: '101',
      stateId: '11111111-1111-4111-8111-111111111111',
      cityId: '22222222-2222-4222-8222-222222222222',
      areaId: '33333333-3333-4333-8333-333333333333',
    };

    it('accepts a valid payload', async () => {
      const dto = plainToInstance(CreateAddressDto, validObj);
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('rejects a non-UUID stateId', async () => {
      const dto = plainToInstance(CreateAddressDto, {
        ...validObj,
        stateId: 'not-a-uuid',
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'stateId')).toBe(true);
    });

    it('rejects a missing required fullName', async () => {
      const { fullName, ...rest } = validObj;
      const dto = plainToInstance(CreateAddressDto, rest);
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'fullName')).toBe(true);
    });

    it('rejects an out-of-range latitude', async () => {
      const dto = plainToInstance(CreateAddressDto, {
        ...validObj,
        latitude: 200,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'latitude')).toBe(true);
    });

    it('rejects a malformed pincode', async () => {
      const dto = plainToInstance(CreateAddressDto, {
        ...validObj,
        pincode: 'abc',
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'pincode')).toBe(true);
    });
  });
});
