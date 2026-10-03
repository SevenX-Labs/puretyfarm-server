import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findOrCreateByMobile', () => {
    it('returns the existing user without creating', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'u1',
        mobile: '+919876543210',
      });

      const user = await service.findOrCreateByMobile('+919876543210');

      expect(user.id).toBe('u1');
      expect(mockPrismaService.user.create).not.toHaveBeenCalled();
    });

    it('creates the user when none exists', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'new',
        mobile: '+919876543210',
      });

      const user = await service.findOrCreateByMobile('+919876543210');

      expect(user.id).toBe('new');
      expect(mockPrismaService.user.create).toHaveBeenCalled();
    });

    it('recovers from a concurrent-create unique violation (P2002) by re-fetching', async () => {
      mockPrismaService.user.findUnique
        .mockResolvedValueOnce(null) // first lookup: not found
        .mockResolvedValueOnce({ id: 'winner', mobile: '+919876543210' }); // re-fetch
      mockPrismaService.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const user = await service.findOrCreateByMobile('+919876543210');

      expect(user.id).toBe('winner');
    });

    it('rethrows non-P2002 errors', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.findOrCreateByMobile('+919876543210'),
      ).rejects.toThrow('db down');
    });
  });
});
