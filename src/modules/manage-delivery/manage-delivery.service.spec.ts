import { Test, TestingModule } from "@nestjs/testing";
import { ManageDeliveryService } from "./manage-delivery.service";
import { PrismaService } from "../../prisma/prisma.service";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  PlanType,
  DeliveryFrequency,
  QuantityMode,
  DeliveryStatus,
  PlanSelectionStatus,
} from "../plans/plans.constants";

// ── Date helpers (UTC date-only), mirroring the service ──
function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const TODAY = dateOnly(new Date());
function plusDays(n: number): Date {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

describe("ManageDeliveryService", () => {
  let service: ManageDeliveryService;

  const USER = "user-1";

  const mockPrisma: any = {
    planSelection: { findFirst: jest.fn(), update: jest.fn() },
    planDelivery: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  /** Active MONTHLY / DAILY / FIXED 2L plan spanning day -2 .. day +5. */
  const monthlySelection = {
    id: "sel-1",
    userId: USER,
    planType: PlanType.MONTHLY,
    status: PlanSelectionStatus.CONFIRMED,
    frequency: DeliveryFrequency.DAILY,
    quantityMode: QuantityMode.FIXED,
    quantity: 2,
    quantityA: null,
    quantityB: null,
    startDate: plusDays(-2),
    endDate: plusDays(5),
  };

  const deliveries = [
    { id: "d-past", deliveryDate: plusDays(-2), occurrence: 1, quantityLitres: 2, status: DeliveryStatus.DELIVERED },
    { id: "d-today", deliveryDate: plusDays(0), occurrence: 3, quantityLitres: 2, status: DeliveryStatus.SCHEDULED },
    { id: "d1", deliveryDate: plusDays(1), occurrence: 4, quantityLitres: 2, status: DeliveryStatus.SCHEDULED },
    { id: "d2", deliveryDate: plusDays(2), occurrence: 5, quantityLitres: 2, status: DeliveryStatus.SCHEDULED },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.planSelection.findFirst.mockResolvedValue(monthlySelection);
    mockPrisma.planSelection.update.mockResolvedValue(monthlySelection);
    mockPrisma.planDelivery.findMany.mockResolvedValue(deliveries);
    mockPrisma.planDelivery.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.planDelivery.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.planDelivery.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        planSelection: mockPrisma.planSelection,
        planDelivery: mockPrisma.planDelivery,
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ManageDeliveryService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(ManageDeliveryService);
  });

  // ══════════════════════════════════════════════════════════════
  //  GET
  // ══════════════════════════════════════════════════════════════

  describe("getManageDelivery", () => {
    it("returns the active plan and only upcoming (today + future) deliveries", async () => {
      const res = await service.getManageDelivery(USER);
      expect(res.activePlan.planType).toBe(PlanType.MONTHLY);
      expect(res.activePlan.quantityLitres).toBe(2);
      // Past DELIVERED (day -2) must be excluded; today + 2 future remain.
      expect(res.upcomingDeliveries).toHaveLength(3);
      const dates = res.upcomingDeliveries.map((d) => d.date);
      expect(dates).not.toContain(plusDays(-2).toISOString().slice(0, 10));
    });

    it("marks only strictly-future scheduled deliveries as modifiable", async () => {
      const res = await service.getManageDelivery(USER);
      const todayView = res.upcomingDeliveries.find(
        (d) => d.date === TODAY.toISOString().slice(0, 10),
      )!;
      const futureView = res.upcomingDeliveries.find(
        (d) => d.date === plusDays(1).toISOString().slice(0, 10),
      )!;
      expect(todayView.canSkip).toBe(false); // today is not skippable
      expect(futureView.canSkip).toBe(true);
      expect(futureView.canModify).toBe(true);
    });

    it("scopes the active-plan lookup to the authenticated user", async () => {
      await service.getManageDelivery(USER);
      expect(mockPrisma.planSelection.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: USER }) }),
      );
    });

    it("throws NotFound when the customer has no active plan", async () => {
      mockPrisma.planSelection.findFirst.mockResolvedValue(null);
      await expect(service.getManageDelivery(USER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  SKIP
  // ══════════════════════════════════════════════════════════════

  describe("skipDelivery", () => {
    it("skips a valid future scheduled delivery with a race-safe guarded update", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue(deliveries[2]); // d1 (future)
      await service.skipDelivery(USER, {
        deliveryDate: plusDays(1).toISOString().slice(0, 10),
      });
      expect(mockPrisma.planDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: "d1", status: DeliveryStatus.SCHEDULED },
        data: { status: DeliveryStatus.SKIPPED },
      });
    });

    it("rejects a past date", async () => {
      await expect(
        service.skipDelivery(USER, {
          deliveryDate: plusDays(-1).toISOString().slice(0, 10),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.planDelivery.updateMany).not.toHaveBeenCalled();
    });

    it("rejects today's delivery (only strictly-future allowed)", async () => {
      await expect(
        service.skipDelivery(USER, {
          deliveryDate: TODAY.toISOString().slice(0, 10),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a non-scheduled date", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue(null);
      await expect(
        service.skipDelivery(USER, {
          deliveryDate: plusDays(3).toISOString().slice(0, 10),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects an already-skipped delivery (duplicate skip)", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue({
        ...deliveries[2],
        status: DeliveryStatus.SKIPPED,
      });
      await expect(
        service.skipDelivery(USER, {
          deliveryDate: plusDays(1).toISOString().slice(0, 10),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.planDelivery.updateMany).not.toHaveBeenCalled();
    });

    it("rejects skipping a completed delivery", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue({
        ...deliveries[2],
        status: DeliveryStatus.DELIVERED,
      });
      await expect(
        service.skipDelivery(USER, {
          deliveryDate: plusDays(1).toISOString().slice(0, 10),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("is race-safe: a concurrent skip that loses the guard is rejected", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue(deliveries[2]);
      mockPrisma.planDelivery.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.skipDelivery(USER, {
          deliveryDate: plusDays(1).toISOString().slice(0, 10),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("scopes the delivery lookup to the authenticated user (isolation)", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue(deliveries[2]);
      await service.skipDelivery(USER, {
        deliveryDate: plusDays(1).toISOString().slice(0, 10),
      });
      expect(mockPrisma.planDelivery.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER, selectionId: "sel-1" }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  CHANGE QUANTITY
  // ══════════════════════════════════════════════════════════════

  describe("changeQuantity", () => {
    it("updates only future scheduled deliveries (history untouched)", async () => {
      await service.changeQuantity(USER, { quantityLitres: 3 });
      const call = mockPrisma.planDelivery.updateMany.mock.calls[0][0];
      expect(call.where.selectionId).toBe("sel-1");
      expect(call.where.userId).toBe(USER);
      expect(call.where.status).toBe(DeliveryStatus.SCHEDULED);
      // Future-only: strictly greater than today.
      expect(call.where.deliveryDate.gt.getTime()).toBe(TODAY.getTime());
      expect(call.data.quantityLitres).toBe(3);
    });

    it("records the new quantity as the live FIXED config", async () => {
      await service.changeQuantity(USER, { quantityLitres: 4 });
      expect(mockPrisma.planSelection.update).toHaveBeenCalledWith({
        where: { id: "sel-1" },
        data: {
          quantityMode: QuantityMode.FIXED,
          quantity: 4,
          quantityA: null,
          quantityB: null,
        },
      });
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  CHANGE SCHEDULE (frequency + quantity pattern)
  // ══════════════════════════════════════════════════════════════

  describe("changeSchedule", () => {
    it("DAILY -> ALTERNATE_DAYS regenerates future deliveries every other day", async () => {
      await service.changeSchedule(USER, {
        frequency: DeliveryFrequency.ALTERNATE_DAYS,
        quantityMode: QuantityMode.FIXED,
        quantity: 2,
      });
      const rows = mockPrisma.planDelivery.createMany.mock.calls[0][0].data;
      // From day+1 to day+5 every other day => day+1, day+3, day+5.
      expect(rows.map((r: any) => r.deliveryDate.getTime())).toEqual([
        plusDays(1).getTime(),
        plusDays(3).getTime(),
        plusDays(5).getTime(),
      ]);
    });

    it("ALTERNATE_DAYS -> DAILY regenerates a delivery every future day", async () => {
      await service.changeSchedule(USER, {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.FIXED,
        quantity: 2,
      });
      const rows = mockPrisma.planDelivery.createMany.mock.calls[0][0].data;
      // day+1 .. day+5 inclusive = 5 deliveries.
      expect(rows).toHaveLength(5);
    });

    it("FIXED -> ALTERNATING alternates quantity by delivery OCCURRENCE", async () => {
      await service.changeSchedule(USER, {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.ALTERNATING,
        quantityA: 1,
        quantityB: 5,
      });
      const rows = mockPrisma.planDelivery.createMany.mock.calls[0][0].data;
      // Occurrence 1->A(1), 2->B(5), 3->A(1), ...
      expect(rows.map((r: any) => r.quantityLitres)).toEqual([1, 5, 1, 5, 1]);
      expect(rows.map((r: any) => r.occurrence)).toEqual([1, 2, 3, 4, 5]);
    });

    it("ALTERNATING -> FIXED applies the fixed quantity to all future deliveries", async () => {
      await service.changeSchedule(USER, {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.FIXED,
        quantity: 3,
      });
      const rows = mockPrisma.planDelivery.createMany.mock.calls[0][0].data;
      expect(rows.every((r: any) => r.quantityLitres === 3)).toBe(true);
      expect(mockPrisma.planSelection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            quantityMode: QuantityMode.FIXED,
            quantity: 3,
            quantityA: null,
            quantityB: null,
          }),
        }),
      );
    });

    it("deletes only future scheduled deliveries, leaving history intact", async () => {
      await service.changeSchedule(USER, {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.FIXED,
        quantity: 2,
      });
      const del = mockPrisma.planDelivery.deleteMany.mock.calls[0][0];
      expect(del.where.deliveryDate.gt.getTime()).toBe(TODAY.getTime());
      expect(del.where.status).toBe(DeliveryStatus.SCHEDULED);
    });

    it("uses skipDuplicates so it cannot collide with retained skipped dates (concurrency-safe)", async () => {
      await service.changeSchedule(USER, {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.FIXED,
        quantity: 2,
      });
      expect(
        mockPrisma.planDelivery.createMany.mock.calls[0][0].skipDuplicates,
      ).toBe(true);
    });

    it("rejects schedule changes for a non-monthly plan", async () => {
      mockPrisma.planSelection.findFirst.mockResolvedValue({
        ...monthlySelection,
        planType: PlanType.SEVEN_DAY_TRIAL,
      });
      await expect(
        service.changeSchedule(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.FIXED,
          quantity: 2,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects an ALTERNATING config missing quantityB", async () => {
      await expect(
        service.changeSchedule(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.ALTERNATING,
          quantityA: 1,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
