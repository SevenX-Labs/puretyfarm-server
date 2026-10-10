import { Test, TestingModule } from '@nestjs/testing';
import { AddressService } from './address.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('AddressService', () => {
  let service: AddressService;

  const mockPrisma = {
    area: { findUnique: jest.fn() },
    customerAddress: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  const OWNER = 'user-1';
  const OTHER = 'user-2';

  // A fully active, consistent State -> City -> Area chain.
  const activeArea = {
    id: 'area-1',
    name: 'Bandra',
    cityId: 'city-1',
    pincode: '400050',
    isActive: true,
    city: {
      id: 'city-1',
      name: 'Mumbai',
      stateId: 'state-1',
      isActive: true,
      state: { id: 'state-1', name: 'Maharashtra', isActive: true },
    },
  };

  const baseDto = {
    fullName: 'Sahil Hode',
    mobile: '+919876543210',
    houseNumber: '101',
    buildingName: 'Sea View',
    streetName: 'Hill Road',
    landmark: 'Near Station',
    stateId: 'state-1',
    cityId: 'city-1',
    areaId: 'area-1',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AddressService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<AddressService>(AddressService);
  });

  describe('17/18. createAddress', () => {
    it('creates an address scoped to the JWT user with server-resolved names', async () => {
      mockPrisma.area.findUnique.mockResolvedValue(activeArea);
      mockPrisma.customerAddress.create.mockImplementation(({ data }: any) => ({
        id: 'addr-1',
        ...data,
      }));

      const result = await service.createAddress(OWNER, baseDto);

      const data = mockPrisma.customerAddress.create.mock.calls[0][0].data;
      expect(data.userId).toBe(OWNER);
      // Names are resolved from the catalog, not trusted from input.
      expect(data.state).toBe('Maharashtra');
      expect(data.city).toBe('Mumbai');
      expect(data.area).toBe('Bandra');
      expect(data.pincode).toBe('400050');
      expect(result.id).toBe('addr-1');
    });

    it('19. rejects an invalid State -> City -> Area combination', async () => {
      // Area exists but belongs to a different city than the one claimed.
      mockPrisma.area.findUnique.mockResolvedValue({
        ...activeArea,
        cityId: 'city-999',
        city: { ...activeArea.city, id: 'city-999' },
      });

      await expect(service.createAddress(OWNER, baseDto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.customerAddress.create).not.toHaveBeenCalled();
    });

    it('rejects an inactive area', async () => {
      mockPrisma.area.findUnique.mockResolvedValue({
        ...activeArea,
        isActive: false,
      });
      await expect(service.createAddress(OWNER, baseDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects when the city belongs to a different state', async () => {
      mockPrisma.area.findUnique.mockResolvedValue({
        ...activeArea,
        city: { ...activeArea.city, stateId: 'state-999' },
      });
      await expect(service.createAddress(OWNER, baseDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('29. persists GPS coordinates when provided', async () => {
      mockPrisma.area.findUnique.mockResolvedValue(activeArea);
      mockPrisma.customerAddress.create.mockImplementation(({ data }: any) => ({
        id: 'addr-1',
        ...data,
      }));

      await service.createAddress(OWNER, {
        ...baseDto,
        latitude: 19.076,
        longitude: 72.8777,
      });

      const data = mockPrisma.customerAddress.create.mock.calls[0][0].data;
      expect(data.latitude).toBe(19.076);
      expect(data.longitude).toBe(72.8777);
    });

    it('30. leaves coordinates null for manual selection', async () => {
      mockPrisma.area.findUnique.mockResolvedValue(activeArea);
      mockPrisma.customerAddress.create.mockImplementation(({ data }: any) => ({
        id: 'addr-1',
        ...data,
      }));

      await service.createAddress(OWNER, baseDto);

      const data = mockPrisma.customerAddress.create.mock.calls[0][0].data;
      expect(data.latitude).toBeNull();
      expect(data.longitude).toBeNull();
    });
  });

  describe('20/21. getAddresses', () => {
    it("returns only the caller's addresses", async () => {
      mockPrisma.customerAddress.findMany.mockResolvedValue([{ id: 'addr-1' }]);
      const result = await service.getAddresses(OWNER);
      expect(mockPrisma.customerAddress.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: OWNER } }),
      );
      expect(result).toEqual([{ id: 'addr-1' }]);
    });
  });

  describe('22/23. getAddress (IDOR)', () => {
    it('returns the address when owned by the caller', async () => {
      mockPrisma.customerAddress.findFirst.mockResolvedValue({
        id: 'addr-1',
        userId: OWNER,
      });
      const result = await service.getAddress(OWNER, 'addr-1');
      expect(result.id).toBe('addr-1');
      expect(mockPrisma.customerAddress.findFirst).toHaveBeenCalledWith({
        where: { id: 'addr-1', userId: OWNER },
      });
    });

    it('throws NotFound when the address belongs to another user', async () => {
      // Scoped query returns null because userId does not match.
      mockPrisma.customerAddress.findFirst.mockResolvedValue(null);
      await expect(service.getAddress(OTHER, 'addr-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('24/25. updateAddress', () => {
    it('updates an owned address and re-resolves names when location changes', async () => {
      mockPrisma.customerAddress.findFirst.mockResolvedValue({
        id: 'addr-1',
        userId: OWNER,
        stateId: 'state-1',
        cityId: 'city-1',
        areaId: 'area-old',
      });
      mockPrisma.area.findUnique.mockResolvedValue(activeArea);
      mockPrisma.customerAddress.update.mockImplementation(({ data }: any) => ({
        id: 'addr-1',
        ...data,
      }));

      await service.updateAddress(OWNER, 'addr-1', { areaId: 'area-1' });

      expect(mockPrisma.area.findUnique).toHaveBeenCalled();
      const data = mockPrisma.customerAddress.update.mock.calls[0][0].data;
      expect(data.area).toBe('Bandra');
    });

    it('does not re-validate the hierarchy when no location field changes', async () => {
      mockPrisma.customerAddress.findFirst.mockResolvedValue({
        id: 'addr-1',
        userId: OWNER,
      });
      mockPrisma.customerAddress.update.mockResolvedValue({ id: 'addr-1' });

      await service.updateAddress(OWNER, 'addr-1', {
        landmark: 'New landmark',
      });

      expect(mockPrisma.area.findUnique).not.toHaveBeenCalled();
    });

    it("throws NotFound when updating another user's address", async () => {
      mockPrisma.customerAddress.findFirst.mockResolvedValue(null);
      await expect(
        service.updateAddress(OTHER, 'addr-1', { landmark: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrisma.customerAddress.update).not.toHaveBeenCalled();
    });
  });

  describe('26/27. deleteAddress', () => {
    it('deletes an owned address', async () => {
      mockPrisma.customerAddress.findFirst.mockResolvedValue({
        id: 'addr-1',
        userId: OWNER,
      });
      mockPrisma.customerAddress.delete.mockResolvedValue({ id: 'addr-1' });

      await service.deleteAddress(OWNER, 'addr-1');
      expect(mockPrisma.customerAddress.delete).toHaveBeenCalledWith({
        where: { id: 'addr-1' },
      });
    });

    it("throws NotFound (and does not delete) for another user's address", async () => {
      mockPrisma.customerAddress.findFirst.mockResolvedValue(null);
      await expect(service.deleteAddress(OTHER, 'addr-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.customerAddress.delete).not.toHaveBeenCalled();
    });
  });

  describe('mobile normalization', () => {
    beforeEach(() => {
      mockPrisma.area.findUnique.mockResolvedValue(activeArea);
      mockPrisma.customerAddress.create.mockImplementation(({ data }: any) => ({
        id: 'addr-1',
        ...data,
      }));
      mockPrisma.customerAddress.update.mockImplementation(({ data }: any) => ({
        id: 'addr-1',
        ...data,
      }));
    });

    it('15/18. normalizes a 10-digit Indian number on create', async () => {
      await service.createAddress(OWNER, { ...baseDto, mobile: '9876543210' });
      const data = mockPrisma.customerAddress.create.mock.calls[0][0].data;
      expect(data.mobile).toBe('+919876543210');
    });

    it('16. keeps an already-canonical +91 number on create', async () => {
      await service.createAddress(OWNER, {
        ...baseDto,
        mobile: '+919876543210',
      });
      const data = mockPrisma.customerAddress.create.mock.calls[0][0].data;
      expect(data.mobile).toBe('+919876543210');
    });

    it('17. rejects an invalid mobile with a 400 on create', async () => {
      await expect(
        service.createAddress(OWNER, { ...baseDto, mobile: '12345' }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.customerAddress.create).not.toHaveBeenCalled();
    });

    it('19. normalizes the mobile on update when supplied', async () => {
      mockPrisma.customerAddress.findFirst.mockResolvedValue({
        id: 'addr-1',
        userId: OWNER,
      });
      await service.updateAddress(OWNER, 'addr-1', { mobile: '09876543210' });
      const data = mockPrisma.customerAddress.update.mock.calls[0][0].data;
      expect(data.mobile).toBe('+919876543210');
    });

    it('20. leaves mobile untouched on update when not supplied', async () => {
      mockPrisma.customerAddress.findFirst.mockResolvedValue({
        id: 'addr-1',
        userId: OWNER,
      });
      await service.updateAddress(OWNER, 'addr-1', { landmark: 'New' });
      const data = mockPrisma.customerAddress.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('mobile');
    });

    it('rejects an invalid mobile with a 400 on update', async () => {
      mockPrisma.customerAddress.findFirst.mockResolvedValue({
        id: 'addr-1',
        userId: OWNER,
      });
      await expect(
        service.updateAddress(OWNER, 'addr-1', { mobile: 'abc' }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.customerAddress.update).not.toHaveBeenCalled();
    });
  });
});
