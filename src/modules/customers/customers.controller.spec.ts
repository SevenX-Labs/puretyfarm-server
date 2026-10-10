jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

jest.mock('@nestjs/jwt', () => ({
  JwtService: jest.fn().mockImplementation(() => ({
    verifyAsync: jest.fn(),
  })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

describe('CustomersController', () => {
  let controller: CustomersController;

  const mockCustomersService = {
    getCustomers: jest.fn(),
    getCustomerById: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CustomersController],
      providers: [
        {
          provide: CustomersService,
          useValue: mockCustomersService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CustomersController>(CustomersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('is protected by JwtAuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', CustomersController);
    expect(guards).toContain(JwtAuthGuard);
  });

  it('is restricted to ADMIN role', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, CustomersController);
    expect(roles).toEqual(['ADMIN']);
  });

  describe('getCustomers', () => {
    it('calls customersService.getCustomers with query dto', async () => {
      const query: QueryCustomersDto = { page: 1, limit: 20, search: 'sahil' };
      const expectedResult = {
        data: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      };
      mockCustomersService.getCustomers.mockResolvedValue(expectedResult);

      const result = await controller.getCustomers(query);

      expect(mockCustomersService.getCustomers).toHaveBeenCalledWith(query);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('getCustomerById', () => {
    it('calls customersService.getCustomerById with the customer ID', async () => {
      const customerId = 'cust-uuid-1';
      const expectedResult = {
        id: customerId,
        mobile: '+919876543210',
        email: 'user@example.com',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        profile: null,
        addresses: [],
        plans: [],
      };
      mockCustomersService.getCustomerById.mockResolvedValue(expectedResult);

      const result = await controller.getCustomerById(customerId);

      expect(mockCustomersService.getCustomerById).toHaveBeenCalledWith(
        customerId,
      );
      expect(result).toEqual(expectedResult);
    });
  });

  describe('QueryCustomersDto validation', () => {
    it('accepts valid query parameters and transforms numeric strings', async () => {
      const dto = plainToInstance(QueryCustomersDto, {
        page: '2',
        limit: '50',
        search: 'sahil',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.page).toBe(2);
      expect(dto.limit).toBe(50);
      expect(dto.search).toBe('sahil');
    });

    it('accepts empty/omitted parameters with defaults', async () => {
      const dto = plainToInstance(QueryCustomersDto, {});
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.page).toBe(1);
      expect(dto.limit).toBe(20);
    });

    it('rejects page < 1', async () => {
      const dto = plainToInstance(QueryCustomersDto, { page: '0' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'page')).toBe(true);
    });

    it('rejects limit < 1', async () => {
      const dto = plainToInstance(QueryCustomersDto, { limit: '0' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'limit')).toBe(true);
    });

    it('rejects limit > 100', async () => {
      const dto = plainToInstance(QueryCustomersDto, { limit: '101' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'limit')).toBe(true);
    });
  });
});
