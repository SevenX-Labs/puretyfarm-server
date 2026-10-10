import { Test, TestingModule } from "@nestjs/testing";
import { ProfileController } from "./profile.controller";
import { ProfileService } from "./profile.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { Gender } from "@prisma/client";
import { CustomerCreateProfileDto } from "./dto/customer/customer-create-profile.dto";
import { CustomerUpdateProfileDto } from "./dto/customer/customer-update-profile.dto";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ExecutionContext, UnauthorizedException, ForbiddenException } from "@nestjs/common";

jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

jest.mock("@nestjs/jwt", () => ({
  JwtService: jest.fn().mockImplementation(() => ({
    signAsync: jest.fn(),
    verifyAsync: jest.fn(),
  })),
}));

describe("ProfileController", () => {
  let controller: ProfileController;
  let guard: JwtAuthGuard;
  let jwtService: any;
  let configService: any;
  let prismaService: any;

  const mockProfileService = {
    createCustomerProfile: jest.fn().mockResolvedValue({
      id: "profile-1",
      userId: "user-1",
      firstName: "Sahil",
      lastName: "Hode",
      gender: Gender.MALE,
      dateOfBirth: "2000-01-01",
      profileImageUrl: null,
      mobile: "+919876543210",
      email: "test@example.com",
      emailVerified: true,
    }),
    getCustomerProfile: jest.fn().mockResolvedValue({
      id: "profile-1",
      userId: "user-1",
      firstName: "Sahil",
      lastName: "Hode",
      gender: Gender.MALE,
      dateOfBirth: "2000-01-01",
      profileImageUrl: null,
      mobile: "+919876543210",
      email: "test@example.com",
      emailVerified: true,
    }),
    updateCustomerProfile: jest.fn().mockResolvedValue({
      id: "profile-1",
      userId: "user-1",
      firstName: "UpdatedFirst",
      lastName: "UpdatedLast",
      gender: Gender.MALE,
      dateOfBirth: "2000-01-01",
      profileImageUrl: null,
      mobile: "+919876543210",
      email: "test@example.com",
      emailVerified: true,
    }),
    updateCustomerAvatar: jest.fn().mockResolvedValue({
      id: "profile-1",
      userId: "user-1",
      profileImageUrl: "/uploads/avatars/avatar.png",
    }),
    removeCustomerAvatar: jest.fn().mockResolvedValue({
      id: "profile-1",
      userId: "user-1",
      profileImageUrl: null,
    }),
  };

  const mockJwtPayload = {
    sub: "user-1",
    role: "CUSTOMER",
    sessionId: "session-1",
    type: "access" as const,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockPrisma = {
      session: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProfileController],
      providers: [
        { provide: ProfileService, useValue: mockProfileService },
        { provide: PrismaService, useValue: mockPrisma },
        JwtService,
        ConfigService,
        JwtAuthGuard,
      ],
    }).compile();

    controller = module.get<ProfileController>(ProfileController);
    guard = module.get<JwtAuthGuard>(JwtAuthGuard);
    jwtService = module.get<JwtService>(JwtService);
    configService = module.get<ConfigService>(ConfigService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  describe("Controller Endpoints and User Ownership", () => {
    it("should call createCustomerProfile using authenticated user.sub", async () => {
      const dto: CustomerCreateProfileDto = {
        firstName: "Sahil",
        lastName: "Hode",
        gender: Gender.MALE,
        dateOfBirth: "2000-01-01",
      };

      const res = await controller.createProfile(mockJwtPayload, dto);

      expect(res.id).toBe("profile-1");
      expect(mockProfileService.createCustomerProfile).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });

    it("should call getCustomerProfile using authenticated user.sub", async () => {
      const res = await controller.getMe(mockJwtPayload);

      expect(res.id).toBe("profile-1");
      expect(mockProfileService.getCustomerProfile).toHaveBeenCalledWith(
        "user-1",
      );
    });

    it("should call updateCustomerProfile using authenticated user.sub", async () => {
      const dto: CustomerUpdateProfileDto = {
        firstName: "UpdatedFirst",
      };

      const res = await controller.updateProfile(mockJwtPayload, dto);

      expect(res.firstName).toBe("UpdatedFirst");
      expect(mockProfileService.updateCustomerProfile).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });

    it("should call updateCustomerAvatar using authenticated user.sub and file", async () => {
      const file = {
        fieldname: "avatar",
        originalname: "photo.png",
        mimetype: "image/png",
        size: 1024,
        buffer: Buffer.from("image"),
      } as Express.Multer.File;

      const res = await controller.updateAvatar(mockJwtPayload, file);

      expect(res.profileImageUrl).toBe("/uploads/avatars/avatar.png");
      expect(mockProfileService.updateCustomerAvatar).toHaveBeenCalledWith(
        "user-1",
        file,
      );
    });

    it("should call removeCustomerAvatar using authenticated user.sub", async () => {
      const res = await controller.removeAvatar(mockJwtPayload);

      expect(res.profileImageUrl).toBeNull();
      expect(mockProfileService.removeCustomerAvatar).toHaveBeenCalledWith(
        "user-1",
      );
    });
  });

  describe("DTO Validations", () => {
    it("should validate valid CustomerCreateProfileDto successfully", async () => {
      const obj = {
        firstName: "Sahil",
        lastName: "Hode",
        gender: Gender.MALE,
        dateOfBirth: "2000-01-01",
        whatsappNumber: "+919876543210",
      };
      const dto = plainToInstance(CustomerCreateProfileDto, obj);
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it("should reject invalid gender in CustomerCreateProfileDto", async () => {
      const obj = {
        firstName: "Sahil",
        lastName: "Hode",
        gender: "INVALID_GENDER",
        dateOfBirth: "2000-01-01",
      };
      const dto = plainToInstance(CustomerCreateProfileDto, obj);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe("gender");
    });

    it("should reject invalid dateOfBirth format in CustomerCreateProfileDto", async () => {
      const obj = {
        firstName: "Sahil",
        lastName: "Hode",
        gender: Gender.MALE,
        dateOfBirth: "invalid-date-format",
      };
      const dto = plainToInstance(CustomerCreateProfileDto, obj);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe("dateOfBirth");
    });

    it("should validate CustomerUpdateProfileDto and strip protected User fields via whitelist ValidationPipe", async () => {
      const pipe = new (require("@nestjs/common").ValidationPipe)({
        whitelist: true,
        transform: true,
      });

      const obj = {
        firstName: "Updated",
        // Protected fields that must not be allowed
        id: "hacked-id",
        userId: "hacked-user-id",
        mobile: "+911111111111",
        email: "hacked@example.com",
        role: "ADMIN",
      };

      const result = await pipe.transform(obj, {
        type: "body",
        metatype: CustomerUpdateProfileDto,
      });

      expect(result.firstName).toBe("Updated");
      expect((result as any).id).toBeUndefined();
      expect((result as any).userId).toBeUndefined();
      expect((result as any).mobile).toBeUndefined();
      expect((result as any).email).toBeUndefined();
      expect((result as any).role).toBeUndefined();
    });
  });

  describe("Authentication Guard Security", () => {
    function createMockContext(headers: Record<string, string>): ExecutionContext {
      const request = {
        headers,
        user: undefined,
        session: undefined,
      };
      return {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
      } as unknown as ExecutionContext;
    }

    it("should reject unauthenticated request when token is missing", async () => {
      const context = createMockContext({});
      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should reject unauthenticated request when token is invalid", async () => {
      configService.get.mockReturnValue("secret123");
      jwtService.verifyAsync.mockRejectedValue(new Error("Invalid token"));

      const context = createMockContext({
        authorization: "Bearer invalid-token",
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should reject request when session does not belong to token subject (preventing cross-user access)", async () => {
      configService.get.mockReturnValue("secret123");
      jwtService.verifyAsync.mockResolvedValue({
        sub: "user-attacker",
        sessionId: "session-victim",
        type: "access",
        role: "CUSTOMER",
      });
      prismaService.session.findUnique.mockResolvedValue({
        id: "session-victim",
        userId: "user-victim", // Different user!
        revokedAt: null,
        expiresAt: new Date(Date.now() + 100000),
      });

      const context = createMockContext({
        authorization: "Bearer valid-token-wrong-session",
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should reject request when role is not CUSTOMER", async () => {
      configService.get.mockReturnValue("secret123");
      jwtService.verifyAsync.mockResolvedValue({
        sub: "user-1",
        sessionId: "session-1",
        type: "access",
        role: "ADMIN", // Non-customer role
      });
      prismaService.session.findUnique.mockResolvedValue({
        id: "session-1",
        userId: "user-1",
        revokedAt: null,
        expiresAt: new Date(Date.now() + 100000),
      });

      const context = createMockContext({
        authorization: "Bearer valid-token-admin-role",
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
