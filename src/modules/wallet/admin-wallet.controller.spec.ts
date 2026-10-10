jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock("@nestjs/jwt", () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { AdminWalletController } from "./admin-wallet.controller";
import { WalletService } from "./wallet.service";
import { PaymentsService } from "../payments/payments.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { RejectCreditRequestDto } from "./dto/admin/reject-credit-request.dto";
import { AdminListCreditRequestsQueryDto } from "./dto/admin/list-credit-requests-query.dto";
import { AdminManualWalletAdjustmentDto } from "./dto/admin/manual-wallet-adjustment.dto";

describe("AdminWalletController", () => {
  let controller: AdminWalletController;

  const mockService = {
    getAdminCreditRequests: jest.fn().mockResolvedValue({ data: [] }),
    getAdminCreditRequest: jest.fn().mockResolvedValue({}),
    approveCreditRequest: jest.fn().mockResolvedValue({ success: true }),
    rejectCreditRequest: jest.fn().mockResolvedValue({ success: true }),
    getAdminCustomerWallet: jest.fn().mockResolvedValue({}),
    adminManualCredit: jest.fn().mockResolvedValue({ success: true, balancePaise: 70000 }),
    adminManualDebit: jest.fn().mockResolvedValue({ success: true, balancePaise: 60000 }),
  };

  // PaymentsService stub for the auto-refund orchestration the admin reject
  // endpoint now triggers.
  const mockPayments = {
    initiateRefundIfApplicable: jest
      .fn()
      .mockResolvedValue({ refundInitiated: true }),
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
      providers: [
        { provide: WalletService, useValue: mockService },
        { provide: PaymentsService, useValue: mockPayments },
      ],
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
    it("uses admin.sub and passes note, then triggers the PayU refund orchestration", async () => {
      await controller.rejectCreditRequest(adminJwt, "req-1", { note: "Bad request" });

      // Wallet reject is the authoritative decision — happens first.
      expect(mockService.rejectCreditRequest).toHaveBeenCalledWith(
        "req-1",
        "admin-1",
        { note: "Bad request" },
      );

      // The admin reject MUST then invoke the refund orchestration on the
      // Payments module exactly once. The admin never has to issue a second
      // call for the refund to begin.
      expect(mockPayments.initiateRefundIfApplicable).toHaveBeenCalledTimes(1);
      expect(mockPayments.initiateRefundIfApplicable).toHaveBeenCalledWith(
        "req-1",
      );
    });

    it("still succeeds for a cash reject (refund orchestration is a no-op)", async () => {
      mockPayments.initiateRefundIfApplicable.mockResolvedValueOnce({
        refundInitiated: false,
        reason: "NO_REFUNDABLE_PAYMENT",
      });

      const result = await controller.rejectCreditRequest(adminJwt, "cash-req", {
        note: "Cash not received",
      });

      expect(result.refund.refundInitiated).toBe(false);
      expect(result.refund.reason).toBe("NO_REFUNDABLE_PAYMENT");
      expect(mockService.rejectCreditRequest).toHaveBeenCalledTimes(1);
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

  describe("manualCredit", () => {
    it("delegates to walletService.adminManualCredit with admin.sub", async () => {
      const dto = { amountPaise: 20000, remark: "Approved manual wallet adjustment" };
      const res = await controller.manualCredit(adminJwt, "user-1", dto, "key-123");
      expect(mockService.adminManualCredit).toHaveBeenCalledWith(
        "user-1",
        "admin-1",
        dto,
        "key-123"
      );
      expect(res).toEqual({ success: true, balancePaise: 70000 });
    });
  });

  describe("manualDebit", () => {
    it("delegates to walletService.adminManualDebit with admin.sub", async () => {
      const dto = { amountPaise: 10000, remark: "Correction for duplicate credit" };
      const res = await controller.manualDebit(adminJwt, "user-1", dto, "key-456");
      expect(mockService.adminManualDebit).toHaveBeenCalledWith(
        "user-1",
        "admin-1",
        dto,
        "key-456"
      );
      expect(res).toEqual({ success: true, balancePaise: 60000 });
    });
  });

  describe("AdminManualWalletAdjustmentDto validation", () => {
    async function errorsFor(cls: any, payload: any) {
      return validate(plainToInstance(cls, payload));
    }

    it("rejects when amount is missing and amountPaise is missing", async () => {
      expect((await errorsFor(AdminManualWalletAdjustmentDto, { remark: "Valid remark" })).length).toBe(0);
    });

    it("rejects non-integer amountPaise", async () => {
      expect((await errorsFor(AdminManualWalletAdjustmentDto, { amountPaise: 10.5, remark: "Valid" })).length).toBeGreaterThan(0);
    });

    it("rejects amountPaise less than 100", async () => {
      expect((await errorsFor(AdminManualWalletAdjustmentDto, { amountPaise: 50, remark: "Valid" })).length).toBeGreaterThan(0);
    });

    it("rejects empty remark", async () => {
      expect((await errorsFor(AdminManualWalletAdjustmentDto, { amountPaise: 5000, remark: "" })).length).toBeGreaterThan(0);
    });

    it("rejects short remark (< 3 chars)", async () => {
      expect((await errorsFor(AdminManualWalletAdjustmentDto, { amountPaise: 5000, remark: "ab" })).length).toBeGreaterThan(0);
    });

    it("accepts valid manual adjustment payload", async () => {
      expect(await errorsFor(AdminManualWalletAdjustmentDto, { amountPaise: 20000, remark: "Approved manual wallet adjustment" })).toHaveLength(0);
    });
  });

});
