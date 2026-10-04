jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { CustomersService } from './customers.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProfileStorageService } from '../profile/storage/profile-storage.service';
import { SIGNED_URL_EXPIRY_SECONDS } from '../profile/profile.service';
import { Gender, PlanSelectionStatus, PlanType, Role } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';

describe('CustomersService', () => {
  let service: CustomersService;

  const mockPrismaService = {
    user: {
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
  };

  const mockStorageService = {
    createSignedUrl: jest.fn(),
  };

  const mockDate = new Date('2026-01-01T10:00:00.000Z');
  const mockDob = new Date('1995-05-15T00:00:00.000Z');

  const baseCustomerUser = {
    id: 'cust-uuid-1',
    mobile: '+919876543210',
    email: 'cust1@example.com',
    emailVerified: true,
    role: Role.CUSTOMER,
    createdAt: mockDate,
    updatedAt: mockDate,
    customerProfile: {
      id: 'profile-uuid-1',
      userId: 'cust-uuid-1',
      firstName: 'Sahil',
      lastName: 'Hode',
      gender: Gender.MALE,
      dateOfBirth: mockDob,
      profileImagePath: 'avatars/customers/cust-uuid-1-123.jpg',
      createdAt: mockDate,
      updatedAt: mockDate,
    },
    _count: {
      addresses: 2,
      planSelections: 1,
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockStorageService.createSignedUrl.mockImplementation(
      (path: string, expiry: number) =>
        Promise.resolve(`https://signed.example/${path}?expires=${expiry}`),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProfileStorageService, useValue: mockStorageService },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('1. Admin can list customers', () => {
    it('returns customer list with data and pagination metadata', async () => {
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      const result = await service.getCustomers({ page: 1, limit: 20 });

      expect(mockPrismaService.user.count).toHaveBeenCalledWith({
        where: { role: Role.CUSTOMER },
      });
      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith({
        where: { role: Role.CUSTOMER },
        skip: 0,
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: {
          customerProfile: true,
          _count: {
            select: {
              addresses: true,
              planSelections: true,
            },
          },
        },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('cust-uuid-1');
      expect(result.data[0].mobile).toBe('+919876543210');
      expect(result.data[0].email).toBe('cust1@example.com');
      expect(result.data[0].emailVerified).toBe(true);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });
  });

  describe('2. Only role=CUSTOMER is returned', () => {
    it('strictly enforces role: CUSTOMER at the root of the query where clause', async () => {
      mockPrismaService.user.count.mockResolvedValue(0);
      mockPrismaService.user.findMany.mockResolvedValue([]);

      await service.getCustomers({ page: 1, limit: 20, search: 'test' });

      expect(mockPrismaService.user.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: Role.CUSTOMER }),
        }),
      );
      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: Role.CUSTOMER }),
        }),
      );
    });
  });

  describe('3. Admin can fetch customer by ID', () => {
    it('returns full customer details with addresses and plans', async () => {
      const fullCustomer = {
        ...baseCustomerUser,
        addresses: [
          {
            id: 'addr-uuid-1',
            userId: 'cust-uuid-1',
            fullName: 'Sahil Hode',
            mobile: '+919876543210',
            houseNumber: 'Flat 101',
            buildingName: 'Tower A',
            streetName: 'Main St',
            landmark: 'Near Park',
            stateId: 'state-1',
            cityId: 'city-1',
            areaId: 'area-1',
            state: 'Maharashtra',
            city: 'Pune',
            area: 'Baner',
            pincode: '411045',
            latitude: 18.55,
            longitude: 73.78,
            createdAt: mockDate,
            updatedAt: mockDate,
          },
        ],
        planSelections: [
          {
            id: 'plan-uuid-1',
            userId: 'cust-uuid-1',
            quoteId: 'quote-uuid-1',
            planType: PlanType.MONTHLY,
            status: PlanSelectionStatus.ACTIVE,
            frequency: 'DAILY',
            quantity: 2,
            quantityMode: 'FIXED',
            quantityA: null,
            quantityB: null,
            startDate: mockDate,
            endDate: mockDate,
            createdAt: mockDate,
            updatedAt: mockDate,
          },
        ],
      };

      mockPrismaService.user.findFirst.mockResolvedValue(fullCustomer);

      const result = await service.getCustomerById('cust-uuid-1');

      expect(mockPrismaService.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'cust-uuid-1', role: Role.CUSTOMER },
        include: {
          customerProfile: true,
          addresses: { orderBy: { createdAt: 'desc' } },
          planSelections: { orderBy: { createdAt: 'desc' } },
        },
      });

      expect(result.id).toBe('cust-uuid-1');
      expect(result.profile?.firstName).toBe('Sahil');
      expect(result.profile?.lastName).toBe('Hode');
      expect(result.addresses).toHaveLength(1);
      expect(result.addresses[0].id).toBe('addr-uuid-1');
      expect(result.plans).toHaveLength(1);
      expect(result.plans[0].id).toBe('plan-uuid-1');
      expect(result.plans[0].planType).toBe(PlanType.MONTHLY);
    });
  });

  describe('4. Non-existing customer returns NotFoundException', () => {
    it('throws NotFoundException when customer is not found', async () => {
      mockPrismaService.user.findFirst.mockResolvedValue(null);

      await expect(service.getCustomerById('non-existent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('5. Admin cannot fetch an Admin record as customer', () => {
    it('returns NotFoundException because where specifies role=CUSTOMER', async () => {
      // Prisma findFirst returns null because an Admin user does not match role: Role.CUSTOMER
      mockPrismaService.user.findFirst.mockResolvedValue(null);

      await expect(service.getCustomerById('admin-user-id')).rejects.toThrow(
        NotFoundException,
      );

      expect(mockPrismaService.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'admin-user-id', role: Role.CUSTOMER },
        }),
      );
    });
  });

  describe('6. Customer without profile still appears', () => {
    it('returns null profile in customer list when profile has not been created', async () => {
      const userWithoutProfile = {
        ...baseCustomerUser,
        customerProfile: null,
      };

      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([userWithoutProfile]);

      const result = await service.getCustomers({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('cust-uuid-1');
      expect(result.data[0].profile).toBeNull();
    });

    it('returns null profile in customer detail when profile has not been created', async () => {
      const userWithoutProfile = {
        ...baseCustomerUser,
        customerProfile: null,
        addresses: [],
        planSelections: [],
      };

      mockPrismaService.user.findFirst.mockResolvedValue(userWithoutProfile);

      const result = await service.getCustomerById('cust-uuid-1');

      expect(result.id).toBe('cust-uuid-1');
      expect(result.profile).toBeNull();
      expect(result.addresses).toEqual([]);
      expect(result.plans).toEqual([]);
    });
  });

  describe('7. Customer with profile returns profile data', () => {
    it('correctly maps profile fields in list response', async () => {
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      const result = await service.getCustomers({ page: 1, limit: 20 });

      expect(result.data[0].profile).toEqual({
        id: 'profile-uuid-1',
        firstName: 'Sahil',
        lastName: 'Hode',
        gender: Gender.MALE,
        dateOfBirth: '1995-05-15',
        profileImageUrl: `https://signed.example/avatars/customers/cust-uuid-1-123.jpg?expires=${SIGNED_URL_EXPIRY_SECONDS}`,
      });
    });

    it('correctly maps profile fields in detail response', async () => {
      mockPrismaService.user.findFirst.mockResolvedValue({
        ...baseCustomerUser,
        addresses: [],
        planSelections: [],
      });

      const result = await service.getCustomerById('cust-uuid-1');

      expect(result.profile).toEqual({
        id: 'profile-uuid-1',
        firstName: 'Sahil',
        lastName: 'Hode',
        gender: Gender.MALE,
        dateOfBirth: '1995-05-15',
        profileImageUrl: `https://signed.example/avatars/customers/cust-uuid-1-123.jpg?expires=${SIGNED_URL_EXPIRY_SECONDS}`,
        createdAt: mockDate,
        updatedAt: mockDate,
      });
    });
  });

  describe('8. Pagination works', () => {
    it('handles custom page and limit and calculates totalPages accurately', async () => {
      mockPrismaService.user.count.mockResolvedValue(55);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      const result = await service.getCustomers({ page: 3, limit: 10 });

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
        }),
      );

      expect(result.pagination).toEqual({
        page: 3,
        limit: 10,
        total: 55,
        totalPages: 6,
      });
    });

    it('safely clamps minimum page to 1 and maximum limit to 100', async () => {
      mockPrismaService.user.count.mockResolvedValue(0);
      mockPrismaService.user.findMany.mockResolvedValue([]);

      const result = await service.getCustomers({ page: -5, limit: 500 });

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 100,
        }),
      );

      expect(result.pagination).toEqual({
        page: 1,
        limit: 100,
        total: 0,
        totalPages: 0,
      });
    });
  });

  describe('9. Search by mobile', () => {
    it('adds case-insensitive mobile contains condition', async () => {
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      await service.getCustomers({ search: '9876543210' });

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: Role.CUSTOMER,
            OR: expect.arrayContaining([
              { mobile: { contains: '9876543210', mode: 'insensitive' } },
            ]),
          }),
        }),
      );
    });
  });

  describe('10. Search by email', () => {
    it('adds case-insensitive email contains condition', async () => {
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      await service.getCustomers({ search: 'cust1@example.com' });

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: Role.CUSTOMER,
            OR: expect.arrayContaining([
              { email: { contains: 'cust1@example.com', mode: 'insensitive' } },
            ]),
          }),
        }),
      );
    });
  });

  describe('11. Search by firstName', () => {
    it('adds case-insensitive customerProfile firstName contains condition', async () => {
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      await service.getCustomers({ search: 'Sahil' });

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: Role.CUSTOMER,
            OR: expect.arrayContaining([
              {
                customerProfile: {
                  firstName: { contains: 'Sahil', mode: 'insensitive' },
                },
              },
            ]),
          }),
        }),
      );
    });
  });

  describe('12. Search by lastName', () => {
    it('adds case-insensitive customerProfile lastName contains condition', async () => {
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      await service.getCustomers({ search: 'Hode' });

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: Role.CUSTOMER,
            OR: expect.arrayContaining([
              {
                customerProfile: {
                  lastName: { contains: 'Hode', mode: 'insensitive' },
                },
              },
            ]),
          }),
        }),
      );
    });

    it('supports multi-word full name search', async () => {
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      await service.getCustomers({ search: 'Sahil Hode' });

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: Role.CUSTOMER,
            OR: expect.arrayContaining([
              {
                customerProfile: {
                  AND: [
                    { firstName: { contains: 'Sahil', mode: 'insensitive' } },
                    { lastName: { contains: 'Hode', mode: 'insensitive' } },
                  ],
                },
              },
            ]),
          }),
        }),
      );
    });
  });

  describe('13. Counts are returned', () => {
    it('returns addresses and planSelections counts in list response', async () => {
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      const result = await service.getCustomers({ page: 1, limit: 20 });

      expect(result.data[0].counts).toEqual({
        addresses: 2,
        planSelections: 1,
      });
    });

    it('defaults counts to 0 when _count is undefined', async () => {
      const userWithoutCount = {
        ...baseCustomerUser,
        _count: undefined,
      };

      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([userWithoutCount]);

      const result = await service.getCustomers({ page: 1, limit: 20 });

      expect(result.data[0].counts).toEqual({
        addresses: 0,
        planSelections: 0,
      });
    });
  });

  describe('14. Sensitive fields are not returned', () => {
    it('does not expose internal security fields in list response', async () => {
      const userWithSensitiveFields = {
        ...baseCustomerUser,
        passwordHash: 'secret-hash',
        sessions: [{ refreshTokenHash: 'secret-token' }],
        otp: '123456',
      };

      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([userWithSensitiveFields]);

      const result = await service.getCustomers({ page: 1, limit: 20 });
      const item = result.data[0] as any;

      expect(item.passwordHash).toBeUndefined();
      expect(item.sessions).toBeUndefined();
      expect(item.otp).toBeUndefined();
      expect(item.customerProfile?.profileImagePath).toBeUndefined();
    });

    it('does not expose internal security fields in detail response', async () => {
      const userWithSensitiveFields = {
        ...baseCustomerUser,
        passwordHash: 'secret-hash',
        sessions: [{ refreshTokenHash: 'secret-token' }],
        otp: '123456',
        addresses: [],
        planSelections: [],
      };

      mockPrismaService.user.findFirst.mockResolvedValue(userWithSensitiveFields);

      const result = (await service.getCustomerById('cust-uuid-1')) as any;

      expect(result.passwordHash).toBeUndefined();
      expect(result.sessions).toBeUndefined();
      expect(result.otp).toBeUndefined();
      expect(result.profile?.profileImagePath).toBeUndefined();
    });
  });

  describe('15. Avatar signed URL is generated when avatar exists', () => {
    it('calls storageService.createSignedUrl and populates profileImageUrl in list and detail', async () => {
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      const listResult = await service.getCustomers({ page: 1, limit: 20 });

      expect(mockStorageService.createSignedUrl).toHaveBeenCalledWith(
        'avatars/customers/cust-uuid-1-123.jpg',
        SIGNED_URL_EXPIRY_SECONDS,
      );
      expect(listResult.data[0].profile?.profileImageUrl).toContain('https://signed.example/');

      mockPrismaService.user.findFirst.mockResolvedValue({
        ...baseCustomerUser,
        addresses: [],
        planSelections: [],
      });

      const detailResult = await service.getCustomerById('cust-uuid-1');
      expect(detailResult.profile?.profileImageUrl).toContain('https://signed.example/');
    });
  });

  describe('16. Avatar URL is null when no avatar exists', () => {
    it('sets profileImageUrl to null and does not call createSignedUrl when profileImagePath is null', async () => {
      const userNoAvatar = {
        ...baseCustomerUser,
        customerProfile: {
          ...baseCustomerUser.customerProfile,
          profileImagePath: null,
        },
      };

      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([userNoAvatar]);

      const listResult = await service.getCustomers({ page: 1, limit: 20 });

      expect(mockStorageService.createSignedUrl).not.toHaveBeenCalled();
      expect(listResult.data[0].profile?.profileImageUrl).toBeNull();

      mockPrismaService.user.findFirst.mockResolvedValue({
        ...userNoAvatar,
        addresses: [],
        planSelections: [],
      });

      const detailResult = await service.getCustomerById('cust-uuid-1');
      expect(detailResult.profile?.profileImageUrl).toBeNull();
    });

    it('sets profileImageUrl to null gracefully if signed URL creation fails', async () => {
      mockStorageService.createSignedUrl.mockRejectedValue(new Error('Storage failure'));

      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([baseCustomerUser]);

      const listResult = await service.getCustomers({ page: 1, limit: 20 });
      expect(listResult.data[0].profile?.profileImageUrl).toBeNull();
    });
  });
});
