jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock("@nestjs/jwt", () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminDashboardService } from "./admin-dashboard.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";

describe("AdminDashboardController", () => {
  let controller: AdminDashboardController;

  const mockOverview = {
    period: { from: "2026-10-06", to: "2026-10-06" },
    customers: { total: 0, new: 0, active: 0, withActivePlan: 0 },
    orders: { total: 0, pending: 0, confirmed: 0, processing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, failed: 0 },
    sales: { totalPaise: 0, buyOncePaise: 0, trialPaise: 0, monthlyPaise: 0 },
    revenue: { collectedPaise: 0, walletPaise: 0, cashPaise: 0, buyOncePaise: 0, trialPaise: 0, monthlyPaise: 0, walletTopUpsPaise: 0, pendingCashPaise: 0, refundsPaise: 0 },
    plans: { activeMonthly: 0, activeTrial: 0, buyOnceCustomers: 0, newSelections: 0 },
    deliveries: { scheduled: 0, delivered: 0, skipped: 0, cancelled: 0, failed: 0, completionPercent: 0 },
    wallet: { totalCustomerBalancePaise: 0, walletTopUpsPaise: 0 },
    profit: { salesPaise: 0, productCostPaise: 0, deliveryCostPaise: 0, grossProfitPaise: 0, grossMarginPercent: 0 },
    alerts: { pendingCashCollections: 0, pendingWalletApprovals: 0, pendingDeliveryChangeRequests: 0, failedOrders: 0 },
    comparison: { previousPeriod: { from: "2026-10-05", to: "2026-10-05" }, customersNewChangePercent: 0, ordersChangePercent: 0, salesChangePercent: 0, revenueChangePercent: 0, grossProfitChangePercent: 0 },
    trend: { daily: [] },
  };

  const mockService = {
    getOverview: jest.fn().mockResolvedValue(mockOverview),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminDashboardController],
      providers: [{ provide: AdminDashboardService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AdminDashboardController>(AdminDashboardController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  // ── Auth wiring ──

  it("is protected by JwtAuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", AdminDashboardController);
    expect(guards).toContain(JwtAuthGuard);
  });

  it("requires the ADMIN role", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminDashboardController);
    expect(roles).toEqual(["ADMIN"]);
  });

  it("serves both the versioned and legacy admin prefix", () => {
    expect(Reflect.getMetadata("path", AdminDashboardController)).toEqual([
      "api/v1/admin/dashboard",
      "admin/dashboard",
    ]);
  });

  // ── getOverview ──

  it("calls service.getOverview and returns result", async () => {
    const result = await controller.getOverview({});
    expect(mockService.getOverview).toHaveBeenCalledWith({});
    expect(result).toEqual(mockOverview);
  });

  it("passes query params through to service", async () => {
    const query = { from: "2026-10-01", to: "2026-10-05" };
    await controller.getOverview(query);
    expect(mockService.getOverview).toHaveBeenCalledWith(query);
  });
});
