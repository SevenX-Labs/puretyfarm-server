jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock("@nestjs/jwt", () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { AdminWalletController } from "./admin-wallet.controller";
import { WalletService } from "./wallet.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { RejectCreditRequestDto } from "./dto/admin/reject-credit-request.dto";
import { AdminListCreditRequestsQueryDto } from "./dto/admin/list-credit-requests-query.dto";

describe("AdminWalletController", () => {
  let controller: AdminWalletController;

  const mockService = {
    getAdminCreditRequests: jest.fn().mockResolvedValue({ data: [] }),
    getAdminCreditRequest: jest.fn().mockResolvedValue({}),
    approveCreditRequest: jest.fn().mockResolvedValue({ success: true }),
    rejectCreditRequest: jest.fn().mockResolvedValue({ success: true }),
    getAdminCustomerWallet: jest.fn().mockResolvedValue({}),
  };

  const adminJwt = {
    sub: "admin-1",
    role: "ADMIN",
    sessionId: "session-1",
    type: "access" as const,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminWalletController],
      providers: [{ provide: WalletService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(AdminWalletController);
  });

  it("is protected by JwtAuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", AdminWalletController);
    expect(guards).toContain(JwtAuthGuard);
  });

  it("requires ADMIN role", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminWalletController);
    expect(roles).toContain("ADMIN");
  });

  it("customer token cannot access (role check)", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminWalletController);
    expect(roles).not.toContain("CUSTOMER");
  });

  describe("listCreditRequests", () => {
    it("delegates to service", async () => {
      await controller.listCreditRequests({});
      expect(mockService.getAdminCreditRequests).toHaveBeenCalledWith({});
    });
  });

  describe("getCreditRequest", () => {
    it("delegates to service", async () => {
      await controller.getCreditRequest("req-1");
      expect(mockService.getAdminCreditRequest).toHaveBeenCalledWith("req-1");
    });
  });

  describe("approveCreditRequest", () => {
    it("uses admin.sub", async () => {
      await controller.approveCreditRequest(adminJwt, "req-1");
      expect(mockService.approveCreditRequest).toHaveBeenCalledWith("req-1", "admin-1");
    });
  });

  describe("rejectCreditRequest", () => {
    it("uses admin.sub and passes note", async () => {
      await controller.rejectCreditRequest(adminJwt, "req-1", { note: "Bad request" });
      expect(mockService.rejectCreditRequest).toHaveBeenCalledWith("req-1", "admin-1", {
        note: "Bad request",
      });
    });
  });

  describe("getCustomerWallet", () => {
    it("delegates to service", async () => {
      await controller.getCustomerWallet("user-1");
      expect(mockService.getAdminCustomerWallet).toHaveBeenCalledWith("user-1");
    });
  });

  describe("DTO validation", () => {
    async function errorsFor(cls: any, payload: any) {
      return validate(plainToInstance(cls, payload));
    }

    it("RejectCreditRequestDto requires note", async () => {
      expect(
        (await errorsFor(RejectCreditRequestDto, {})).length,
      ).toBeGreaterThan(0);
    });

    it("RejectCreditRequestDto rejects empty note", async () => {
      expect(
        (await errorsFor(RejectCreditRequestDto, { note: "" })).length,
      ).toBeGreaterThan(0);
    });

    it("RejectCreditRequestDto rejects short note", async () => {
      expect(
        (await errorsFor(RejectCreditRequestDto, { note: "ab" })).length,
      ).toBeGreaterThan(0);
    });

    it("RejectCreditRequestDto accepts valid note", async () => {
      expect(
        await errorsFor(RejectCreditRequestDto, { note: "Payment not verified" }),
      ).toHaveLength(0);
    });

    it("AdminListCreditRequestsQueryDto rejects invalid status", async () => {
      expect(
        (await errorsFor(AdminListCreditRequestsQueryDto, { status: "FLYING" })).length,
      ).toBeGreaterThan(0);
    });

    it("AdminListCreditRequestsQueryDto accepts valid status", async () => {
      expect(
        await errorsFor(AdminListCreditRequestsQueryDto, { status: "PENDING" }),
      ).toHaveLength(0);
    });
  });
});
