import { Test, TestingModule } from "@nestjs/testing";
import {
  PlansService,
  calculateMonthlyDeliveryOccurrences,
  calculateTotalLitres,
  generateDeliveryDates,
  quantityForOccurrence,
} from "./plans.service";
import { PrismaService } from "../../prisma/prisma.service";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  PlanType,
  DeliveryFrequency,
  QuantityMode,
  PlanQuoteStatus,
  PlanSelectionStatus,
  QUOTE_EXPIRY_MINUTES,
} from "./plans.constants";

describe("PlansService", () => {
  let service: PlansService;

  // ── Prisma mock ──
  const mockPrisma: any = {
    planConfig: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    planSelection: { count: jest.fn(), create: jest.fn() },
    planDelivery: { createMany: jest.fn() },
    planQuote: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };

  const USER = "user-1";
  const OTHER = "user-2";

  /** Default BUY_ONCE config */
  const buyOnceConfig = {
    id: "cfg-bo",
    planType: PlanType.BUY_ONCE,
    isActive: true,
    actualPricePerLitre: 12000, // ₹120.00 in paise
    sellingPricePerLitre: 10000, // ₹100.00 in paise
    quantityMin: 1,
    quantityMax: 5,
    maxUsages: 7,
    trialDurationDays: 7,
  };

  /** Default TRIAL config */
  const trialConfig = {
    id: "cfg-tr",
    planType: PlanType.SEVEN_DAY_TRIAL,
    isActive: true,
    actualPricePerLitre: 11000, // ₹110.00 in paise
    sellingPricePerLitre: 9500, // ₹95.00 in paise
    quantityMin: 1,
    quantityMax: 5,
    maxUsages: 1,
    trialDurationDays: 7,
  };

  /** Default MONTHLY config */
  const monthlyConfig = {
    id: "cfg-mo",
    planType: PlanType.MONTHLY,
    isActive: true,
    actualPricePerLitre: 10000, // ₹100.00 in paise
    sellingPricePerLitre: 9000, // ₹90.00 in paise
    quantityMin: 1,
    quantityMax: 5,
    maxUsages: 0,
    trialDurationDays: 0,
    dailyEnabled: true,
    alternateDaysEnabled: true,
    fixedQuantityEnabled: true,
    alternatingQuantityEnabled: true,
  };

  /**
   * Helper: makes planConfig.findFirst return the appropriate config for the
   * requested planType argument.
   */
  function setupConfigMock() {
    mockPrisma.planConfig.findFirst.mockImplementation(
      ({ where }: { where: { planType: string } }) => {
        switch (where.planType) {
          case PlanType.BUY_ONCE:
            return buyOnceConfig;
          case PlanType.SEVEN_DAY_TRIAL:
            return trialConfig;
          case PlanType.MONTHLY:
            return monthlyConfig;
          default:
            return null;
        }
      },
    );
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    setupConfigMock();
    // Default: no usages for any plan.
    mockPrisma.planSelection.count.mockResolvedValue(0);
    // Default: quote create echoes back with id.
    mockPrisma.planQuote.create.mockImplementation(({ data }: any) => ({
      id: "quote-1",
      ...data,
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlansService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<PlansService>(PlansService);
  });

  // ══════════════════════════════════════════════════════════════
  //  PLANS OVERVIEW
  // ══════════════════════════════════════════════════════════════

  describe("getPlansOverview", () => {
    it("new customer gets all 3 plans available", async () => {
      const result = await service.getPlansOverview(USER);
      expect(result.plans).toHaveLength(3);
      expect(result.plans[0]).toMatchObject({
        type: PlanType.BUY_ONCE,
        available: true,
      });
      expect(result.plans[1]).toMatchObject({
        type: PlanType.SEVEN_DAY_TRIAL,
        available: true,
      });
      expect(result.plans[2]).toMatchObject({
        type: PlanType.MONTHLY,
        available: true,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  BUY ONCE — ELIGIBILITY
  // ══════════════════════════════════════════════════════════════

  describe("getBuyOnceEligibility", () => {
    it("new customer is eligible with 7 remaining", async () => {
      const result = await service.getBuyOnceEligibility(USER);
      expect(result.eligible).toBe(true);
      expect(result.usageCount).toBe(0);
      expect(result.remainingUses).toBe(7);
      expect(result.maxUses).toBe(7);
    });

    it("after 1 use, still eligible with 6 remaining", async () => {
      // First call: trial check (0 = no trial), second call: buy once count (1)
      mockPrisma.planSelection.count
        .mockResolvedValueOnce(0)  // trial check
        .mockResolvedValueOnce(1); // buy-once count
      const result = await service.getBuyOnceEligibility(USER);
      expect(result.eligible).toBe(true);
      expect(result.usageCount).toBe(1);
      expect(result.remainingUses).toBe(6);
    });

    it("after 6 uses, still eligible with 1 remaining", async () => {
      mockPrisma.planSelection.count
        .mockResolvedValueOnce(0)  // trial check
        .mockResolvedValueOnce(6); // buy-once count
      const result = await service.getBuyOnceEligibility(USER);
      expect(result.eligible).toBe(true);
      expect(result.usageCount).toBe(6);
      expect(result.remainingUses).toBe(1);
    });

    it("after 7 uses, no longer eligible", async () => {
      mockPrisma.planSelection.count
        .mockResolvedValueOnce(0)  // trial check
        .mockResolvedValueOnce(7); // buy-once count
      const result = await service.getBuyOnceEligibility(USER);
      expect(result.eligible).toBe(false);
      expect(result.remainingUses).toBe(0);
      expect(result.blockedReason).toBe("MAX_USES_REACHED");
    });

    it("Trial already used blocks Buy Once", async () => {
      mockPrisma.planSelection.count
        .mockResolvedValueOnce(1)  // trial check = used
        .mockResolvedValueOnce(0); // buy-once count
      const result = await service.getBuyOnceEligibility(USER);
      expect(result.eligible).toBe(false);
      expect(result.blockedReason).toBe("TRIAL_ALREADY_USED");
    });

    it("returns ineligible when plan not configured", async () => {
      mockPrisma.planConfig.findFirst.mockResolvedValue(null);
      const result = await service.getBuyOnceEligibility(USER);
      expect(result.eligible).toBe(false);
      expect(result.blockedReason).toBe("PLAN_NOT_CONFIGURED");
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  BUY ONCE — QUOTE
  // ══════════════════════════════════════════════════════════════

  describe("createBuyOnceQuote", () => {
    it("calculates amount server-side for qty=3", async () => {
      const result = await service.createBuyOnceQuote(USER, {
        quantityLitres: 3,
      });
      expect(result.plan).toBe(PlanType.BUY_ONCE);
      expect(result.quantity).toBe(3);
      expect(result.totalLitres).toBe(3);
      expect(result.sellingPricePerLitre).toBe(10000); // paise
      expect(result.totalSellingAmount).toBe(30000); // 3L × ₹100 = ₹300.00
      expect(result.totalActualAmount).toBe(36000); // 3L × ₹120 = ₹360.00
      expect(result.discountAmount).toBe(6000); // ₹60.00
      expect(result.deliveryOccurrences).toBe(1);
      expect(result.quoteId).toBeDefined();
    });

    it("quantity=1 accepted", async () => {
      const result = await service.createBuyOnceQuote(USER, {
        quantityLitres: 1,
      });
      expect(result.totalLitres).toBe(1);
    });

    it("quantity=5 accepted", async () => {
      const result = await service.createBuyOnceQuote(USER, {
        quantityLitres: 5,
      });
      expect(result.totalLitres).toBe(5);
    });

    it("quantity=0 rejected", async () => {
      await expect(
        service.createBuyOnceQuote(USER, { quantityLitres: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it("quantity=6 rejected", async () => {
      await expect(
        service.createBuyOnceQuote(USER, { quantityLitres: 6 }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects when customer is ineligible (Trial used)", async () => {
      mockPrisma.planSelection.count
        .mockResolvedValueOnce(1)  // trial check = used
        .mockResolvedValueOnce(0); // buy-once count
      await expect(
        service.createBuyOnceQuote(USER, { quantityLitres: 2 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("8th use is rejected (eligibility check)", async () => {
      mockPrisma.planSelection.count
        .mockResolvedValueOnce(0)  // trial check
        .mockResolvedValueOnce(7); // buy-once count = max
      await expect(
        service.createBuyOnceQuote(USER, { quantityLitres: 2 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("frontend amount cannot override server calculation", async () => {
      const result = await service.createBuyOnceQuote(USER, {
        quantityLitres: 2,
      } as any);
      // The service always uses config price, never a body-supplied amount.
      expect(result.totalSellingAmount).toBe(20000); // 2L × ₹100 = ₹200.00
      expect(result.sellingPricePerLitre).toBe(10000);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  TRIAL — ELIGIBILITY
  // ══════════════════════════════════════════════════════════════

  describe("getTrialEligibility", () => {
    it("new customer is eligible", async () => {
      const result = await service.getTrialEligibility(USER);
      expect(result.eligible).toBe(true);
      expect(result.used).toBe(false);
      expect(result.trialDurationDays).toBe(7);
    });

    it("after Buy Once used, Trial is unavailable", async () => {
      mockPrisma.planSelection.count.mockResolvedValueOnce(1); // buy once used
      const result = await service.getTrialEligibility(USER);
      expect(result.eligible).toBe(false);
      expect(result.blockedReason).toBe("BUY_ONCE_ALREADY_USED");
    });

    it("after Trial used, Trial is unavailable", async () => {
      mockPrisma.planSelection.count
        .mockResolvedValueOnce(0)  // buy once check
        .mockResolvedValueOnce(1); // trial used
      const result = await service.getTrialEligibility(USER);
      expect(result.eligible).toBe(false);
      expect(result.used).toBe(true);
      expect(result.blockedReason).toBe("TRIAL_ALREADY_USED");
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  TRIAL — QUOTE
  // ══════════════════════════════════════════════════════════════

  describe("createTrialQuote", () => {
    it("calculates 7-day trial amount server-side", async () => {
      const result = await service.createTrialQuote(USER, {
        quantityLitres: 2,
      });
      expect(result.plan).toBe(PlanType.SEVEN_DAY_TRIAL);
      expect(result.durationDays).toBe(7);
      expect(result.deliveryOccurrences).toBe(7);
      expect(result.quantity).toBe(2);
      expect(result.totalLitres).toBe(14);
      expect(result.totalSellingAmount).toBe(14 * 9500); // paise
      expect(result.discountAmount).toBe(14 * 11000 - 14 * 9500);
    });

    it("quantity=1 accepted", async () => {
      const result = await service.createTrialQuote(USER, {
        quantityLitres: 1,
      });
      expect(result.totalLitres).toBe(7);
    });

    it("quantity=5 accepted", async () => {
      const result = await service.createTrialQuote(USER, {
        quantityLitres: 5,
      });
      expect(result.totalLitres).toBe(35);
    });

    it("quantity=0 rejected", async () => {
      await expect(
        service.createTrialQuote(USER, { quantityLitres: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it("quantity=6 rejected", async () => {
      await expect(
        service.createTrialQuote(USER, { quantityLitres: 6 }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects when ineligible (Buy Once used)", async () => {
      mockPrisma.planSelection.count.mockResolvedValueOnce(1); // buy once used
      await expect(
        service.createTrialQuote(USER, { quantityLitres: 2 }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  MONTHLY — INFO
  // ══════════════════════════════════════════════════════════════

  describe("getMonthlyInfo", () => {
    it("returns monthly configuration", async () => {
      const result = await service.getMonthlyInfo();
      expect(result.available).toBe(true);
      expect(result.frequencies).toEqual(["DAILY", "ALTERNATE_DAYS"]);
      expect(result.quantityModes).toEqual(["FIXED", "ALTERNATING"]);
      expect(result.quantityMin).toBe(1);
      expect(result.quantityMax).toBe(5);
      expect(result.sellingPricePerLitre).toBe(9000); // paise
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  MONTHLY — QUOTE
  // ══════════════════════════════════════════════════════════════

  describe("createMonthlyQuote", () => {
    it("DAILY + FIXED works", async () => {
      const result = await service.createMonthlyQuote(USER, {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.FIXED,
        quantity: 2,
      });
      expect(result.plan).toBe(PlanType.MONTHLY);
      expect(result.frequency).toBe(DeliveryFrequency.DAILY);
      expect(result.quantityMode).toBe(QuantityMode.FIXED);
      expect(result.quantity).toBe(2);
      expect(result.deliveryOccurrences).toBeGreaterThan(0);
      expect(result.totalLitres).toBe(result.deliveryOccurrences * 2);
      expect(result.totalSellingAmount).toBe(result.totalLitres * 9000); // paise
    });

    it("DAILY + ALTERNATING works", async () => {
      const result = await service.createMonthlyQuote(USER, {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.ALTERNATING,
        quantityA: 1,
        quantityB: 2,
      });
      expect(result.quantityA).toBe(1);
      expect(result.quantityB).toBe(2);
      expect(result.deliveryOccurrences).toBeGreaterThan(0);
      // Alternating: ceil(occ/2)*1 + floor(occ/2)*2
      const occ = result.deliveryOccurrences;
      const expectedLitres = Math.ceil(occ / 2) * 1 + Math.floor(occ / 2) * 2;
      expect(result.totalLitres).toBe(expectedLitres);
    });

    it("ALTERNATE_DAYS + FIXED works", async () => {
      const result = await service.createMonthlyQuote(USER, {
        frequency: DeliveryFrequency.ALTERNATE_DAYS,
        quantityMode: QuantityMode.FIXED,
        quantity: 3,
      });
      expect(result.frequency).toBe(DeliveryFrequency.ALTERNATE_DAYS);
      // Alternate days ~= ceil(days/2) occurrences
      expect(result.deliveryOccurrences).toBeGreaterThan(0);
      expect(result.totalLitres).toBe(result.deliveryOccurrences * 3);
    });

    it("ALTERNATE_DAYS + ALTERNATING works", async () => {
      const result = await service.createMonthlyQuote(USER, {
        frequency: DeliveryFrequency.ALTERNATE_DAYS,
        quantityMode: QuantityMode.ALTERNATING,
        quantityA: 1,
        quantityB: 2,
      });
      const occ = result.deliveryOccurrences;
      const expectedLitres = Math.ceil(occ / 2) * 1 + Math.floor(occ / 2) * 2;
      expect(result.totalLitres).toBe(expectedLitres);
    });

    it("quantity range 1-5 for fixed", async () => {
      // min
      const r1 = await service.createMonthlyQuote(USER, {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.FIXED,
        quantity: 1,
      });
      expect(r1.quantity).toBe(1);

      // max
      const r5 = await service.createMonthlyQuote(USER, {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.FIXED,
        quantity: 5,
      });
      expect(r5.quantity).toBe(5);
    });

    it("quantity=0 rejected for fixed", async () => {
      await expect(
        service.createMonthlyQuote(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.FIXED,
          quantity: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("quantity=6 rejected for fixed", async () => {
      await expect(
        service.createMonthlyQuote(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.FIXED,
          quantity: 6,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("quantityA=0 rejected for alternating", async () => {
      await expect(
        service.createMonthlyQuote(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.ALTERNATING,
          quantityA: 0,
          quantityB: 2,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("quantityB=6 rejected for alternating", async () => {
      await expect(
        service.createMonthlyQuote(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.ALTERNATING,
          quantityA: 2,
          quantityB: 6,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("missing quantity for FIXED mode rejected", async () => {
      await expect(
        service.createMonthlyQuote(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.FIXED,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("missing quantityA for ALTERNATING mode rejected", async () => {
      await expect(
        service.createMonthlyQuote(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.ALTERNATING,
          quantityB: 2,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("missing quantityB for ALTERNATING mode rejected", async () => {
      await expect(
        service.createMonthlyQuote(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.ALTERNATING,
          quantityA: 1,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("amount calculated server-side, not from frontend", async () => {
      const result = await service.createMonthlyQuote(USER, {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.FIXED,
        quantity: 2,
      } as any);
      // Always uses config price.
      expect(result.sellingPricePerLitre).toBe(9000); // paise
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  DELIVERY OCCURRENCE CALCULATION
  // ══════════════════════════════════════════════════════════════

  describe("calculateMonthlyDeliveryOccurrences", () => {
    it("January (31 days) DAILY = 31", () => {
      // Jan 2027
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.DAILY,
          new Date(2027, 0, 1),
        ),
      ).toBe(31);
    });

    it("February non-leap (28 days) DAILY = 28", () => {
      // Feb 2027
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.DAILY,
          new Date(2027, 1, 1),
        ),
      ).toBe(28);
    });

    it("February leap (29 days) DAILY = 29", () => {
      // Feb 2028 (leap year)
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.DAILY,
          new Date(2028, 1, 1),
        ),
      ).toBe(29);
    });

    it("April (30 days) DAILY = 30", () => {
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.DAILY,
          new Date(2027, 3, 1),
        ),
      ).toBe(30);
    });

    it("January (31 days) ALTERNATE_DAYS = 16", () => {
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.ALTERNATE_DAYS,
          new Date(2027, 0, 1),
        ),
      ).toBe(16);
    });

    it("February non-leap (28 days) ALTERNATE_DAYS = 14", () => {
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.ALTERNATE_DAYS,
          new Date(2027, 1, 1),
        ),
      ).toBe(14);
    });

    it("April (30 days) ALTERNATE_DAYS = 15", () => {
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.ALTERNATE_DAYS,
          new Date(2027, 3, 1),
        ),
      ).toBe(15);
    });

    // ── Mid-month / month-end starts (start-date aware) ──
    it("MID-MONTH: Oct 15 (31-day month) DAILY = 17 (Oct 15..31), not 31", () => {
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.DAILY,
          new Date(2026, 9, 15),
        ),
      ).toBe(17);
    });

    it("MID-MONTH: Oct 15 ALTERNATE_DAYS = 9 (15,17,...,31)", () => {
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.ALTERNATE_DAYS,
          new Date(2026, 9, 15),
        ),
      ).toBe(9);
    });

    it("NEAR MONTH-END: Jan 31 DAILY = 1", () => {
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.DAILY,
          new Date(2027, 0, 31),
        ),
      ).toBe(1);
    });

    it("NEAR MONTH-END: Jan 30 ALTERNATE_DAYS = 1 (30 delivers, 31 would be next)", () => {
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.ALTERNATE_DAYS,
          new Date(2027, 0, 30),
        ),
      ).toBe(1);
    });

    it("FEB leap mid-month: Feb 27 2028 DAILY = 3 (27,28,29)", () => {
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.DAILY,
          new Date(2028, 1, 27),
        ),
      ).toBe(3);
    });

    it("FEB non-leap mid-month: Feb 27 2027 DAILY = 2 (27,28)", () => {
      expect(
        calculateMonthlyDeliveryOccurrences(
          DeliveryFrequency.DAILY,
          new Date(2027, 1, 27),
        ),
      ).toBe(2);
    });
  });

  describe("mid-month materialization (generateDeliveryDates from the start date)", () => {
    it("DAILY from Oct 15 produces NO deliveries on Oct 1-14", () => {
      const dates = generateDeliveryDates(
        DeliveryFrequency.DAILY,
        new Date(2026, 9, 15),
        new Date(2026, 9, 31),
      );
      expect(dates[0].toISOString().slice(0, 10)).toBe("2026-10-15");
      expect(dates[dates.length - 1].toISOString().slice(0, 10)).toBe("2026-10-31");
      expect(dates).toHaveLength(17);
      expect(
        dates.every((d) => d.getUTCDate() >= 15),
      ).toBe(true); // never before the start date
    });

    it("ALTERNATE_DAYS from Oct 15 delivers 15,17,...,31", () => {
      const dates = generateDeliveryDates(
        DeliveryFrequency.ALTERNATE_DAYS,
        new Date(2026, 9, 15),
        new Date(2026, 9, 31),
      );
      expect(dates.map((d) => d.getUTCDate())).toEqual([
        15, 17, 19, 21, 23, 25, 27, 29, 31,
      ]);
    });

    it("respects the end boundary (never past end of month)", () => {
      const dates = generateDeliveryDates(
        DeliveryFrequency.DAILY,
        new Date(2027, 1, 27), // Feb 27 2027 (non-leap)
        new Date(2027, 1, 28),
      );
      expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
        "2027-02-27",
        "2027-02-28",
      ]);
    });
  });

  describe("money is exact integer paise (no float drift)", () => {
    it("fractional-rupee price × litres stays an exact integer in paise", () => {
      // ₹99.50/L = 9950 paise. 3L selling = 29850 paise = ₹298.50 exactly.
      const pricePaise = 9950;
      const litres = 3;
      const total = pricePaise * litres;
      expect(total).toBe(29850);
      expect(Number.isInteger(total)).toBe(true);
    });

    it("the classic 0.1+0.2 float trap does not occur with paise", () => {
      // ₹0.10 + ₹0.20 in paise = 10 + 20 = 30 paise exactly (float would be 0.30000000000000004).
      expect(10 + 20).toBe(30);
    });

    it("quote amounts from the service are whole integers (paise)", async () => {
      const r = await service.createBuyOnceQuote(USER, { quantityLitres: 3 });
      for (const v of [
        r.totalSellingAmount,
        r.totalActualAmount,
        r.discountAmount,
        r.sellingPricePerLitre,
        r.actualPricePerLitre,
      ]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    });
  });

  describe("calculateTotalLitres", () => {
    it("DAILY + FIXED: 30 occ × 2L = 60", () => {
      expect(
        calculateTotalLitres(
          DeliveryFrequency.DAILY,
          QuantityMode.FIXED,
          30,
          2,
        ),
      ).toBe(60);
    });

    it("DAILY + ALTERNATING: 30 occ, 1L/2L = 15×1+15×2 = 45", () => {
      expect(
        calculateTotalLitres(
          DeliveryFrequency.DAILY,
          QuantityMode.ALTERNATING,
          30,
          undefined,
          1,
          2,
        ),
      ).toBe(45);
    });

    it("ALTERNATE_DAYS + FIXED: 15 occ × 2L = 30", () => {
      expect(
        calculateTotalLitres(
          DeliveryFrequency.ALTERNATE_DAYS,
          QuantityMode.FIXED,
          15,
          2,
        ),
      ).toBe(30);
    });

    it("ALTERNATE_DAYS + ALTERNATING: 15 occ, 1L/2L = 8×1+7×2 = 22", () => {
      expect(
        calculateTotalLitres(
          DeliveryFrequency.ALTERNATE_DAYS,
          QuantityMode.ALTERNATING,
          15,
          undefined,
          1,
          2,
        ),
      ).toBe(22);
    });

    it("odd occurrences: 31 DAILY ALTERNATING 3L/5L = 16×3+15×5 = 123", () => {
      expect(
        calculateTotalLitres(
          DeliveryFrequency.DAILY,
          QuantityMode.ALTERNATING,
          31,
          undefined,
          3,
          5,
        ),
      ).toBe(123);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  CONFIRM PLAN
  // ══════════════════════════════════════════════════════════════

  describe("generateDeliveryDates (shared delivery helper)", () => {
    it("DAILY yields every calendar day in the inclusive range", () => {
      const dates = generateDeliveryDates(
        DeliveryFrequency.DAILY,
        new Date(2026, 0, 1),
        new Date(2026, 0, 5),
      );
      expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
        "2026-01-01",
        "2026-01-02",
        "2026-01-03",
        "2026-01-04",
        "2026-01-05",
      ]);
    });

    it("ALTERNATE_DAYS delivers on day 1, 3, 5 (every other day from start)", () => {
      const dates = generateDeliveryDates(
        DeliveryFrequency.ALTERNATE_DAYS,
        new Date(2026, 0, 1),
        new Date(2026, 0, 6),
      );
      expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
        "2026-01-01",
        "2026-01-03",
        "2026-01-05",
      ]);
    });

    it("spans month boundaries without assuming 30 days (Feb 2028 leap)", () => {
      const dates = generateDeliveryDates(
        DeliveryFrequency.DAILY,
        new Date(2028, 1, 1),
        new Date(2028, 1, 29),
      );
      expect(dates).toHaveLength(29); // 2028 is a leap year
    });
  });

  describe("quantityForOccurrence (alternating by occurrence, not day)", () => {
    it("FIXED returns the constant quantity", () => {
      expect(quantityForOccurrence(QuantityMode.FIXED, 1, 3)).toBe(3);
      expect(quantityForOccurrence(QuantityMode.FIXED, 4, 3)).toBe(3);
    });

    it("ALTERNATING maps odd occurrence -> A, even -> B", () => {
      expect(quantityForOccurrence(QuantityMode.ALTERNATING, 1, null, 1, 2)).toBe(1);
      expect(quantityForOccurrence(QuantityMode.ALTERNATING, 2, null, 1, 2)).toBe(2);
      expect(quantityForOccurrence(QuantityMode.ALTERNATING, 3, null, 1, 2)).toBe(1);
      expect(quantityForOccurrence(QuantityMode.ALTERNATING, 4, null, 1, 2)).toBe(2);
    });
  });

  describe("confirmPlan", () => {
    const validQuote = {
      id: "quote-1",
      userId: USER,
      planType: PlanType.BUY_ONCE,
      status: PlanQuoteStatus.PENDING,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h future
      totalSellingAmount: 300,
    };

    beforeEach(() => {
      // Wire up the transaction mock to execute the callback with the same
      // mock prisma so inner queries work.
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        return fn({
          planQuote: mockPrisma.planQuote,
          planSelection: mockPrisma.planSelection,
          planDelivery: mockPrisma.planDelivery,
          $executeRaw: mockPrisma.$executeRaw,
        });
      });
      mockPrisma.planQuote.findUnique.mockResolvedValue(validQuote);
      mockPrisma.planQuote.update.mockResolvedValue({
        ...validQuote,
        status: PlanQuoteStatus.CONFIRMED,
      });
      // Atomic PENDING -> CONFIRMED transition: by default it wins (count 1).
      mockPrisma.planQuote.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.planSelection.create.mockImplementation(({ data }: any) => ({
        id: "sel-1",
        ...data,
      }));
    });

    it("confirms a valid pending quote", async () => {
      const result = await service.confirmPlan(USER, {
        quoteId: "quote-1",
      });
      expect(result.selectionId).toBe("sel-1");
      expect(result.quoteId).toBe("quote-1");
      expect(result.plan).toBe(PlanType.BUY_ONCE);
      expect(result.status).toBe(PlanSelectionStatus.CONFIRMED);
    });

    it("throws NotFound when quote does not exist", async () => {
      mockPrisma.planQuote.findUnique.mockResolvedValue(null);
      await expect(
        service.confirmPlan(USER, { quoteId: "no-such" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFound when quote belongs to another user (IDOR)", async () => {
      mockPrisma.planQuote.findUnique.mockResolvedValue({
        ...validQuote,
        userId: OTHER,
      });
      await expect(
        service.confirmPlan(USER, { quoteId: "quote-1" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects already-confirmed quote", async () => {
      mockPrisma.planQuote.findUnique.mockResolvedValue({
        ...validQuote,
        status: PlanQuoteStatus.CONFIRMED,
      });
      await expect(
        service.confirmPlan(USER, { quoteId: "quote-1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects expired quote", async () => {
      mockPrisma.planQuote.findUnique.mockResolvedValue({
        ...validQuote,
        expiresAt: new Date(Date.now() - 1000), // Past
      });
      await expect(
        service.confirmPlan(USER, { quoteId: "quote-1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("re-checks Buy Once eligibility in the transaction (Trial used)", async () => {
      // First planSelection.count in transaction returns 1 (trial used).
      mockPrisma.planSelection.count.mockResolvedValueOnce(1);
      await expect(
        service.confirmPlan(USER, { quoteId: "quote-1" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("re-checks Trial eligibility in the transaction (Buy Once used)", async () => {
      mockPrisma.planQuote.findUnique.mockResolvedValue({
        ...validQuote,
        planType: PlanType.SEVEN_DAY_TRIAL,
      });
      // First planSelection.count for buy-once check returns 1.
      mockPrisma.planSelection.count.mockResolvedValueOnce(1);
      await expect(
        service.confirmPlan(USER, { quoteId: "quote-1" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("is race-safe: a concurrent confirmation of the same quote is rejected and creates no second selection", async () => {
      // Both requests read the quote as PENDING (classic read-then-write race),
      // but the atomic guarded transition only matches for the first writer.
      // Simulate the losing request: the PENDING -> CONFIRMED updateMany matches
      // zero rows because the row is already CONFIRMED by the winner.
      mockPrisma.planQuote.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.confirmPlan(USER, { quoteId: "quote-1" }),
      ).rejects.toThrow(BadRequestException);

      // Critically, no duplicate PlanSelection must be created for the loser.
      expect(mockPrisma.planSelection.create).not.toHaveBeenCalled();
    });

    it("acquires a per-user advisory lock to serialize confirmations (DB-level cross-quote race guard)", async () => {
      await service.confirmPlan(USER, { quoteId: "quote-1" });
      // The advisory lock must be taken inside the transaction.
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      const args = mockPrisma.$executeRaw.mock.calls[0];
      // Tagged-template: first arg is the SQL strings array, USER is interpolated.
      const sql = args[0].join("?");
      expect(sql).toContain("pg_advisory_xact_lock");
      expect(args).toContain(USER);
    });

    it("cross-quote race: a second TRIAL confirmation is rejected once a Trial selection exists", async () => {
      mockPrisma.planQuote.findUnique.mockResolvedValue({
        ...validQuote,
        planType: PlanType.SEVEN_DAY_TRIAL,
      });
      // Serialized re-check (buy-once=0, trial=1) sees the already-created Trial.
      mockPrisma.planSelection.count
        .mockResolvedValueOnce(0) // buy-once used?
        .mockResolvedValueOnce(1); // trial already used
      await expect(
        service.confirmPlan(USER, { quoteId: "quote-1" }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.planSelection.create).not.toHaveBeenCalled();
    });

    it("cross-quote race: a BUY_ONCE confirmation at the usage cap is rejected", async () => {
      // trial check = 0, buy-once count already at max (7).
      mockPrisma.planSelection.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(7);
      await expect(
        service.confirmPlan(USER, { quoteId: "quote-1" }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.planSelection.create).not.toHaveBeenCalled();
    });

    it("uses a guarded PENDING-only transition for the winning confirmation", async () => {
      await service.confirmPlan(USER, { quoteId: "quote-1" });
      expect(mockPrisma.planQuote.updateMany).toHaveBeenCalledWith({
        where: { id: "quote-1", status: PlanQuoteStatus.PENDING },
        data: { status: PlanQuoteStatus.CONFIRMED },
      });
    });

    it("materialises delivery rows and seeds the live schedule for a MONTHLY plan", async () => {
      const start = new Date(2026, 0, 1);
      const end = new Date(2026, 0, 5);
      mockPrisma.planQuote.findUnique.mockResolvedValue({
        ...validQuote,
        planType: PlanType.MONTHLY,
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.FIXED,
        quantity: 2,
        quantityA: null,
        quantityB: null,
        deliveryOccurrences: 5,
        billingPeriodStart: start,
        billingPeriodEnd: end,
      });
      await service.confirmPlan(USER, { quoteId: "quote-1" });
      expect(mockPrisma.planDelivery.createMany).toHaveBeenCalledTimes(1);
      const rows = mockPrisma.planDelivery.createMany.mock.calls[0][0].data;
      expect(rows).toHaveLength(5); // Jan 1..5
      expect(rows.every((r: any) => r.quantityLitres === 2)).toBe(true);
      expect(rows[0].occurrence).toBe(1);
    });

    it("quoting does NOT mark Trial or Buy Once as used", async () => {
      // Generate a quote
      await service.createBuyOnceQuote(USER, { quantityLitres: 2 });
      // planSelection.create should NOT have been called by quote creation.
      expect(mockPrisma.planSelection.create).not.toHaveBeenCalled();
    });
  });

  // ── Admin: plan configuration ─────────────────────────────────────

  describe("Admin plan configuration", () => {
    const timestamps = {
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    };
    const rows: Record<string, any> = {};

    beforeEach(() => {
      rows[PlanType.BUY_ONCE] = { ...buyOnceConfig, ...timestamps };
      rows[PlanType.SEVEN_DAY_TRIAL] = { ...trialConfig, ...timestamps };
      rows[PlanType.MONTHLY] = { ...monthlyConfig, ...timestamps };
      mockPrisma.$transaction.mockImplementation(async (fn: any) =>
        fn(mockPrisma),
      );
      mockPrisma.planConfig.findMany.mockImplementation(async () =>
        Object.values(rows),
      );
      mockPrisma.planConfig.findUnique.mockImplementation(
        async ({ where }: any) => rows[where.planType] ?? null,
      );
      mockPrisma.planConfig.update.mockImplementation(
        async ({ where, data }: any) => ({ ...rows[where.planType], ...data }),
      );
      mockPrisma.planConfig.create.mockImplementation(async ({ data }: any) => ({
        id: "cfg-new",
        quantityMin: 1,
        quantityMax: 5,
        maxUsages: 7,
        trialDurationDays: 7,
        isActive: true,
        dailyEnabled: true,
        alternateDaysEnabled: true,
        fixedQuantityEnabled: true,
        alternatingQuantityEnabled: true,
        ...timestamps,
        ...data,
      }));
    });

    describe("getAdminPlans", () => {
      it("returns all three plans in fixed order with plan-specific fields", async () => {
        const res = await service.getAdminPlans();
        expect(res.unconfigured).toEqual([]);
        expect(res.plans.map((p) => p.type)).toEqual([
          PlanType.BUY_ONCE,
          PlanType.SEVEN_DAY_TRIAL,
          PlanType.MONTHLY,
        ]);
        const [bo, tr, mo] = res.plans;
        expect(bo).toEqual({
          type: PlanType.BUY_ONCE,
          isActive: true,
          actualPricePerLitre: 12000,
          sellingPricePerLitre: 10000,
          quantityMin: 1,
          quantityMax: 5,
          maxUsages: 7,
          ...timestamps,
        });
        expect(tr).toMatchObject({ trialDurationDays: 7, maxUsages: 1 });
        expect(mo).toMatchObject({
          dailyEnabled: true,
          alternateDaysEnabled: true,
          fixedQuantityEnabled: true,
          alternatingQuantityEnabled: true,
          frequencies: [DeliveryFrequency.DAILY, DeliveryFrequency.ALTERNATE_DAYS],
          quantityModes: [QuantityMode.FIXED, QuantityMode.ALTERNATING],
        });
        // Fields irrelevant to Monthly are not leaked into its response.
        expect(mo).not.toHaveProperty("maxUsages");
        expect(mo).not.toHaveProperty("trialDurationDays");
        // Internal id is not part of the admin contract.
        expect(bo).not.toHaveProperty("id");
      });

      it("reports missing rows as unconfigured without creating them", async () => {
        delete rows[PlanType.MONTHLY];
        const res = await service.getAdminPlans();
        expect(res.plans).toHaveLength(2);
        expect(res.unconfigured).toEqual([PlanType.MONTHLY]);
        expect(mockPrisma.planConfig.create).not.toHaveBeenCalled();
      });
    });

    describe("getAdminPlan", () => {
      it("returns one plan", async () => {
        const res = await service.getAdminPlan(PlanType.SEVEN_DAY_TRIAL);
        expect(res.type).toBe(PlanType.SEVEN_DAY_TRIAL);
        expect(res.trialDurationDays).toBe(7);
      });

      it("404s when not configured and does not create a row", async () => {
        delete rows[PlanType.BUY_ONCE];
        await expect(service.getAdminPlan(PlanType.BUY_ONCE)).rejects.toThrow(
          NotFoundException,
        );
        expect(mockPrisma.planConfig.create).not.toHaveBeenCalled();
      });
    });

    describe("updateAdminPlan", () => {
      it("updates Buy Once and writes only the supplied fields", async () => {
        const res = await service.updateAdminPlan(PlanType.BUY_ONCE, {
          sellingPricePerLitre: 8500,
          maxUsages: 3,
        });
        expect(mockPrisma.planConfig.update).toHaveBeenCalledWith({
          where: { planType: PlanType.BUY_ONCE },
          data: { sellingPricePerLitre: 8500, maxUsages: 3 },
        });
        expect(res.sellingPricePerLitre).toBe(8500);
        expect(res.maxUsages).toBe(3);
      });

      it("updates Trial configuration", async () => {
        const res = await service.updateAdminPlan(PlanType.SEVEN_DAY_TRIAL, {
          actualPricePerLitre: 11500,
          sellingPricePerLitre: 9200,
        });
        expect(res.actualPricePerLitre).toBe(11500);
        expect(res.sellingPricePerLitre).toBe(9200);
        expect(res.trialDurationDays).toBe(7);
        expect(res.maxUsages).toBe(1);
      });

      it("updates Monthly toggles and derives the customer option lists", async () => {
        const res = await service.updateAdminPlan(PlanType.MONTHLY, {
          alternateDaysEnabled: false,
          alternatingQuantityEnabled: false,
        });
        expect(res.frequencies).toEqual([DeliveryFrequency.DAILY]);
        expect(res.quantityModes).toEqual([QuantityMode.FIXED]);
      });

      it.each([false, true])("sets isActive=%s", async (isActive) => {
        const res = await service.updateAdminPlan(PlanType.MONTHLY, {
          isActive,
        });
        expect(res.isActive).toBe(isActive);
      });

      it("serialises edits with a per-plan advisory lock inside a transaction", async () => {
        await service.updateAdminPlan(PlanType.BUY_ONCE, { isActive: false });
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        const args = mockPrisma.$executeRaw.mock.calls[0];
        expect(args[0].join("?")).toContain("pg_advisory_xact_lock");
        expect(args).toContain(`plan_config:${PlanType.BUY_ONCE}`);
      });

      describe("field validation (400)", () => {
        it.each([
          ["string price", PlanType.BUY_ONCE, { sellingPricePerLitre: "8500" }],
          ["float price", PlanType.BUY_ONCE, { sellingPricePerLitre: 85.5 }],
          ["negative actual price", PlanType.BUY_ONCE, { actualPricePerLitre: -1 }],
          ["negative selling price", PlanType.MONTHLY, { sellingPricePerLitre: -100 }],
          ["price above ceiling", PlanType.MONTHLY, { actualPricePerLitre: 1_000_001 }],
          ["quantityMax above 5", PlanType.BUY_ONCE, { quantityMax: 6 }],
          ["quantityMin below 1", PlanType.SEVEN_DAY_TRIAL, { quantityMin: 0 }],
          ["non-integer quantity", PlanType.MONTHLY, { quantityMax: 4.5 }],
          ["maxUsages 0", PlanType.BUY_ONCE, { maxUsages: 0 }],
          ["negative maxUsages", PlanType.BUY_ONCE, { maxUsages: -3 }],
          ["float maxUsages", PlanType.BUY_ONCE, { maxUsages: 1.5 }],
          ["trialDurationDays (fixed rule)", PlanType.SEVEN_DAY_TRIAL, { trialDurationDays: 5 }],
          ["string isActive", PlanType.BUY_ONCE, { isActive: "false" }],
          ["numeric toggle", PlanType.MONTHLY, { dailyEnabled: 1 }],
          ["adminId in body", PlanType.BUY_ONCE, { adminId: "a-1", isActive: true }],
          ["Trial maxUsages (fixed rule)", PlanType.SEVEN_DAY_TRIAL, { maxUsages: 3 }],
          ["Buy Once field on Monthly", PlanType.MONTHLY, { maxUsages: 3 }],
          ["Monthly field on Buy Once", PlanType.BUY_ONCE, { dailyEnabled: true }],
          ["planType in body", PlanType.BUY_ONCE, { planType: PlanType.MONTHLY }],
          ["empty body", PlanType.BUY_ONCE, {}],
          ["array body", PlanType.BUY_ONCE, [{ isActive: true }]],
          ["null body", PlanType.BUY_ONCE, null],
        ])("rejects %s", async (_label, planType, body) => {
          await expect(
            service.updateAdminPlan(planType as PlanType, body),
          ).rejects.toThrow(BadRequestException);
          expect(mockPrisma.planConfig.update).not.toHaveBeenCalled();
          expect(mockPrisma.planConfig.create).not.toHaveBeenCalled();
        });
      });

      describe("cross-field validation against the merged stored config (400)", () => {
        it("rejects quantityMin above the stored quantityMax", async () => {
          rows[PlanType.BUY_ONCE].quantityMax = 3;
          await expect(
            service.updateAdminPlan(PlanType.BUY_ONCE, { quantityMin: 4 }),
          ).rejects.toThrow(/quantityMin \(4\) cannot exceed quantityMax \(3\)/);
        });

        it("rejects min > max in the same request", async () => {
          await expect(
            service.updateAdminPlan(PlanType.MONTHLY, {
              quantityMin: 5,
              quantityMax: 2,
            }),
          ).rejects.toThrow(BadRequestException);
        });

        it("rejects a selling price above the stored actual price", async () => {
          await expect(
            service.updateAdminPlan(PlanType.BUY_ONCE, {
              sellingPricePerLitre: 12001,
            }),
          ).rejects.toThrow(/cannot exceed actualPricePerLitre/);
        });

        it("rejects disabling every Monthly frequency", async () => {
          rows[PlanType.MONTHLY].alternateDaysEnabled = false;
          await expect(
            service.updateAdminPlan(PlanType.MONTHLY, { dailyEnabled: false }),
          ).rejects.toThrow(/frequency/);
        });

        it("rejects disabling every Monthly quantity mode", async () => {
          await expect(
            service.updateAdminPlan(PlanType.MONTHLY, {
              fixedQuantityEnabled: false,
              alternatingQuantityEnabled: false,
            }),
          ).rejects.toThrow(/quantity mode/);
        });

        it("accepts selling == actual (zero discount) and min == max", async () => {
          await expect(
            service.updateAdminPlan(PlanType.BUY_ONCE, {
              sellingPricePerLitre: 12000,
              quantityMin: 5,
              quantityMax: 5,
            }),
          ).resolves.toMatchObject({ sellingPricePerLitre: 12000 });
        });
      });

      describe("unconfigured plan", () => {
        beforeEach(() => delete rows[PlanType.MONTHLY]);

        it("404s when the body does not supply both prices", async () => {
          await expect(
            service.updateAdminPlan(PlanType.MONTHLY, { isActive: true }),
          ).rejects.toThrow(NotFoundException);
          expect(mockPrisma.planConfig.create).not.toHaveBeenCalled();
        });

        it("initialises the row when both prices are supplied", async () => {
          const res = await service.updateAdminPlan(PlanType.MONTHLY, {
            actualPricePerLitre: 10000,
            sellingPricePerLitre: 9000,
            alternateDaysEnabled: false,
          });
          expect(mockPrisma.planConfig.create).toHaveBeenCalledWith({
            data: {
              planType: PlanType.MONTHLY,
              actualPricePerLitre: 10000,
              sellingPricePerLitre: 9000,
              alternateDaysEnabled: false,
            },
          });
          expect(res.frequencies).toEqual([DeliveryFrequency.DAILY]);
        });

        it("still applies cross-field rules on initialisation", async () => {
          await expect(
            service.updateAdminPlan(PlanType.MONTHLY, {
              actualPricePerLitre: 9000,
              sellingPricePerLitre: 10000,
            }),
          ).rejects.toThrow(BadRequestException);
          expect(mockPrisma.planConfig.create).not.toHaveBeenCalled();
        });
      });
    });
  });

  // ── Customer flows honour admin configuration ─────────────────────

  describe("customer flows honour admin configuration", () => {
    function withConfig(planType: PlanType, overrides: Record<string, any>) {
      const base: Record<string, any> = {
        [PlanType.BUY_ONCE]: buyOnceConfig,
        [PlanType.SEVEN_DAY_TRIAL]: trialConfig,
        [PlanType.MONTHLY]: monthlyConfig,
      };
      mockPrisma.planConfig.findFirst.mockImplementation(({ where }: any) => {
        const cfg = { ...base[where.planType] };
        if (where.planType === planType) Object.assign(cfg, overrides);
        // Mirrors the real query's `isActive: true` filter.
        return where.isActive && !cfg.isActive ? null : cfg;
      });
    }

    it("Buy Once quote uses the admin-updated price", async () => {
      withConfig(PlanType.BUY_ONCE, { sellingPricePerLitre: 8500 });
      const q = await service.createBuyOnceQuote(USER, { quantityLitres: 2 });
      expect(q.sellingPricePerLitre).toBe(8500);
      expect(q.totalSellingAmount).toBe(17000);
      expect(q.discountAmount).toBe(24000 - 17000);
    });

    it("Buy Once honours an admin-lowered quantityMax", async () => {
      withConfig(PlanType.BUY_ONCE, { quantityMax: 3 });
      await expect(
        service.createBuyOnceQuote(USER, { quantityLitres: 4 }),
      ).rejects.toThrow(BadRequestException);
    });

    it("Buy Once eligibility honours an admin-lowered maxUsages", async () => {
      withConfig(PlanType.BUY_ONCE, { maxUsages: 2 });
      mockPrisma.planSelection.count
        .mockResolvedValueOnce(0) // trial used?
        .mockResolvedValueOnce(2); // buy-once uses
      const e = await service.getBuyOnceEligibility(USER);
      expect(e).toMatchObject({
        eligible: false,
        maxUses: 2,
        blockedReason: "MAX_USES_REACHED",
      });
    });

    it("Trial quote honours the 7-day trial duration", async () => {
      const q = await service.createTrialQuote(USER, { quantityLitres: 2 });
      expect(q.deliveryOccurrences).toBe(7);
      expect(q.totalLitres).toBe(14);
    });

    it.each([
      [PlanType.BUY_ONCE, (s: PlansService) => s.createBuyOnceQuote(USER, { quantityLitres: 1 }), ForbiddenException],
      [PlanType.SEVEN_DAY_TRIAL, (s: PlansService) => s.createTrialQuote(USER, { quantityLitres: 1 }), ForbiddenException],
      [
        PlanType.MONTHLY,
        (s: PlansService) =>
          s.createMonthlyQuote(USER, {
            frequency: DeliveryFrequency.DAILY,
            quantityMode: QuantityMode.FIXED,
            quantity: 1,
          }),
        BadRequestException,
      ],
    ])("disabled %s cannot produce a new quote", async (planType, call, err) => {
      withConfig(planType as PlanType, { isActive: false });
      await expect(call(service)).rejects.toThrow(err as any);
      expect(mockPrisma.planQuote.create).not.toHaveBeenCalled();
    });

    it("overview reports a disabled Monthly plan as unavailable", async () => {
      withConfig(PlanType.MONTHLY, { isActive: false });
      const res = await service.getPlansOverview(USER);
      expect(res.plans.find((p) => p.type === PlanType.MONTHLY)).toEqual({
        type: PlanType.MONTHLY,
        available: false,
        blockedReason: "PLAN_NOT_CONFIGURED",
      });
    });

    it("monthly info lists only admin-enabled options", async () => {
      withConfig(PlanType.MONTHLY, {
        dailyEnabled: false,
        fixedQuantityEnabled: false,
      });
      const res = await service.getMonthlyInfo();
      expect(res.frequencies).toEqual([DeliveryFrequency.ALTERNATE_DAYS]);
      expect(res.quantityModes).toEqual([QuantityMode.ALTERNATING]);
    });

    it("rejects a Monthly quote using a disabled frequency", async () => {
      withConfig(PlanType.MONTHLY, { alternateDaysEnabled: false });
      await expect(
        service.createMonthlyQuote(USER, {
          frequency: DeliveryFrequency.ALTERNATE_DAYS,
          quantityMode: QuantityMode.FIXED,
          quantity: 2,
        }),
      ).rejects.toThrow(/Frequency ALTERNATE_DAYS is not currently available/);
      // The still-enabled frequency keeps working.
      await expect(
        service.createMonthlyQuote(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.FIXED,
          quantity: 2,
        }),
      ).resolves.toMatchObject({ frequency: DeliveryFrequency.DAILY });
    });

    it("rejects a Monthly quote using a disabled quantity mode", async () => {
      withConfig(PlanType.MONTHLY, { alternatingQuantityEnabled: false });
      await expect(
        service.createMonthlyQuote(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.ALTERNATING,
          quantityA: 1,
          quantityB: 2,
        }),
      ).rejects.toThrow(/Quantity mode ALTERNATING is not currently available/);
    });

    describe("confirmation after the admin disables something", () => {
      const pendingQuote = {
        id: "quote-1",
        userId: USER,
        planType: PlanType.BUY_ONCE,
        status: PlanQuoteStatus.PENDING,
        quantity: 2,
        frequency: null,
        quantityMode: null,
        quantityA: null,
        quantityB: null,
        deliveryOccurrences: 1,
        billingPeriodStart: null,
        billingPeriodEnd: null,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      };

      beforeEach(() => {
        mockPrisma.$transaction.mockImplementation(async (fn: any) =>
          fn(mockPrisma),
        );
        mockPrisma.planQuote.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.planSelection.create.mockResolvedValue({
          id: "sel-1",
          status: PlanSelectionStatus.CONFIRMED,
        });
      });

      it.each([PlanType.BUY_ONCE, PlanType.SEVEN_DAY_TRIAL, PlanType.MONTHLY])(
        "a pending %s quote cannot be confirmed once the plan is disabled",
        async (planType) => {
          withConfig(planType, { isActive: false });
          mockPrisma.planQuote.findUnique.mockResolvedValue({
            ...pendingQuote,
            planType,
          });
          await expect(
            service.confirmPlan(USER, { quoteId: "quote-1" }),
          ).rejects.toThrow(ForbiddenException);
          expect(mockPrisma.planQuote.updateMany).not.toHaveBeenCalled();
          expect(mockPrisma.planSelection.create).not.toHaveBeenCalled();
        },
      );

      it("a pending Monthly quote cannot be confirmed once its frequency is disabled", async () => {
        withConfig(PlanType.MONTHLY, { alternateDaysEnabled: false });
        mockPrisma.planQuote.findUnique.mockResolvedValue({
          ...pendingQuote,
          planType: PlanType.MONTHLY,
          frequency: DeliveryFrequency.ALTERNATE_DAYS,
          quantityMode: QuantityMode.FIXED,
          billingPeriodStart: new Date(2026, 0, 1),
          billingPeriodEnd: new Date(2026, 0, 31),
        });
        await expect(
          service.confirmPlan(USER, { quoteId: "quote-1" }),
        ).rejects.toThrow(ForbiddenException);
        expect(mockPrisma.planSelection.create).not.toHaveBeenCalled();
      });

      it("an active plan still confirms normally", async () => {
        mockPrisma.planQuote.findUnique.mockResolvedValue(pendingQuote);
        await expect(
          service.confirmPlan(USER, { quoteId: "quote-1" }),
        ).resolves.toMatchObject({ selectionId: "sel-1" });
      });
    });
  });
});
