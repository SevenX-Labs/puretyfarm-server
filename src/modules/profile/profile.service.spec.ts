jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ProfileService } from "./profile.service";
import { PrismaService } from "../../prisma/prisma.service";
import { ProfileStorageService } from "./storage/profile-storage.service";
import { Gender, Prisma } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";

describe("ProfileService", () => {
  let service: ProfileService;

  const mockPrismaService = {
    customerProfile: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };

  const mockStorageService = {
    uploadAvatar: jest.fn(),
    deleteAvatar: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProfileStorageService, useValue: mockStorageService },
      ],
    }).compile();

    service = module.get<ProfileService>(ProfileService);
  });

  const mockUser = {
    id: "user-123",
    mobile: "+919876543210",
    email: "customer@example.com",
    emailVerified: true,
  };

  const mockProfile = {
    id: "profile-123",
    userId: "user-123",
    firstName: "Sahil",
    lastName: "Hode",
    gender: Gender.MALE,
    dateOfBirth: new Date("2000-01-01"),
    profileImageUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    user: mockUser,
  };

  // Helper buffers with valid magic bytes
  const validJpegBuffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ]);
  const validPngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);
  const validWebpBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);

  describe("1. createCustomerProfile", () => {
    it("should successfully create customer profile and return combined profile", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.customerProfile.create.mockResolvedValue(mockProfile);

      const dto = {
        firstName: "Sahil",
        lastName: "Hode",
        gender: Gender.MALE,
        dateOfBirth: "2000-01-01",
      };

      const result = await service.createCustomerProfile("user-123", dto);

      expect(result.id).toBe("profile-123");
      expect(result.userId).toBe("user-123");
      expect(result.firstName).toBe("Sahil");
      expect(result.lastName).toBe("Hode");
      expect(result.mobile).toBe("+919876543210");
      expect(result.email).toBe("customer@example.com");
      expect(result.emailVerified).toBe(true);
      expect(result.dateOfBirth).toBe("2000-01-01");
    });

    it("should throw ConflictException if profile already exists", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(mockProfile);

      const dto = {
        firstName: "Sahil",
        lastName: "Hode",
        gender: Gender.MALE,
        dateOfBirth: "2000-01-01",
      };

      await expect(
        service.createCustomerProfile("user-123", dto),
      ).rejects.toThrow(ConflictException);
    });

    it("should throw ConflictException on Prisma P2002 race condition", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.customerProfile.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint", {
          code: "P2002",
          clientVersion: "6.0.0",
        }),
      );

      const dto = {
        firstName: "Sahil",
        lastName: "Hode",
        gender: Gender.MALE,
        dateOfBirth: "2000-01-01",
      };

      await expect(
        service.createCustomerProfile("user-123", dto),
      ).rejects.toThrow(ConflictException);
    });

    it("should throw NotFoundException if user is not found", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const dto = {
        firstName: "Sahil",
        lastName: "Hode",
        gender: Gender.MALE,
        dateOfBirth: "2000-01-01",
      };

      await expect(
        service.createCustomerProfile("user-123", dto),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw BadRequestException if dateOfBirth is invalid", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);

      const dto = {
        firstName: "Sahil",
        lastName: "Hode",
        gender: Gender.MALE,
        dateOfBirth: "not-a-date",
      };

      await expect(
        service.createCustomerProfile("user-123", dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException if dateOfBirth is in the future", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);

      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const dto = {
        firstName: "Sahil",
        lastName: "Hode",
        gender: Gender.MALE,
        dateOfBirth: futureDate.toISOString(),
      };

      await expect(
        service.createCustomerProfile("user-123", dto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("2. getCustomerProfile", () => {
    it("should return combined profile for authenticated user", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(mockProfile);

      const result = await service.getCustomerProfile("user-123");

      expect(result.id).toBe("profile-123");
      expect(result.firstName).toBe("Sahil");
      expect(result.mobile).toBe("+919876543210");
    });

    it("should throw NotFoundException if customer has not created a profile yet", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);

      await expect(service.getCustomerProfile("user-123")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("3. updateCustomerProfile", () => {
    it("should update allowed fields and return combined profile", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        firstName: "UpdatedFirst",
        lastName: "UpdatedLast",
      });

      const result = await service.updateCustomerProfile("user-123", {
        firstName: "UpdatedFirst",
        lastName: "UpdatedLast",
      });

      expect(result.firstName).toBe("UpdatedFirst");
      expect(result.lastName).toBe("UpdatedLast");
    });

    it("should throw NotFoundException if profile does not exist to update", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.updateCustomerProfile("user-123", { firstName: "Test" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should reject update if dateOfBirth is in the future", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(mockProfile);

      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 2);

      await expect(
        service.updateCustomerProfile("user-123", {
          dateOfBirth: futureDate.toISOString(),
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("4. updateCustomerAvatar", () => {
    it("should upload new avatar, update database, and only then delete old avatar in safe order", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImageUrl: "/uploads/avatars/old-avatar.jpg",
      });
      mockStorageService.uploadAvatar.mockResolvedValue(
        "/uploads/avatars/new-avatar.jpg",
      );
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        profileImageUrl: "/uploads/avatars/new-avatar.jpg",
      });

      const file = {
        fieldname: "avatar",
        originalname: "photo.jpg",
        mimetype: "image/jpeg",
        size: 1024,
        buffer: validJpegBuffer,
      } as Express.Multer.File;

      const result = await service.updateCustomerAvatar("user-123", file);

      expect(result.profileImageUrl).toBe("/uploads/avatars/new-avatar.jpg");

      // Verify safe execution order: upload -> db update -> delete old
      const uploadOrder = mockStorageService.uploadAvatar.mock.invocationCallOrder[0];
      const dbUpdateOrder = mockPrismaService.customerProfile.update.mock.invocationCallOrder[0];
      const deleteOrder = mockStorageService.deleteAvatar.mock.invocationCallOrder[0];

      expect(uploadOrder).toBeLessThan(dbUpdateOrder);
      expect(dbUpdateOrder).toBeLessThan(deleteOrder);
      expect(mockStorageService.deleteAvatar).toHaveBeenCalledWith(
        "/uploads/avatars/old-avatar.jpg",
      );
    });

    it("should clean up newly uploaded avatar and preserve old avatar if database update fails", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImageUrl: "/uploads/avatars/old-avatar.jpg",
      });
      mockStorageService.uploadAvatar.mockResolvedValue(
        "/uploads/avatars/new-avatar.jpg",
      );
      mockPrismaService.customerProfile.update.mockRejectedValue(
        new Error("Database connection error"),
      );

      const file = {
        fieldname: "avatar",
        originalname: "photo.jpg",
        mimetype: "image/jpeg",
        size: 1024,
        buffer: validJpegBuffer,
      } as Express.Multer.File;

      await expect(
        service.updateCustomerAvatar("user-123", file),
      ).rejects.toThrow("Database connection error");

      // Newly uploaded avatar must be cleaned up to prevent orphans
      expect(mockStorageService.deleteAvatar).toHaveBeenCalledWith(
        "/uploads/avatars/new-avatar.jpg",
      );
      // Old avatar must NOT be deleted
      expect(mockStorageService.deleteAvatar).not.toHaveBeenCalledWith(
        "/uploads/avatars/old-avatar.jpg",
      );
    });

    it("should keep old avatar untouched if upload fails", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImageUrl: "/uploads/avatars/old-avatar.jpg",
      });
      mockStorageService.uploadAvatar.mockRejectedValue(
        new Error("Storage upload error"),
      );

      const file = {
        fieldname: "avatar",
        originalname: "photo.jpg",
        mimetype: "image/jpeg",
        size: 1024,
        buffer: validJpegBuffer,
      } as Express.Multer.File;

      await expect(
        service.updateCustomerAvatar("user-123", file),
      ).rejects.toThrow("Storage upload error");

      expect(mockStorageService.deleteAvatar).not.toHaveBeenCalled();
      expect(mockPrismaService.customerProfile.update).not.toHaveBeenCalled();
    });

    it("should not call deleteAvatar if customer had no previous avatar", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImageUrl: null,
      });
      mockStorageService.uploadAvatar.mockResolvedValue(
        "/uploads/avatars/new-avatar.jpg",
      );
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        profileImageUrl: "/uploads/avatars/new-avatar.jpg",
      });

      const file = {
        fieldname: "avatar",
        originalname: "photo.jpg",
        mimetype: "image/jpeg",
        size: 1024,
        buffer: validJpegBuffer,
      } as Express.Multer.File;

      const result = await service.updateCustomerAvatar("user-123", file);
      expect(result.profileImageUrl).toBe("/uploads/avatars/new-avatar.jpg");
      expect(mockStorageService.deleteAvatar).not.toHaveBeenCalled();
    });

    it("should accept valid PNG image", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(mockProfile);
      mockStorageService.uploadAvatar.mockResolvedValue(
        "/uploads/avatars/avatar.png",
      );
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        profileImageUrl: "/uploads/avatars/avatar.png",
      });

      const file = {
        fieldname: "avatar",
        originalname: "photo.png",
        mimetype: "image/png",
        size: 2048,
        buffer: validPngBuffer,
      } as Express.Multer.File;

      const result = await service.updateCustomerAvatar("user-123", file);
      expect(result.profileImageUrl).toBe("/uploads/avatars/avatar.png");
    });

    it("should accept valid WEBP image", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(mockProfile);
      mockStorageService.uploadAvatar.mockResolvedValue(
        "/uploads/avatars/avatar.webp",
      );
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        profileImageUrl: "/uploads/avatars/avatar.webp",
      });

      const file = {
        fieldname: "avatar",
        originalname: "photo.webp",
        mimetype: "image/webp",
        size: 3000,
        buffer: validWebpBuffer,
      } as Express.Multer.File;

      const result = await service.updateCustomerAvatar("user-123", file);
      expect(result.profileImageUrl).toBe("/uploads/avatars/avatar.webp");
    });

    it("should reject avatar if file is missing", async () => {
      await expect(
        service.updateCustomerAvatar("user-123", undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject avatar larger than 3 MB", async () => {
      const oversizedFile = {
        fieldname: "avatar",
        originalname: "large.jpg",
        mimetype: "image/jpeg",
        size: 3 * 1024 * 1024 + 1,
        buffer: validJpegBuffer,
      } as Express.Multer.File;

      await expect(
        service.updateCustomerAvatar("user-123", oversizedFile),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject unsupported MIME type (e.g. text/plain)", async () => {
      const textFile = {
        fieldname: "avatar",
        originalname: "notes.txt",
        mimetype: "text/plain",
        size: 100,
        buffer: Buffer.from("Hello world"),
      } as Express.Multer.File;

      await expect(
        service.updateCustomerAvatar("user-123", textFile),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject file if magic bytes do not match valid image signature", async () => {
      const spoofedFile = {
        fieldname: "avatar",
        originalname: "malicious.jpg",
        mimetype: "image/jpeg",
        size: 500,
        buffer: Buffer.from("MZ fake executable header"),
      } as Express.Multer.File;

      await expect(
        service.updateCustomerAvatar("user-123", spoofedFile),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw NotFoundException if profile does not exist when uploading avatar", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);

      const file = {
        fieldname: "avatar",
        originalname: "photo.jpg",
        mimetype: "image/jpeg",
        size: 1024,
        buffer: validJpegBuffer,
      } as Express.Multer.File;

      await expect(
        service.updateCustomerAvatar("user-123", file),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("5. removeCustomerAvatar", () => {
    it("should remove avatar reference and delete physical object", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImageUrl: "/uploads/avatars/photo.jpg",
      });
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        profileImageUrl: null,
      });

      const result = await service.removeCustomerAvatar("user-123");

      expect(mockStorageService.deleteAvatar).toHaveBeenCalledWith(
        "/uploads/avatars/photo.jpg",
      );
      expect(result.profileImageUrl).toBeNull();
    });

    it("should throw NotFoundException if profile does not exist to remove avatar", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);

      await expect(service.removeCustomerAvatar("user-123")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
