jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import {
  ProfileService,
  SIGNED_URL_EXPIRY_SECONDS,
} from "./profile.service";
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
    // Deterministic signed URL so tests can assert the exact value and that it
    // is derived from the PATH (never persisted).
    createSignedUrl: jest
      .fn()
      .mockImplementation((p: string) =>
        Promise.resolve(`https://signed.example/${p}?token=sig`),
      ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockStorageService.createSignedUrl.mockImplementation((p: string) =>
      Promise.resolve(`https://signed.example/${p}?token=sig`),
    );

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
    profileImagePath: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    user: mockUser,
  };

  const NEW_PATH = "avatars/customers/user-123-1700000000000.jpg";
  const OLD_PATH = "avatars/customers/user-123-1600000000000.jpg";

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

  const makeFile = (
    overrides: Partial<Express.Multer.File>,
  ): Express.Multer.File =>
    ({
      fieldname: "avatar",
      originalname: "photo.jpg",
      mimetype: "image/jpeg",
      size: 1024,
      buffer: validJpegBuffer,
      ...overrides,
    }) as Express.Multer.File;

  describe("1. createCustomerProfile", () => {
    it("should create profile and return null profileImageUrl (no avatar yet)", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.customerProfile.create.mockResolvedValue(mockProfile);

      const result = await service.createCustomerProfile("user-123", {
        firstName: "Sahil",
        lastName: "Hode",
        gender: Gender.MALE,
        dateOfBirth: "2000-01-01",
      });

      expect(result.id).toBe("profile-123");
      expect(result.mobile).toBe("+919876543210");
      expect(result.profileImageUrl).toBeNull();
      expect(mockStorageService.createSignedUrl).not.toHaveBeenCalled();
    });

    it("should throw ConflictException if profile already exists", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(mockProfile);
      await expect(
        service.createCustomerProfile("user-123", {
          firstName: "Sahil",
          lastName: "Hode",
          gender: Gender.MALE,
          dateOfBirth: "2000-01-01",
        }),
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
      await expect(
        service.createCustomerProfile("user-123", {
          firstName: "Sahil",
          lastName: "Hode",
          gender: Gender.MALE,
          dateOfBirth: "2000-01-01",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("should throw NotFoundException if user is not found", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      await expect(
        service.createCustomerProfile("user-123", {
          firstName: "Sahil",
          lastName: "Hode",
          gender: Gender.MALE,
          dateOfBirth: "2000-01-01",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should reject invalid / future dateOfBirth", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      await expect(
        service.createCustomerProfile("user-123", {
          firstName: "Sahil",
          lastName: "Hode",
          gender: Gender.MALE,
          dateOfBirth: "not-a-date",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("2. getCustomerProfile (signed URL generation)", () => {
    it("R. generates a signed URL from the stored path and returns it as profileImageUrl", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: OLD_PATH,
      });

      const result = await service.getCustomerProfile("user-123");

      expect(mockStorageService.createSignedUrl).toHaveBeenCalledWith(
        OLD_PATH,
        SIGNED_URL_EXPIRY_SECONDS,
      );
      expect(result.profileImageUrl).toBe(
        `https://signed.example/${OLD_PATH}?token=sig`,
      );
    });

    it("S. returns profileImageUrl null when no avatar exists", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: null,
      whatsappNumber: "+919876543210",
      });

      const result = await service.getCustomerProfile("user-123");

      expect(result.profileImageUrl).toBeNull();
      expect(mockStorageService.createSignedUrl).not.toHaveBeenCalled();
    });

    it("returns null (not an error) if signing fails", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: OLD_PATH,
      });
      mockStorageService.createSignedUrl.mockRejectedValueOnce(
        new Error("sign failed"),
      );

      const result = await service.getCustomerProfile("user-123");
      expect(result.profileImageUrl).toBeNull();
    });

    it("throws NotFoundException if profile missing", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      await expect(service.getCustomerProfile("user-123")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("3. updateCustomerProfile", () => {
    it("updates fields and signs the existing avatar path", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: OLD_PATH,
      });
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        firstName: "UpdatedFirst",
        profileImagePath: OLD_PATH,
      });

      const result = await service.updateCustomerProfile("user-123", {
        firstName: "UpdatedFirst",
      });

      expect(result.firstName).toBe("UpdatedFirst");
      expect(result.profileImageUrl).toBe(
        `https://signed.example/${OLD_PATH}?token=sig`,
      );
    });
  });

  describe("4. updateCustomerAvatar", () => {
    it("O. replacement: upload -> DB stores PATH -> old object deleted (safe order), returns signed URL", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: OLD_PATH,
      });
      mockStorageService.uploadAvatar.mockResolvedValue(NEW_PATH);
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        profileImagePath: NEW_PATH,
      });

      const result = await service.updateCustomerAvatar(
        "user-123",
        makeFile({}),
      );

      // Response exposes a SIGNED URL, derived from the new path.
      expect(result.profileImageUrl).toBe(
        `https://signed.example/${NEW_PATH}?token=sig`,
      );

      // T. DB stores only the PATH, never a URL.
      expect(mockPrismaService.customerProfile.update).toHaveBeenCalledWith({
        where: { userId: "user-123" },
        data: { profileImagePath: NEW_PATH },
        include: { user: true },
      });
      const stored =
        mockPrismaService.customerProfile.update.mock.calls[0][0].data
          .profileImagePath;
      expect(stored).toBe(NEW_PATH);
      expect(stored).not.toMatch(/^https?:\/\//);

      // Safe ordering: upload -> db update -> delete old
      const uploadOrder =
        mockStorageService.uploadAvatar.mock.invocationCallOrder[0];
      const dbUpdateOrder =
        mockPrismaService.customerProfile.update.mock.invocationCallOrder[0];
      const deleteOrder =
        mockStorageService.deleteAvatar.mock.invocationCallOrder[0];
      expect(uploadOrder).toBeLessThan(dbUpdateOrder);
      expect(dbUpdateOrder).toBeLessThan(deleteOrder);
      expect(mockStorageService.deleteAvatar).toHaveBeenCalledWith(OLD_PATH);
    });

    it("N. DB update failure deletes the newly uploaded object and keeps old avatar/path", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: OLD_PATH,
      });
      mockStorageService.uploadAvatar.mockResolvedValue(NEW_PATH);
      mockPrismaService.customerProfile.update.mockRejectedValue(
        new Error("Database connection error"),
      );

      await expect(
        service.updateCustomerAvatar("user-123", makeFile({})),
      ).rejects.toThrow("Database connection error");

      expect(mockStorageService.deleteAvatar).toHaveBeenCalledWith(NEW_PATH);
      expect(mockStorageService.deleteAvatar).not.toHaveBeenCalledWith(OLD_PATH);
    });

    it("M. upload failure keeps old avatar and does not touch the DB", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: OLD_PATH,
      });
      mockStorageService.uploadAvatar.mockRejectedValue(
        new Error("Storage upload error"),
      );

      await expect(
        service.updateCustomerAvatar("user-123", makeFile({})),
      ).rejects.toThrow("Storage upload error");

      expect(mockStorageService.deleteAvatar).not.toHaveBeenCalled();
      expect(mockPrismaService.customerProfile.update).not.toHaveBeenCalled();
    });

    it("P. old-object deletion failure does NOT roll back the new DB path", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: OLD_PATH,
      });
      mockStorageService.uploadAvatar.mockResolvedValue(NEW_PATH);
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        profileImagePath: NEW_PATH,
      });
      mockStorageService.deleteAvatar.mockRejectedValueOnce(
        new Error("old delete failed"),
      );

      const result = await service.updateCustomerAvatar(
        "user-123",
        makeFile({}),
      );

      // New avatar stays live; call resolves successfully.
      expect(result.profileImageUrl).toBe(
        `https://signed.example/${NEW_PATH}?token=sig`,
      );
      expect(mockStorageService.deleteAvatar).toHaveBeenCalledWith(OLD_PATH);
    });

    it("Q. no previous avatar -> no old deletion", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: null,
      whatsappNumber: "+919876543210",
      });
      mockStorageService.uploadAvatar.mockResolvedValue(NEW_PATH);
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        profileImagePath: NEW_PATH,
      });

      const result = await service.updateCustomerAvatar(
        "user-123",
        makeFile({}),
      );
      expect(result.profileImageUrl).toBe(
        `https://signed.example/${NEW_PATH}?token=sig`,
      );
      expect(mockStorageService.deleteAvatar).not.toHaveBeenCalled();
    });

    it("A/B/C. accepts valid JPEG, PNG and WEBP", async () => {
      for (const [mimetype, buffer] of [
        ["image/jpeg", validJpegBuffer],
        ["image/png", validPngBuffer],
        ["image/webp", validWebpBuffer],
      ] as const) {
        jest.clearAllMocks();
        mockStorageService.createSignedUrl.mockImplementation((p: string) =>
          Promise.resolve(`https://signed.example/${p}?token=sig`),
        );
        mockPrismaService.customerProfile.findUnique.mockResolvedValue(mockProfile);
        mockStorageService.uploadAvatar.mockResolvedValue(NEW_PATH);
        mockPrismaService.customerProfile.update.mockResolvedValue({
          ...mockProfile,
          profileImagePath: NEW_PATH,
        });

        const result = await service.updateCustomerAvatar(
          "user-123",
          makeFile({ mimetype, buffer }),
        );
        expect(result.profileImageUrl).toContain("https://signed.example/");
      }
    });

    it("D. accepts a file exactly 3 MB", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(mockProfile);
      mockStorageService.uploadAvatar.mockResolvedValue(NEW_PATH);
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        profileImagePath: NEW_PATH,
      });

      const result = await service.updateCustomerAvatar(
        "user-123",
        makeFile({ size: 3 * 1024 * 1024 }),
      );
      expect(result.profileImageUrl).toContain("https://signed.example/");
    });

    it("E. rejects a file larger than 3 MB", async () => {
      await expect(
        service.updateCustomerAvatar(
          "user-123",
          makeFile({ size: 3 * 1024 * 1024 + 1 }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("G. rejects an unsupported MIME type", async () => {
      await expect(
        service.updateCustomerAvatar(
          "user-123",
          makeFile({ mimetype: "text/plain", buffer: Buffer.from("hello") }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("I. rejects a fake JPEG that actually contains PNG bytes", async () => {
      await expect(
        service.updateCustomerAvatar(
          "user-123",
          makeFile({ mimetype: "image/jpeg", buffer: validPngBuffer }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("J. rejects a fake PNG that actually contains JPEG bytes", async () => {
      await expect(
        service.updateCustomerAvatar(
          "user-123",
          makeFile({ mimetype: "image/png", buffer: validJpegBuffer }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects when file is missing", async () => {
      await expect(
        service.updateCustomerAvatar("user-123", undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException if profile does not exist", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      await expect(
        service.updateCustomerAvatar("user-123", makeFile({})),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("5. removeCustomerAvatar", () => {
    it("U. deletes the stored object and clears the DB path, returning null", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: OLD_PATH,
      });
      mockPrismaService.customerProfile.update.mockResolvedValue({
        ...mockProfile,
        profileImagePath: null,
      whatsappNumber: "+919876543210",
      });

      const result = await service.removeCustomerAvatar("user-123");

      expect(mockStorageService.deleteAvatar).toHaveBeenCalledWith(OLD_PATH);
      expect(mockPrismaService.customerProfile.update).toHaveBeenCalledWith({
        where: { userId: "user-123" },
        data: { profileImagePath: null },
        include: { user: true },
      });
      expect(result.profileImageUrl).toBeNull();
    });

    it("is a no-op delete when there is no avatar", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        profileImagePath: null,
      whatsappNumber: "+919876543210",
      });

      const result = await service.removeCustomerAvatar("user-123");
      expect(mockStorageService.deleteAvatar).not.toHaveBeenCalled();
      expect(result.profileImageUrl).toBeNull();
    });

    it("throws NotFoundException if profile does not exist", async () => {
      mockPrismaService.customerProfile.findUnique.mockResolvedValue(null);
      await expect(service.removeCustomerAvatar("user-123")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
