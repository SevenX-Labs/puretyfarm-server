jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock("@nestjs/jwt", () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ManageDeliveryController } from "./manage-delivery.controller";
import { AdminManageDeliveryController } from "./admin-manage-delivery.controller";
import { ManageDeliveryService } from "./manage-delivery.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ChangeQuantityDto } from "./dto/customer/change-quantity.dto";
import { SkipDeliveryDto } from "./dto/customer/skip-delivery.dto";
import { RejectRequestDto } from "./dto/admin/reject-request.dto";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { Roles } from "../../common/decorators/roles.decorator";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";

describe("ManageDeliveryController", () => {
  let controller: ManageDeliveryController;

  const mockService = {
    getManageDelivery: jest.fn().mockResolvedValue({ activePlan: {} }),
    skipDelivery: jest.fn().mockResolvedValue({ success: true }),
    pauseDelivery: jest.fn().mockResolvedValue({ success: true }),
    resumeDelivery: jest.fn().mockResolvedValue({ success: true }),
    changeQuantity: jest.fn().mockResolvedValue({ success: true }),
    changeFrequency: jest.fn().mockResolvedValue({ success: true }),
    changePlan: jest.fn().mockResolvedValue({ success: true }),
    changeSchedule: jest.fn().mockResolvedValue({ success: true }),
    getCustomerRequests: jest.fn().mockResolvedValue([]),
    getCustomerRequest: jest.fn().mockResolvedValue({}),
    getAdminRequests: jest.fn().mockResolvedValue({ data: [] }),
    getAdminRequest: jest.fn().mockResolvedValue({}),
    approveRequest: jest.fn().mockResolvedValue({ success: true }),
    rejectRequest: jest.fn().mockResolvedValue({ success: true }),
  };

  const customerJwt = {
    sub: "user-1",
    role: "CUSTOMER",
    sessionId: "session-1",
    type: "access" as const,
  };

  const adminJwt = {
    sub: "admin-1",
    role: "ADMIN",
    sessionId: "session-2",
    type: "access" as const,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ManageDeliveryController, AdminManageDeliveryController],
      providers: [{ provide: ManageDeliveryService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(ManageDeliveryController);
  });

  // ── Customer controller ──

  it("is protected by JwtAuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", ManageDeliveryController);
    expect(guards).toContain(JwtAuthGuard);
  });

  describe("customer endpoints use JWT.sub as identity", () => {
    it("GET delegates with user.sub", async () => {
      await controller.getManageDelivery(customerJwt);
      expect(mockService.getManageDelivery).toHaveBeenCalledWith("user-1");
    });

    it("skip delegates with user.sub", async () => {
      await controller.skip(customerJwt, { deliveryDate: "2026-10-10" });
      expect(mockService.skipDelivery).toHaveBeenCalledWith("user-1", {
        deliveryDate: "2026-10-10",
      });
    });

    it("pause delegates with user.sub", async () => {
      await controller.pause(customerJwt, {});
      expect(mockService.pauseDelivery).toHaveBeenCalledWith("user-1", {});
    });

    it("resume delegates with user.sub and takes no body", async () => {
      await controller.resume(customerJwt);
      expect(mockService.resumeDelivery).toHaveBeenCalledWith("user-1");
    });

    it("change-quantity delegates with user.sub", async () => {
      await controller.changeQuantity(customerJwt, { quantityLitres: 3 });
      expect(mockService.changeQuantity).toHaveBeenCalledWith("user-1", {
        quantityLitres: 3,
      });
    });

    it("change-frequency delegates with user.sub", async () => {
      await controller.changeFrequency(customerJwt, { frequency: "DAILY" } as any);
      expect(mockService.changeFrequency).toHaveBeenCalledWith("user-1", {
        frequency: "DAILY",
      });
    });

    it("change-plan delegates with user.sub", async () => {
      await controller.changePlan(customerJwt, { planType: "BUY_ONCE" } as any);
      expect(mockService.changePlan).toHaveBeenCalledWith("user-1", {
        planType: "BUY_ONCE",
      });
    });

    it("change-schedule delegates with user.sub", async () => {
      const dto = { frequency: "DAILY", quantityMode: "FIXED", quantity: 2 } as any;
      await controller.changeSchedule(customerJwt, dto);
      expect(mockService.changeSchedule).toHaveBeenCalledWith("user-1", dto);
    });

    it("GET requests delegates with user.sub", async () => {
      await controller.getRequests(customerJwt);
      expect(mockService.getCustomerRequests).toHaveBeenCalledWith("user-1");
    });

    it("GET requests/:id delegates with user.sub", async () => {
      await controller.getRequest(customerJwt, "req-1");
      expect(mockService.getCustomerRequest).toHaveBeenCalledWith("user-1", "req-1");
    });
  });

  describe("DTO validation", () => {
    async function errorsFor(cls: any, payload: any) {
      return validate(plainToInstance(cls, payload));
    }

    it("accepts quantityLitres 1 and 5", async () => {
      expect(await errorsFor(ChangeQuantityDto, { quantityLitres: 1 })).toHaveLength(0);
      expect(await errorsFor(ChangeQuantityDto, { quantityLitres: 5 })).toHaveLength(0);
    });

    it("rejects quantityLitres 0 and 6", async () => {
      expect((await errorsFor(ChangeQuantityDto, { quantityLitres: 0 })).length).toBeGreaterThan(0);
      expect((await errorsFor(ChangeQuantityDto, { quantityLitres: 6 })).length).toBeGreaterThan(0);
    });

    it("rejects a malformed skip date", async () => {
      expect((await errorsFor(SkipDeliveryDto, { deliveryDate: "not-a-date" })).length).toBeGreaterThan(0);
    });

    it("rejects empty rejection note", async () => {
      expect((await errorsFor(RejectRequestDto, { note: "" })).length).toBeGreaterThan(0);
      expect((await errorsFor(RejectRequestDto, { note: "   " })).length).toBeGreaterThan(0);
    });

    it("accepts valid rejection note", async () => {
      expect(await errorsFor(RejectRequestDto, { note: "Area capacity full" })).toHaveLength(0);
    });
  });
});

describe("AdminManageDeliveryController", () => {
  let adminController: AdminManageDeliveryController;

  const mockService = {
    getAdminRequests: jest.fn().mockResolvedValue({ data: [] }),
    getAdminRequest: jest.fn().mockResolvedValue({}),
    approveRequest: jest.fn().mockResolvedValue({ success: true }),
    rejectRequest: jest.fn().mockResolvedValue({ success: true }),
  };

  const adminJwt = {
    sub: "admin-1",
    role: "ADMIN",
    sessionId: "session-2",
    type: "access" as const,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminManageDeliveryController],
      providers: [{ provide: ManageDeliveryService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    adminController = module.get(AdminManageDeliveryController);
  });

  it("is protected by JwtAuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", AdminManageDeliveryController);
    expect(guards).toContain(JwtAuthGuard);
  });

  it("requires ADMIN role", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminManageDeliveryController);
    expect(roles).toContain("ADMIN");
  });

  describe("admin endpoints use JWT.sub as identity", () => {
    it("approve uses admin.sub", async () => {
      await adminController.approve(adminJwt, "req-1");
      expect(mockService.approveRequest).toHaveBeenCalledWith("admin-1", "req-1");
    });

    it("reject uses admin.sub", async () => {
      await adminController.reject(adminJwt, "req-1", { note: "reason" });
      expect(mockService.rejectRequest).toHaveBeenCalledWith(
        "admin-1",
        "req-1",
        { note: "reason" },
      );
    });

    it("customer JWT cannot access admin endpoint (guard+roles enforced)", () => {
      const roles = Reflect.getMetadata(ROLES_KEY, AdminManageDeliveryController);
      expect(roles).toContain("ADMIN");
      expect(roles).not.toContain("CUSTOMER");
    });
  });

  it("list delegates to service", async () => {
    await adminController.listRequests({});
    expect(mockService.getAdminRequests).toHaveBeenCalledWith({});
  });

  it("get delegates to service", async () => {
    await adminController.getRequest("req-1");
    expect(mockService.getAdminRequest).toHaveBeenCalledWith("req-1");
  });
});
