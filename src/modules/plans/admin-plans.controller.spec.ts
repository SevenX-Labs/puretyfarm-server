// @nestjs/config and @nestjs/jwt ship ESM-only; mock them so the CommonJS test
// runner can load the JwtAuthGuard imported by the controller.
jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock("@nestjs/jwt", () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { AdminPlansController } from "./admin-plans.controller";
import { PlansController } from "./plans.controller";
import { PlansService } from "./plans.service";
import { PlanType } from "./plans.constants";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";

describe("AdminPlansController", () => {
  let controller: AdminPlansController;

  const mockService = {
    getAdminPlans: jest.fn().mockResolvedValue({ plans: [], unconfigured: [] }),
    getAdminPlan: jest.fn().mockResolvedValue({ type: PlanType.BUY_ONCE }),
    updateAdminPlan: jest.fn().mockResolvedValue({ type: PlanType.BUY_ONCE }),
    adminApproveSubscription: jest.fn().mockResolvedValue({ success: true }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminPlansController],
      providers: [{ provide: PlansService, useValue: mockService }],
    })
      // RBAC behaviour is exercised end-to-end in the integration suite.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AdminPlansController>(AdminPlansController);
  });

  // ----- Auth wiring --------------------------------------------------------

  it("is protected by JwtAuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", AdminPlansController);
    expect(guards).toContain(JwtAuthGuard);
  });

  it("requires the ADMIN role (so a customer token is rejected with 403)", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminPlansController);
    expect(roles).toEqual(["ADMIN"]);
  });

  it("serves both the versioned and the legacy admin prefix", () => {
    expect(Reflect.getMetadata("path", AdminPlansController)).toEqual([
      "api/v1/admin/plans",
      "admin/plans",
    ]);
  });

  it("leaves the customer plans controller's route untouched", () => {
    expect(Reflect.getMetadata("path", PlansController)).toEqual([
      "api/v1/customer/plans",
      "customer/plans",
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, PlansController)).toBeUndefined();
  });

  it("exposes no create or delete route (plan types are fixed)", () => {
    const methods = Object.getOwnPropertyNames(AdminPlansController.prototype);
    expect(methods.sort()).toEqual(
      ["constructor", "getPlan", "getPlans", "getSubscriptions", "updatePlan", "approveSubscription", "updateSubscriptionStartDate"].sort(),
    );
  });

  // ----- Delegation ---------------------------------------------------------

  it("getPlans delegates to the service", async () => {
    await controller.getPlans();
    expect(mockService.getAdminPlans).toHaveBeenCalled();
  });

  it("getPlan delegates with planType", async () => {
    await controller.getPlan(PlanType.MONTHLY);
    expect(mockService.getAdminPlan).toHaveBeenCalledWith(PlanType.MONTHLY);
  });

  it("updatePlan delegates with planType + raw body (validated in service)", async () => {
    const body = { sellingPricePerLitre: 8500 };
    await controller.updatePlan(PlanType.BUY_ONCE, body);
    expect(mockService.updateAdminPlan).toHaveBeenCalledWith(
      PlanType.BUY_ONCE,
      body,
    );
  });

  // ----- planType param -----------------------------------------------------

  describe("planType param pipe", () => {
    const pipe = () => {
      const params = Reflect.getMetadata(
        "__routeArguments__",
        AdminPlansController,
        "getPlan",
      );
      return (Object.values(params)[0] as any).pipes[0];
    };

    it.each(Object.values(PlanType))("accepts %s", async (t) => {
      await expect(pipe().transform(t, { type: "param" })).resolves.toBe(t);
    });

    it.each(["TRIAL", "buy_once", "WEEKLY", ""])(
      "rejects %p with 400",
      async (t) => {
        await expect(pipe().transform(t, { type: "param" })).rejects.toThrow(
          BadRequestException,
        );
      },
    );
  });

  it("approveSubscription delegates with admin sub, subscription id, and dto", async () => {
    const dto = { firstDeliveryDate: "2026-10-15", note: "Approved" };
    const admin = { sub: "admin-1", mobile: "9876543210", role: "ADMIN" } as any;
    await controller.approveSubscription(admin, "sub-1", dto);
    expect(mockService.adminApproveSubscription).toHaveBeenCalledWith("admin-1", "sub-1", dto);
  });

  it("updateSubscriptionStartDate delegates with admin sub, subscription id, and dto", async () => {
    const dto = { firstDeliveryDate: "2026-10-16" };
    const admin = { sub: "admin-1", mobile: "9876543210", role: "ADMIN" } as any;
    await controller.updateSubscriptionStartDate(admin, "sub-2", dto);
    expect(mockService.adminApproveSubscription).toHaveBeenCalledWith("admin-1", "sub-2", dto);
  });

});
