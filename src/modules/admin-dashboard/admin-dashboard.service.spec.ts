import { Test, TestingModule } from "@nestjs/testing";
import { AdminDashboardService } from "./admin-dashboard.service";
import { PrismaService } from "../../prisma/prisma.service";

describe("AdminDashboardService", () => {
  let service: AdminDashboardService;

  const mockPrisma: any = {
    user: { count: jest.fn() },
    planSelection: {
      groupBy: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    order: {
      groupBy: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
      findMany: jest.fn(),
    },
    planDelivery: { groupBy: jest.fn() },
    wallet: { aggregate: jest.fn() },
    walletTransaction: { aggregate: jest.fn() },
    walletCreditRequest: { count: jest.fn() },
    cashCollection: {
      aggregate: jest.fn(),
      count: jest.fn(),
    },
    payment: { aggregate: jest.fn() },
    manageDeliveryChangeRequest: { count: jest.fn() },
    $queryRaw: jest.fn(),
  };

  const EMPTY_AGGREGATE = { _sum: {} };

  function setupDefaultMocks() {
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.planSelection.groupBy.mockResolvedValue([]);
    mockPrisma.planSelection.findMany.mockResolvedValue([]);
    mockPrisma.planSelection.count.mockResolvedValue(0);
    mockPrisma.planSelection.aggregate.mockResolvedValue(EMPTY_AGGREGATE);
    mockPrisma.order.groupBy.mockResolvedValue([]);
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.order.aggregate.mockResolvedValue(EMPTY_AGGREGATE);
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.planDelivery.groupBy.mockResolvedValue([]);
    mockPrisma.wallet.aggregate.mockResolvedValue(EMPTY_AGGREGATE);
    mockPrisma.walletTransaction.aggregate.mockResolvedValue(EMPTY_AGGREGATE);
    mockPrisma.walletCreditRequest.count.mockResolvedValue(0);
    mockPrisma.cashCollection.aggregate.mockResolvedValue(EMPTY_AGGREGATE);
    mockPrisma.cashCollection.count.mockResolvedValue(0);
    mockPrisma.payment.aggregate.mockResolvedValue(EMPTY_AGGREGATE);
    mockPrisma.manageDeliveryChangeRequest.count.mockResolvedValue(0);
    mockPrisma.$queryRaw.mockResolvedValue([]);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminDashboardService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AdminDashboardService>(AdminDashboardService);
    setupDefaultMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("getOverview", () => {
    it("returns complete dashboard structure with default date", async () => {
      const result = await service.getOverview({});
      expect(result).toHaveProperty("period");
      expect(result).toHaveProperty("customers");
      expect(result).toHaveProperty("orders");
      expect(result).toHaveProperty("sales");
      expect(result).toHaveProperty("revenue");
      expect(result).toHaveProperty("plans");
      expect(result).toHaveProperty("deliveries");
      expect(result).toHaveProperty("wallet");
      expect(result).toHaveProperty("profit");
      expect(result).toHaveProperty("alerts");
      expect(result).toHaveProperty("comparison");
      expect(result).toHaveProperty("trend");
    });

    it("uses current day when from/to omitted", async () => {
      const result = await service.getOverview({});
      const today = new Date().toISOString().slice(0, 10);
      expect(result.period.from).toBe(today);
      expect(result.period.to).toBe(today);
    });

    it("uses provided from/to dates", async () => {
      const result = await service.getOverview({ from: "2026-10-01", to: "2026-10-05" });
      expect(result.period.from).toBe("2026-10-01");
      expect(result.period.to).toBe("2026-10-05");
    });
  });

  // ── Customers ──

  describe("customers", () => {
    it("counts total customers with role CUSTOMER", async () => {
      mockPrisma.user.count.mockResolvedValue(42);
      const result = await service.getOverview({});
      expect(result.customers.total).toBe(42);
      expect(mockPrisma.user.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { role: "CUSTOMER" } }),
      );
    });

    it("counts new customers created in period", async () => {
      mockPrisma.user.count.mockImplementation(({ where }: any) => {
        if (where.createdAt) return Promise.resolve(5);
        return Promise.resolve(100);
      });
      const result = await service.getOverview({ from: "2026-10-01", to: "2026-10-05" });
      expect(result.customers.new).toBe(5);
    });

    it("counts customers with active plan", async () => {
      mockPrisma.planSelection.findMany.mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]);
      mockPrisma.order.findMany.mockResolvedValue([]);
      const result = await service.getOverview({});
      expect(result.customers.withActivePlan).toBe(2);
    });

    it("defines active as customers with active plan or qualifying orders", async () => {
      mockPrisma.planSelection.findMany.mockResolvedValue([{ userId: "u1" }]);
      mockPrisma.order.findMany.mockResolvedValue([{ userId: "u2" }]);
      const result = await service.getOverview({});
      expect(result.customers.active).toBe(2);
    });

    it("does not double-count a customer active by both plan and order", async () => {
      mockPrisma.planSelection.findMany.mockResolvedValue([{ userId: "u1" }]);
      mockPrisma.order.findMany.mockResolvedValue([{ userId: "u1" }]);
      const result = await service.getOverview({});
      expect(result.customers.active).toBe(1);
    });
  });

  // ── Orders ──

  describe("orders", () => {
    it("groups orders by status within the period", async () => {
      mockPrisma.order.groupBy.mockImplementation(({ where }: any) => {
        if (where?.createdAt) {
          return Promise.resolve([
            { status: "PENDING", _count: { id: 3 } },
            { status: "CONFIRMED", _count: { id: 5 } },
            { status: "DELIVERED", _count: { id: 10 } },
            { status: "CANCELLED", _count: { id: 2 } },
            { status: "FAILED", _count: { id: 1 } },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.getOverview({ from: "2026-10-01", to: "2026-10-05" });
      expect(result.orders.total).toBe(21);
      expect(result.orders.pending).toBe(3);
      expect(result.orders.confirmed).toBe(5);
      expect(result.orders.delivered).toBe(10);
      expect(result.orders.cancelled).toBe(2);
      expect(result.orders.failed).toBe(1);
      expect(result.orders.processing).toBe(0);
      expect(result.orders.outForDelivery).toBe(0);
    });

    it("returns zero for all statuses when no orders exist", async () => {
      const result = await service.getOverview({});
      expect(result.orders.total).toBe(0);
      expect(result.orders.pending).toBe(0);
    });
  });

  // ── Sales ──

  describe("sales", () => {
    it("aggregates plan selections by planType using paidAmountPaise", async () => {
      mockPrisma.planSelection.groupBy.mockImplementation(({ by, where }: any) => {
        if (by?.includes("planType") && where?.paidAt) {
          return Promise.resolve([
            { planType: "BUY_ONCE", _sum: { paidAmountPaise: 50000 } },
            { planType: "MONTHLY", _sum: { paidAmountPaise: 200000 } },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.getOverview({ from: "2026-10-01", to: "2026-10-05" });
      expect(result.sales.buyOncePaise).toBe(50000);
      expect(result.sales.monthlyPaise).toBe(200000);
      expect(result.sales.trialPaise).toBe(0);
      expect(result.sales.totalPaise).toBe(250000);
    });

    it("excludes CANCELLED and PENDING_PAYMENT selections from sales", async () => {
      mockPrisma.planSelection.groupBy.mockImplementation(({ where }: any) => {
        if (where?.paidAt && where?.status) {
          expect(where.status.notIn).toContain("CANCELLED");
          expect(where.status.notIn).toContain("PENDING_PAYMENT");
        }
        return Promise.resolve([]);
      });
      await service.getOverview({});
    });
  });

  // ── Revenue ──
  //
  // Revenue is sourced from the paid PlanSelection itself (paidAmountPaise +
  // paymentMethod), counted exactly once per purchase. It is NOT summed from the
  // wallet/cash ledger, which would double-count cash plans (Cash collection +
  // the PLAN_SELECTION wallet debit from the Cash -> Wallet CREDIT -> Plan DEBIT
  // flow). See the "cash double-count regression" block below.

  // Mocks planSelection.groupBy for the revenue/sales paths.
  function mockPaidPlanGroupBy(opts: {
    byMethod?: { paymentMethod: string | null; paidAmountPaise: number }[];
    byType?: { planType: string; paidAmountPaise: number }[];
  }) {
    mockPrisma.planSelection.groupBy.mockImplementation(({ by, where }: any) => {
      if (!where?.paidAt) return Promise.resolve([]);
      if (by?.includes("paymentMethod")) {
        return Promise.resolve(
          (opts.byMethod ?? []).map((r) => ({
            paymentMethod: r.paymentMethod,
            _sum: { paidAmountPaise: r.paidAmountPaise },
          })),
        );
      }
      if (by?.includes("planType")) {
        return Promise.resolve(
          (opts.byType ?? []).map((r) => ({
            planType: r.planType,
            _sum: { paidAmountPaise: r.paidAmountPaise },
          })),
        );
      }
      return Promise.resolve([]);
    });
  }

  describe("revenue", () => {
    it("calculates wallet plan revenue from paid WALLET plan selections plus standalone ORDER debits", async () => {
      mockPaidPlanGroupBy({
        byMethod: [{ paymentMethod: "WALLET", paidAmountPaise: 100000 }],
        byType: [{ planType: "MONTHLY", paidAmountPaise: 100000 }],
      });
      mockPrisma.walletTransaction.aggregate.mockImplementation(({ where }: any) => {
        if (where?.type === "DEBIT" && where?.referenceType === "ORDER") {
          return Promise.resolve({ _sum: { amountPaise: 20000 } });
        }
        if (where?.type === "CREDIT" && where?.referenceType === "CREDIT_REQUEST") {
          return Promise.resolve({ _sum: { amountPaise: 500000 } });
        }
        return Promise.resolve(EMPTY_AGGREGATE);
      });

      const result = await service.getOverview({});
      // 100000 wallet-funded plan + 20000 standalone order debit
      expect(result.revenue.walletPaise).toBe(120000);
      expect(result.revenue.cashPaise).toBe(0);
      expect(result.revenue.collectedPaise).toBe(120000);
      expect(result.revenue.walletTopUpsPaise).toBe(500000);
    });

    it("calculates cash plan revenue from paid CASH plan selections (once), not from the ledger", async () => {
      mockPaidPlanGroupBy({
        byMethod: [{ paymentMethod: "CASH", paidAmountPaise: 75000 }],
        byType: [{ planType: "BUY_ONCE", paidAmountPaise: 75000 }],
      });
      // The ledger still shows BOTH a CONFIRMED cash collection AND a
      // PLAN_SELECTION wallet debit for this cash plan — neither must be
      // summed into revenue, or the cash plan would be double-counted.
      mockPrisma.cashCollection.aggregate.mockImplementation(({ where }: any) => {
        if (where?.planSelectionId && where?.status === "CONFIRMED") {
          return Promise.resolve({ _sum: { amountPaise: 75000 } });
        }
        return Promise.resolve(EMPTY_AGGREGATE);
      });
      mockPrisma.walletTransaction.aggregate.mockImplementation(({ where }: any) => {
        if (where?.type === "DEBIT" && where?.referenceType === "PLAN_SELECTION") {
          return Promise.resolve({ _sum: { amountPaise: 75000 } });
        }
        return Promise.resolve(EMPTY_AGGREGATE);
      });

      const result = await service.getOverview({});
      expect(result.revenue.cashPaise).toBe(75000);
      expect(result.revenue.walletPaise).toBe(0);
      expect(result.revenue.collectedPaise).toBe(75000);
    });

    it("does not count wallet top-ups as revenue", async () => {
      mockPrisma.walletTransaction.aggregate.mockImplementation(({ where }: any) => {
        if (where?.type === "CREDIT") return Promise.resolve({ _sum: { amountPaise: 999999 } });
        return Promise.resolve(EMPTY_AGGREGATE);
      });
      mockPrisma.cashCollection.aggregate.mockResolvedValue(EMPTY_AGGREGATE);
      mockPrisma.payment.aggregate.mockResolvedValue(EMPTY_AGGREGATE);

      const result = await service.getOverview({});
      expect(result.revenue.collectedPaise).toBe(0);
    });

    it("surfaces refunds separately from collected revenue", async () => {
      mockPrisma.walletTransaction.aggregate.mockResolvedValue(EMPTY_AGGREGATE);
      mockPrisma.cashCollection.aggregate.mockResolvedValue(EMPTY_AGGREGATE);
      mockPrisma.payment.aggregate.mockImplementation(({ where }: any) => {
        if (where?.status === "REFUNDED") {
          return Promise.resolve({ _sum: { amountPaise: 10000 } });
        }
        return Promise.resolve(EMPTY_AGGREGATE);
      });

      const result = await service.getOverview({});
      expect(result.revenue.refundsPaise).toBe(10000);
    });

    it("categorises revenue by plan type from paid plan selections", async () => {
      mockPaidPlanGroupBy({
        byMethod: [
          { paymentMethod: "CASH", paidAmountPaise: 50000 },
          { paymentMethod: "WALLET", paidAmountPaise: 300000 },
        ],
        byType: [
          { planType: "BUY_ONCE", paidAmountPaise: 50000 },
          { planType: "SEVEN_DAY_TRIAL", paidAmountPaise: 100000 },
          { planType: "MONTHLY", paidAmountPaise: 200000 },
        ],
      });

      const result = await service.getOverview({});
      expect(result.revenue.buyOncePaise).toBe(50000);
      expect(result.revenue.trialPaise).toBe(100000);
      expect(result.revenue.monthlyPaise).toBe(200000);
      expect(result.revenue.collectedPaise).toBe(350000);
    });
  });

  // ── Cash plan double-count regression (Issue 1) ──

  describe("cash double-count regression", () => {
    it("a single ₹500 cash plan increases collectedPaise by exactly 50000, not 100000", async () => {
      // One ₹500 cash plan confirmed. Its ledger footprint is:
      //   CashCollection CONFIRMED = 50000
      //   WalletTransaction CREDIT (CASH_COLLECTION) = 50000
      //   WalletTransaction DEBIT  (PLAN_SELECTION)  = 50000
      //   PlanSelection paidAmountPaise = 50000, paymentMethod = CASH
      // The old aggregation summed the cash collection AND the plan debit =
      // 100000. The corrected one counts the single paid plan selection = 50000.
      mockPaidPlanGroupBy({
        byMethod: [{ paymentMethod: "CASH", paidAmountPaise: 50000 }],
        byType: [{ planType: "BUY_ONCE", paidAmountPaise: 50000 }],
      });
      mockPrisma.cashCollection.aggregate.mockImplementation(({ where }: any) => {
        if (where?.planSelectionId && where?.status === "CONFIRMED") {
          return Promise.resolve({ _sum: { amountPaise: 50000 } });
        }
        return Promise.resolve(EMPTY_AGGREGATE);
      });
      mockPrisma.walletTransaction.aggregate.mockImplementation(({ where }: any) => {
        if (where?.type === "DEBIT" && where?.referenceType === "PLAN_SELECTION") {
          return Promise.resolve({ _sum: { amountPaise: 50000 } });
        }
        return Promise.resolve(EMPTY_AGGREGATE);
      });

      const result = await service.getOverview({});

      expect(result.revenue.collectedPaise).toBe(50000);
      expect(result.revenue.collectedPaise).not.toBe(100000);
      expect(result.revenue.cashPaise).toBe(50000);
      expect(result.revenue.walletPaise).toBe(0);
      // Sales also reflects exactly one ₹500 purchase.
      expect(result.sales.totalPaise).toBe(50000);
      // Wallet top-ups are unaffected by a cash plan purchase.
      expect(result.revenue.walletTopUpsPaise).toBe(0);
    });
  });

  // ── Wallet ──

  describe("wallet", () => {
    it("sums all customer wallet balances", async () => {
      mockPrisma.wallet.aggregate.mockResolvedValue({ _sum: { balancePaise: 350000 } });
      const result = await service.getOverview({});
      expect(result.wallet.totalCustomerBalancePaise).toBe(350000);
    });

    it("calculates wallet top-ups from CREDIT transactions with CREDIT_REQUEST reference", async () => {
      mockPrisma.walletTransaction.aggregate.mockImplementation(({ where }: any) => {
        if (where?.type === "CREDIT" && where?.referenceType === "CREDIT_REQUEST") {
          return Promise.resolve({ _sum: { amountPaise: 100000 } });
        }
        return Promise.resolve(EMPTY_AGGREGATE);
      });
      const result = await service.getOverview({});
      expect(result.wallet.walletTopUpsPaise).toBe(100000);
    });
  });

  // ── Plans ──

  describe("plans", () => {
    it("counts active monthly and trial plans", async () => {
      mockPrisma.planSelection.groupBy.mockImplementation(({ where }: any) => {
        if (where?.status === "ACTIVE") {
          return Promise.resolve([
            { planType: "MONTHLY", _count: { id: 15 } },
            { planType: "SEVEN_DAY_TRIAL", _count: { id: 3 } },
          ]);
        }
        if (where?.planType === "BUY_ONCE") {
          return Promise.resolve([{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }]);
        }
        return Promise.resolve([]);
      });
      mockPrisma.planSelection.findMany.mockResolvedValue([]);
      mockPrisma.order.findMany.mockResolvedValue([]);

      const result = await service.getOverview({});
      expect(result.plans.activeMonthly).toBe(15);
      expect(result.plans.activeTrial).toBe(3);
    });

    it("counts unique buy-once customers", async () => {
      mockPrisma.planSelection.groupBy.mockImplementation(({ where }: any) => {
        if (where?.planType === "BUY_ONCE") {
          return Promise.resolve([{ userId: "u1" }, { userId: "u2" }]);
        }
        return Promise.resolve([]);
      });
      mockPrisma.planSelection.findMany.mockResolvedValue([]);
      mockPrisma.order.findMany.mockResolvedValue([]);

      const result = await service.getOverview({});
      expect(result.plans.buyOnceCustomers).toBe(2);
    });

    it("counts new plan selections in period", async () => {
      mockPrisma.planSelection.count.mockResolvedValue(7);
      const result = await service.getOverview({});
      expect(result.plans.newSelections).toBe(7);
    });
  });

  // ── Deliveries ──

  describe("deliveries", () => {
    it("groups deliveries by status", async () => {
      mockPrisma.planDelivery.groupBy.mockResolvedValue([
        { status: "SCHEDULED", _count: { id: 20 } },
        { status: "DELIVERED", _count: { id: 50 } },
        { status: "SKIPPED", _count: { id: 5 } },
      ]);

      const result = await service.getOverview({});
      expect(result.deliveries.scheduled).toBe(20);
      expect(result.deliveries.delivered).toBe(50);
      expect(result.deliveries.skipped).toBe(5);
    });

    it("calculates completion percentage correctly", async () => {
      mockPrisma.planDelivery.groupBy.mockResolvedValue([
        { status: "DELIVERED", _count: { id: 80 } },
        { status: "SCHEDULED", _count: { id: 10 } },
        { status: "SKIPPED", _count: { id: 10 } },
      ]);

      const result = await service.getOverview({});
      expect(result.deliveries.completionPercent).toBe(80);
    });

    it("handles zero deliveries without division by zero", async () => {
      const result = await service.getOverview({});
      expect(result.deliveries.completionPercent).toBe(0);
    });

    it("returns 0 for cancelled and failed (not in current schema)", async () => {
      const result = await service.getOverview({});
      expect(result.deliveries.cancelled).toBe(0);
      expect(result.deliveries.failed).toBe(0);
    });
  });

  // ── Profit ──

  describe("profit", () => {
    it("calculates gross profit as sales minus delivery cost", async () => {
      mockPrisma.planSelection.aggregate.mockResolvedValue({ _sum: { paidAmountPaise: 500000 } });
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { deliveryFeePaise: 10000 } });

      const result = await service.getOverview({});
      expect(result.profit.salesPaise).toBe(500000);
      expect(result.profit.deliveryCostPaise).toBe(10000);
      expect(result.profit.grossProfitPaise).toBe(490000);
    });

    it("sets productCostPaise to 0 and costDataAvailable to false", async () => {
      const result = await service.getOverview({});
      expect(result.profit.productCostPaise).toBe(0);
      expect(result.profit.costDataAvailable).toBe(false);
    });

    it("calculates gross margin percentage", async () => {
      mockPrisma.planSelection.aggregate.mockResolvedValue({ _sum: { paidAmountPaise: 100000 } });
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { deliveryFeePaise: 20000 } });

      const result = await service.getOverview({});
      expect(result.profit.grossMarginPercent).toBe(80);
    });

    it("returns 0% margin when sales are zero", async () => {
      const result = await service.getOverview({});
      expect(result.profit.grossMarginPercent).toBe(0);
    });
  });

  // ── Alerts ──

  describe("alerts", () => {
    it("counts pending cash collections", async () => {
      mockPrisma.cashCollection.count.mockResolvedValue(3);
      const result = await service.getOverview({});
      expect(result.alerts.pendingCashCollections).toBe(3);
    });

    it("counts pending wallet approvals", async () => {
      mockPrisma.walletCreditRequest.count.mockResolvedValue(5);
      const result = await service.getOverview({});
      expect(result.alerts.pendingWalletApprovals).toBe(5);
    });

    it("counts pending delivery change requests", async () => {
      mockPrisma.manageDeliveryChangeRequest.count.mockResolvedValue(2);
      const result = await service.getOverview({});
      expect(result.alerts.pendingDeliveryChangeRequests).toBe(2);
    });

    it("counts failed orders", async () => {
      mockPrisma.order.count.mockResolvedValue(1);
      const result = await service.getOverview({});
      expect(result.alerts.failedOrders).toBe(1);
    });
  });

  // ── Comparison ──

  describe("comparison", () => {
    it("calculates previous period with same duration", async () => {
      const result = await service.getOverview({ from: "2026-10-03", to: "2026-10-05" });
      expect(result.comparison.previousPeriod.from).toBe("2026-09-30");
      expect(result.comparison.previousPeriod.to).toBe("2026-10-02");
    });

    it("returns 0% change when both current and previous are zero", async () => {
      const result = await service.getOverview({});
      expect(result.comparison.customersNewChangePercent).toBe(0);
      expect(result.comparison.ordersChangePercent).toBe(0);
      expect(result.comparison.salesChangePercent).toBe(0);
    });

    it("returns 100% when previous is zero but current is not", async () => {
      mockPrisma.user.count.mockImplementation(({ where }: any) => {
        if (where?.createdAt?.gte?.toISOString()?.startsWith("2026-10-06")) return Promise.resolve(5);
        return Promise.resolve(0);
      });

      const result = await service.getOverview({ from: "2026-10-06", to: "2026-10-06" });
      expect(result.comparison.customersNewChangePercent).toBe(100);
    });
  });

  // ── Trend ──

  describe("trend", () => {
    it("returns one entry per day in the period", async () => {
      const result = await service.getOverview({ from: "2026-10-01", to: "2026-10-03" });
      expect(result.trend.daily).toHaveLength(3);
      expect(result.trend.daily[0].date).toBe("2026-10-01");
      expect(result.trend.daily[1].date).toBe("2026-10-02");
      expect(result.trend.daily[2].date).toBe("2026-10-03");
    });

    it("fills missing dates with zero values", async () => {
      const result = await service.getOverview({ from: "2026-10-01", to: "2026-10-02" });
      for (const entry of result.trend.daily) {
        expect(entry.salesPaise).toBe(0);
        expect(entry.revenueCollectedPaise).toBe(0);
        expect(entry.grossProfitPaise).toBe(0);
        expect(entry.orders).toBe(0);
        expect(entry.deliveries).toBe(0);
      }
    });
  });

  // ── Date Filter Validation ──

  describe("date filter", () => {
    it("defaults to current day when no params provided", async () => {
      const result = await service.getOverview({});
      const today = new Date().toISOString().slice(0, 10);
      expect(result.period.from).toBe(today);
      expect(result.period.to).toBe(today);
    });

    it("handles single-day range (from === to)", async () => {
      const result = await service.getOverview({ from: "2026-10-01", to: "2026-10-01" });
      expect(result.period.from).toBe("2026-10-01");
      expect(result.period.to).toBe("2026-10-01");
      expect(result.trend.daily).toHaveLength(1);
    });
  });

  // ── Financial Double-Count Protection ──

  describe("double-count protection", () => {
    it("uses PlanSelection.paidAmountPaise as sales source of truth, not order totals", async () => {
      mockPrisma.planSelection.groupBy.mockImplementation(({ by, where }: any) => {
        if (by?.includes("planType") && where?.paidAt) {
          return Promise.resolve([
            { planType: "MONTHLY", _sum: { paidAmountPaise: 100000 } },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.getOverview({});
      expect(result.sales.totalPaise).toBe(100000);
      // order.aggregate should NOT be called for sales calculation
      const salesCalls = mockPrisma.planSelection.groupBy.mock.calls.filter(
        ([{ by, where }]: any) => by?.includes("planType") && where?.paidAt,
      );
      expect(salesCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("wallet top-up CREDIT transactions never appear in revenue.collectedPaise", async () => {
      mockPrisma.walletTransaction.aggregate.mockImplementation(({ where }: any) => {
        if (where?.type === "CREDIT" && where?.referenceType === "CREDIT_REQUEST") {
          return Promise.resolve({ _sum: { amountPaise: 1000000 } });
        }
        return Promise.resolve(EMPTY_AGGREGATE);
      });
      mockPrisma.cashCollection.aggregate.mockResolvedValue(EMPTY_AGGREGATE);
      mockPrisma.payment.aggregate.mockResolvedValue(EMPTY_AGGREGATE);

      const result = await service.getOverview({});
      expect(result.revenue.collectedPaise).toBe(0);
      expect(result.revenue.walletTopUpsPaise).toBe(1000000);
    });
  });

  // ── Wallet customer-only filtering ──

  describe("wallet customer filtering", () => {
    it("filters wallet balances to CUSTOMER role users", async () => {
      mockPrisma.wallet.aggregate.mockResolvedValue({ _sum: { balancePaise: 200000 } });
      const result = await service.getOverview({});
      expect(result.wallet.totalCustomerBalancePaise).toBe(200000);
      expect(mockPrisma.wallet.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user: { role: "CUSTOMER" } },
        }),
      );
    });
  });

  // ── Profit costDataAvailable ──

  describe("profit costDataAvailable", () => {
    it("always returns costDataAvailable: false since procurement cost is not stored", async () => {
      mockPrisma.planSelection.aggregate.mockResolvedValue({ _sum: { paidAmountPaise: 500000 } });
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { deliveryFeePaise: 5000 } });
      const result = await service.getOverview({});
      expect(result.profit.costDataAvailable).toBe(false);
      expect(result.profit.productCostPaise).toBe(0);
      expect(result.profit.grossProfitPaise).toBe(495000);
    });
  });

  // ── Delivery cost uses immutable order snapshot ──

  describe("delivery cost", () => {
    it("aggregates deliveryFeePaise from orders, excluding CANCELLED and FAILED", async () => {
      mockPrisma.planSelection.aggregate.mockResolvedValue({ _sum: { paidAmountPaise: 100000 } });
      mockPrisma.order.aggregate.mockImplementation(({ where }: any) => {
        if (where?.status?.notIn) {
          expect(where.status.notIn).toContain("CANCELLED");
          expect(where.status.notIn).toContain("FAILED");
          return Promise.resolve({ _sum: { deliveryFeePaise: 3000 } });
        }
        return Promise.resolve(EMPTY_AGGREGATE);
      });

      const result = await service.getOverview({});
      expect(result.profit.deliveryCostPaise).toBe(3000);
    });
  });
});
