import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  PlanType,
  DeliveryFrequency,
  QuantityMode,
  PlanQuoteStatus,
  PlanSelectionStatus,
  DeliveryStatus,
  QUOTE_EXPIRY_MINUTES,
} from "./plans.constants";
import { BuyOnceQuoteDto } from "./dto/customer/buy-once-quote.dto";
import { TrialQuoteDto } from "./dto/customer/trial-quote.dto";
import { MonthlyQuoteDto } from "./dto/customer/monthly-quote.dto";
import { ConfirmPlanDto } from "./dto/customer/confirm-plan.dto";

// ─── Response interfaces ────────────────────────────────────────────

export interface PlanAvailability {
  type: string;
  available: boolean;
  usageCount?: number;
  remainingUses?: number;
  maxUses?: number;
  used?: boolean;
  blockedReason?: string;
}

export interface PlansOverviewResponse {
  plans: PlanAvailability[];
}

export interface EligibilityResponse {
  eligible: boolean;
  usageCount?: number;
  remainingUses?: number;
  maxUses?: number;
  used?: boolean;
  trialDurationDays?: number;
  maxQuantityLitres?: number;
  blockedReason?: string;
}

export interface QuoteResponse {
  quoteId: string;
  plan: string;
  frequency?: string;
  quantityMode?: string;
  quantity?: number;
  quantityA?: number;
  quantityB?: number;
  durationDays?: number;
  deliveryOccurrences: number;
  actualPricePerLitre: number;
  sellingPricePerLitre: number;
  totalLitres: number;
  totalActualAmount: number;
  totalSellingAmount: number;
  discountAmount: number;
  expiresAt: Date;
}

export interface MonthlyInfoResponse {
  available: boolean;
  frequencies: string[];
  quantityModes: string[];
  quantityMin: number;
  quantityMax: number;
  actualPricePerLitre: number;
  sellingPricePerLitre: number;
}

export interface ConfirmationResponse {
  selectionId: string;
  quoteId: string;
  plan: string;
  status: string;
}

// ─── Delivery calculation utility ───────────────────────────────────

/**
 * Calculates the number of delivery occurrences for a monthly billing period.
 * Uses the calendar month that contains `startDate`. Never hardcodes 30 days.
 */
export function calculateMonthlyDeliveryOccurrences(
  frequency: DeliveryFrequency,
  startDate: Date,
): number {
  const year = startDate.getFullYear();
  const month = startDate.getMonth();
  // Days in this specific calendar month (28/29/30/31).
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  if (frequency === DeliveryFrequency.DAILY) {
    return daysInMonth;
  }
  // ALTERNATE_DAYS: delivery on odd-numbered days (1, 3, 5, ...).
  return Math.ceil(daysInMonth / 2);
}

/**
 * Calculates total litres for a monthly plan configuration.
 */
export function calculateTotalLitres(
  frequency: DeliveryFrequency,
  quantityMode: QuantityMode,
  deliveryOccurrences: number,
  quantity?: number,
  quantityA?: number,
  quantityB?: number,
): number {
  if (quantityMode === QuantityMode.FIXED) {
    return deliveryOccurrences * (quantity ?? 0);
  }

  // ALTERNATING: pattern A, B, A, B, ...
  const qA = quantityA ?? 0;
  const qB = quantityB ?? 0;
  const halfFloor = Math.floor(deliveryOccurrences / 2);
  const halfCeil = Math.ceil(deliveryOccurrences / 2);
  // A gets the extra occurrence when odd count.
  return halfCeil * qA + halfFloor * qB;
}

/**
 * Normalises a Date to a UTC date-only value (midnight UTC), discarding the
 * time component. Delivery dates are calendar days, never instants.
 */
export function toDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Generates the ordered list of calendar delivery dates in the inclusive range
 * [start, end]. DAILY delivers every calendar day; ALTERNATE_DAYS delivers
 * every other calendar day, with the first delivery on `start` itself.
 */
export function generateDeliveryDates(
  frequency: DeliveryFrequency,
  start: Date,
  end: Date,
): Date[] {
  const step = frequency === DeliveryFrequency.DAILY ? 1 : 2;
  const last = toDateOnly(end).getTime();
  const dates: Date[] = [];
  let cursor = toDateOnly(start);
  while (cursor.getTime() <= last) {
    dates.push(new Date(cursor));
    const next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + step);
    cursor = next;
  }
  return dates;
}

/**
 * Resolves the litres for a given 1-based delivery OCCURRENCE. FIXED is constant;
 * ALTERNATING alternates by occurrence (odd -> A, even -> B) — never by calendar
 * day. This is the single source of truth for the alternating rule, shared by
 * quote totals, delivery generation and Manage Delivery.
 */
export function quantityForOccurrence(
  quantityMode: QuantityMode,
  occurrence: number,
  quantity?: number | null,
  quantityA?: number | null,
  quantityB?: number | null,
): number {
  if (quantityMode === QuantityMode.FIXED) {
    return quantity ?? 0;
  }
  return occurrence % 2 === 1 ? (quantityA ?? 0) : (quantityB ?? 0);
}

// ─── Service ────────────────────────────────────────────────────────

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Plans Overview ──────────────────────────────────────────────

  async getPlansOverview(userId: string): Promise<PlansOverviewResponse> {
    const [buyOnceElig, trialElig] = await Promise.all([
      this.getBuyOnceEligibility(userId),
      this.getTrialEligibility(userId),
    ]);

    return {
      plans: [
        {
          type: PlanType.BUY_ONCE,
          available: buyOnceElig.eligible,
          usageCount: buyOnceElig.usageCount,
          remainingUses: buyOnceElig.remainingUses,
          ...(buyOnceElig.blockedReason
            ? { blockedReason: buyOnceElig.blockedReason }
            : {}),
        },
        {
          type: PlanType.SEVEN_DAY_TRIAL,
          available: trialElig.eligible,
          used: trialElig.used,
          ...(trialElig.blockedReason
            ? { blockedReason: trialElig.blockedReason }
            : {}),
        },
        {
          type: PlanType.MONTHLY,
          available: true,
        },
      ],
    };
  }

  // ── Buy Once ────────────────────────────────────────────────────

  async getBuyOnceEligibility(userId: string): Promise<EligibilityResponse> {
    const config = await this.getActiveConfig(PlanType.BUY_ONCE);
    if (!config) {
      return {
        eligible: false,
        usageCount: 0,
        remainingUses: 0,
        maxUses: 0,
        blockedReason: "PLAN_NOT_CONFIGURED",
      };
    }

    // If Trial has ever been used, Buy Once is disabled.
    const trialUsed = await this.hasUsedPlan(userId, PlanType.SEVEN_DAY_TRIAL);
    if (trialUsed) {
      const usageCount = await this.countUsages(userId, PlanType.BUY_ONCE);
      return {
        eligible: false,
        usageCount,
        remainingUses: 0,
        maxUses: config.maxUsages,
        blockedReason: "TRIAL_ALREADY_USED",
      };
    }

    const usageCount = await this.countUsages(userId, PlanType.BUY_ONCE);
    const remaining = Math.max(0, config.maxUsages - usageCount);

    return {
      eligible: remaining > 0,
      usageCount,
      remainingUses: remaining,
      maxUses: config.maxUsages,
      maxQuantityLitres: config.quantityMax,
      ...(remaining === 0 ? { blockedReason: "MAX_USES_REACHED" } : {}),
    };
  }

  async createBuyOnceQuote(
    userId: string,
    dto: BuyOnceQuoteDto,
  ): Promise<QuoteResponse> {
    const eligibility = await this.getBuyOnceEligibility(userId);
    if (!eligibility.eligible) {
      throw new ForbiddenException(
        `Buy Once is not available: ${eligibility.blockedReason ?? "ineligible"}`,
      );
    }

    const config = await this.requireActiveConfig(PlanType.BUY_ONCE);
    this.validateQuantityRange(dto.quantityLitres, config.quantityMin, config.quantityMax);

    const totalLitres = dto.quantityLitres;
    const totalActual = totalLitres * config.actualPricePerLitre;
    const totalSelling = totalLitres * config.sellingPricePerLitre;
    const discount = totalActual - totalSelling;

    const expiresAt = new Date(
      Date.now() + QUOTE_EXPIRY_MINUTES * 60 * 1000,
    );

    const quote = await this.prisma.planQuote.create({
      data: {
        userId,
        planType: PlanType.BUY_ONCE,
        status: PlanQuoteStatus.PENDING,
        quantity: dto.quantityLitres,
        actualPricePerLitre: config.actualPricePerLitre,
        sellingPricePerLitre: config.sellingPricePerLitre,
        deliveryOccurrences: 1,
        totalLitres,
        totalActualAmount: totalActual,
        totalSellingAmount: totalSelling,
        discountAmount: discount,
        expiresAt,
      },
    });

    return {
      quoteId: quote.id,
      plan: PlanType.BUY_ONCE,
      quantity: dto.quantityLitres,
      deliveryOccurrences: 1,
      actualPricePerLitre: config.actualPricePerLitre,
      sellingPricePerLitre: config.sellingPricePerLitre,
      totalLitres,
      totalActualAmount: totalActual,
      totalSellingAmount: totalSelling,
      discountAmount: discount,
      expiresAt,
    };
  }

  // ── 7-Day Trial ─────────────────────────────────────────────────

  async getTrialEligibility(userId: string): Promise<EligibilityResponse> {
    const config = await this.getActiveConfig(PlanType.SEVEN_DAY_TRIAL);
    if (!config) {
      return {
        eligible: false,
        used: false,
        blockedReason: "PLAN_NOT_CONFIGURED",
      };
    }

    // If Buy Once has ever been used, Trial is disabled.
    const buyOnceUsed = await this.hasUsedPlan(userId, PlanType.BUY_ONCE);
    if (buyOnceUsed) {
      return {
        eligible: false,
        used: false,
        trialDurationDays: config.trialDurationDays,
        maxQuantityLitres: config.quantityMax,
        blockedReason: "BUY_ONCE_ALREADY_USED",
      };
    }

    const trialUsed = await this.hasUsedPlan(userId, PlanType.SEVEN_DAY_TRIAL);
    if (trialUsed) {
      return {
        eligible: false,
        used: true,
        trialDurationDays: config.trialDurationDays,
        maxQuantityLitres: config.quantityMax,
        blockedReason: "TRIAL_ALREADY_USED",
      };
    }

    return {
      eligible: true,
      used: false,
      trialDurationDays: config.trialDurationDays,
      maxQuantityLitres: config.quantityMax,
    };
  }

  async createTrialQuote(
    userId: string,
    dto: TrialQuoteDto,
  ): Promise<QuoteResponse> {
    const eligibility = await this.getTrialEligibility(userId);
    if (!eligibility.eligible) {
      throw new ForbiddenException(
        `7-Day Trial is not available: ${eligibility.blockedReason ?? "ineligible"}`,
      );
    }

    const config = await this.requireActiveConfig(PlanType.SEVEN_DAY_TRIAL);
    this.validateQuantityRange(dto.quantityLitres, config.quantityMin, config.quantityMax);

    const deliveryOccurrences = config.trialDurationDays;
    const totalLitres = deliveryOccurrences * dto.quantityLitres;
    const totalActual = totalLitres * config.actualPricePerLitre;
    const totalSelling = totalLitres * config.sellingPricePerLitre;
    const discount = totalActual - totalSelling;

    const expiresAt = new Date(
      Date.now() + QUOTE_EXPIRY_MINUTES * 60 * 1000,
    );

    const quote = await this.prisma.planQuote.create({
      data: {
        userId,
        planType: PlanType.SEVEN_DAY_TRIAL,
        status: PlanQuoteStatus.PENDING,
        quantity: dto.quantityLitres,
        actualPricePerLitre: config.actualPricePerLitre,
        sellingPricePerLitre: config.sellingPricePerLitre,
        deliveryOccurrences,
        totalLitres,
        totalActualAmount: totalActual,
        totalSellingAmount: totalSelling,
        discountAmount: discount,
        expiresAt,
      },
    });

    return {
      quoteId: quote.id,
      plan: PlanType.SEVEN_DAY_TRIAL,
      quantity: dto.quantityLitres,
      durationDays: config.trialDurationDays,
      deliveryOccurrences,
      actualPricePerLitre: config.actualPricePerLitre,
      sellingPricePerLitre: config.sellingPricePerLitre,
      totalLitres,
      totalActualAmount: totalActual,
      totalSellingAmount: totalSelling,
      discountAmount: discount,
      expiresAt,
    };
  }

  // ── Monthly ─────────────────────────────────────────────────────

  async getMonthlyInfo(): Promise<MonthlyInfoResponse> {
    const config = await this.getActiveConfig(PlanType.MONTHLY);
    if (!config) {
      return {
        available: false,
        frequencies: [],
        quantityModes: [],
        quantityMin: 0,
        quantityMax: 0,
        actualPricePerLitre: 0,
        sellingPricePerLitre: 0,
      };
    }

    return {
      available: true,
      frequencies: Object.values(DeliveryFrequency),
      quantityModes: Object.values(QuantityMode),
      quantityMin: config.quantityMin,
      quantityMax: config.quantityMax,
      actualPricePerLitre: config.actualPricePerLitre,
      sellingPricePerLitre: config.sellingPricePerLitre,
    };
  }

  async createMonthlyQuote(
    userId: string,
    dto: MonthlyQuoteDto,
  ): Promise<QuoteResponse> {
    const config = await this.requireActiveConfig(PlanType.MONTHLY);

    // Validate quantities based on mode
    if (dto.quantityMode === QuantityMode.FIXED) {
      if (dto.quantity === undefined || dto.quantity === null) {
        throw new BadRequestException("quantity is required for FIXED mode");
      }
      this.validateQuantityRange(dto.quantity, config.quantityMin, config.quantityMax);
    } else {
      if (dto.quantityA === undefined || dto.quantityA === null) {
        throw new BadRequestException("quantityA is required for ALTERNATING mode");
      }
      if (dto.quantityB === undefined || dto.quantityB === null) {
        throw new BadRequestException("quantityB is required for ALTERNATING mode");
      }
      this.validateQuantityRange(dto.quantityA, config.quantityMin, config.quantityMax);
      this.validateQuantityRange(dto.quantityB, config.quantityMin, config.quantityMax);
    }

    // Calculate delivery occurrences for the current billing month.
    const billingStart = new Date();
    const deliveryOccurrences = calculateMonthlyDeliveryOccurrences(
      dto.frequency,
      billingStart,
    );

    const billingEnd = new Date(
      billingStart.getFullYear(),
      billingStart.getMonth() + 1,
      0,
      23, 59, 59, 999,
    );

    const totalLitres = calculateTotalLitres(
      dto.frequency,
      dto.quantityMode,
      deliveryOccurrences,
      dto.quantity,
      dto.quantityA,
      dto.quantityB,
    );

    const totalActual = totalLitres * config.actualPricePerLitre;
    const totalSelling = totalLitres * config.sellingPricePerLitre;
    const discount = totalActual - totalSelling;

    const expiresAt = new Date(
      Date.now() + QUOTE_EXPIRY_MINUTES * 60 * 1000,
    );

    const quote = await this.prisma.planQuote.create({
      data: {
        userId,
        planType: PlanType.MONTHLY,
        status: PlanQuoteStatus.PENDING,
        frequency: dto.frequency,
        quantityMode: dto.quantityMode,
        quantity: dto.quantityMode === QuantityMode.FIXED ? dto.quantity : null,
        quantityA:
          dto.quantityMode === QuantityMode.ALTERNATING ? dto.quantityA : null,
        quantityB:
          dto.quantityMode === QuantityMode.ALTERNATING ? dto.quantityB : null,
        actualPricePerLitre: config.actualPricePerLitre,
        sellingPricePerLitre: config.sellingPricePerLitre,
        deliveryOccurrences,
        totalLitres,
        totalActualAmount: totalActual,
        totalSellingAmount: totalSelling,
        discountAmount: discount,
        billingPeriodStart: billingStart,
        billingPeriodEnd: billingEnd,
        expiresAt,
      },
    });

    return {
      quoteId: quote.id,
      plan: PlanType.MONTHLY,
      frequency: dto.frequency,
      quantityMode: dto.quantityMode,
      ...(dto.quantityMode === QuantityMode.FIXED
        ? { quantity: dto.quantity }
        : { quantityA: dto.quantityA, quantityB: dto.quantityB }),
      deliveryOccurrences,
      actualPricePerLitre: config.actualPricePerLitre,
      sellingPricePerLitre: config.sellingPricePerLitre,
      totalLitres,
      totalActualAmount: totalActual,
      totalSellingAmount: totalSelling,
      discountAmount: discount,
      expiresAt,
    };
  }

  // ── Confirm Plan ────────────────────────────────────────────────

  async confirmPlan(
    userId: string,
    dto: ConfirmPlanDto,
  ): Promise<ConfirmationResponse> {
    return this.prisma.$transaction(async (tx) => {
      const quote = await tx.planQuote.findUnique({
        where: { id: dto.quoteId },
      });

      if (!quote) {
        throw new NotFoundException("Quote not found");
      }

      if (quote.userId !== userId) {
        throw new NotFoundException("Quote not found");
      }

      if (quote.status !== PlanQuoteStatus.PENDING) {
        throw new BadRequestException(
          `Quote is no longer pending (status: ${quote.status})`,
        );
      }

      if (quote.expiresAt < new Date()) {
        // Mark expired and reject.
        await tx.planQuote.update({
          where: { id: quote.id },
          data: { status: PlanQuoteStatus.EXPIRED },
        });
        throw new BadRequestException("Quote has expired");
      }

      // Re-check eligibility inside the transaction.
      if (quote.planType === PlanType.BUY_ONCE) {
        const trialUsed = await this.hasUsedPlanTx(tx, userId, PlanType.SEVEN_DAY_TRIAL);
        if (trialUsed) {
          throw new ForbiddenException("Buy Once is no longer available");
        }
        const usageCount = await this.countUsagesTx(tx, userId, PlanType.BUY_ONCE);
        const config = await this.getActiveConfig(PlanType.BUY_ONCE);
        if (!config || usageCount >= config.maxUsages) {
          throw new ForbiddenException("Buy Once maximum uses reached");
        }
      } else if (quote.planType === PlanType.SEVEN_DAY_TRIAL) {
        const buyOnceUsed = await this.hasUsedPlanTx(tx, userId, PlanType.BUY_ONCE);
        if (buyOnceUsed) {
          throw new ForbiddenException("7-Day Trial is no longer available");
        }
        const trialUsed = await this.hasUsedPlanTx(tx, userId, PlanType.SEVEN_DAY_TRIAL);
        if (trialUsed) {
          throw new ForbiddenException("7-Day Trial has already been used");
        }
      }

      // Atomically transition the quote PENDING -> CONFIRMED. Using a guarded
      // updateMany (rather than a plain update after the status check above)
      // makes the transition race-safe: under READ COMMITTED isolation Postgres
      // re-evaluates the `status: PENDING` predicate against the latest
      // committed row version, so a second concurrent confirmation of the same
      // quote matches zero rows and is rejected instead of producing a duplicate
      // PlanSelection (double-spend).
      const transition = await tx.planQuote.updateMany({
        where: { id: quote.id, status: PlanQuoteStatus.PENDING },
        data: { status: PlanQuoteStatus.CONFIRMED },
      });
      if (transition.count === 0) {
        throw new BadRequestException(
          "Quote is no longer pending (it may have just been confirmed)",
        );
      }

      // Derive the concrete delivery schedule window + live (mutable) config
      // from the immutable quote snapshot. This is what Manage Delivery edits.
      const schedule = this.resolveScheduleFromQuote(quote);

      // Create the plan selection record, seeding the live schedule config.
      const selection = await tx.planSelection.create({
        data: {
          userId,
          quoteId: quote.id,
          planType: quote.planType as PlanType,
          status: PlanSelectionStatus.CONFIRMED,
          frequency: schedule.frequency,
          quantityMode: schedule.quantityMode,
          quantity: schedule.quantity,
          quantityA: schedule.quantityA,
          quantityB: schedule.quantityB,
          startDate: schedule.start,
          endDate: schedule.end,
        },
      });

      // Materialise one PlanDelivery row per scheduled date so that Manage
      // Delivery can enforce future-only edits and keep history immutable.
      const dates = generateDeliveryDates(
        schedule.frequency,
        schedule.start,
        schedule.end,
      );
      if (dates.length > 0) {
        await tx.planDelivery.createMany({
          data: dates.map((date, i) => ({
            selectionId: selection.id,
            userId,
            deliveryDate: date,
            occurrence: i + 1,
            quantityLitres: quantityForOccurrence(
              schedule.quantityMode,
              i + 1,
              schedule.quantity,
              schedule.quantityA,
              schedule.quantityB,
            ),
            status: DeliveryStatus.SCHEDULED,
          })),
        });
      }

      return {
        selectionId: selection.id,
        quoteId: quote.id,
        plan: quote.planType,
        status: selection.status,
      };
    });
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Translates an immutable quote into a concrete delivery-schedule window and
   * the live schedule config to seed onto the selection.
   *
   * - MONTHLY: uses the quote's billing period + frequency/quantity config.
   * - SEVEN_DAY_TRIAL: `deliveryOccurrences` consecutive DAILY deliveries.
   * - BUY_ONCE: a single DAILY delivery on the start day.
   */
  private resolveScheduleFromQuote(quote: {
    planType: string;
    frequency: string | null;
    quantityMode: string | null;
    quantity: number | null;
    quantityA: number | null;
    quantityB: number | null;
    deliveryOccurrences: number;
    billingPeriodStart: Date | null;
    billingPeriodEnd: Date | null;
  }): {
    frequency: DeliveryFrequency;
    quantityMode: QuantityMode;
    quantity: number | null;
    quantityA: number | null;
    quantityB: number | null;
    start: Date;
    end: Date;
  } {
    if (quote.planType === PlanType.MONTHLY) {
      const start = toDateOnly(quote.billingPeriodStart ?? new Date());
      const end = toDateOnly(quote.billingPeriodEnd ?? new Date());
      return {
        frequency:
          (quote.frequency as DeliveryFrequency | null) ??
          DeliveryFrequency.DAILY,
        quantityMode:
          (quote.quantityMode as QuantityMode | null) ?? QuantityMode.FIXED,
        quantity: quote.quantity,
        quantityA: quote.quantityA,
        quantityB: quote.quantityB,
        start,
        end,
      };
    }

    // BUY_ONCE (1 delivery) and SEVEN_DAY_TRIAL (N daily deliveries) are both
    // FIXED-quantity DAILY schedules starting today.
    const start = toDateOnly(new Date());
    const occurrences =
      quote.planType === PlanType.SEVEN_DAY_TRIAL
        ? Math.max(1, quote.deliveryOccurrences)
        : 1;
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + (occurrences - 1));
    return {
      frequency: DeliveryFrequency.DAILY,
      quantityMode: QuantityMode.FIXED,
      quantity: quote.quantity,
      quantityA: null,
      quantityB: null,
      start,
      end,
    };
  }

  private async getActiveConfig(planType: PlanType) {
    return this.prisma.planConfig.findFirst({
      where: { planType, isActive: true },
    });
  }

  private async requireActiveConfig(planType: PlanType) {
    const config = await this.getActiveConfig(planType);
    if (!config) {
      throw new BadRequestException(
        `Plan ${planType} is not currently configured or active`,
      );
    }
    return config;
  }

  private async hasUsedPlan(userId: string, planType: PlanType): Promise<boolean> {
    const count = await this.prisma.planSelection.count({
      where: {
        userId,
        planType,
        status: { not: PlanSelectionStatus.CANCELLED },
      },
    });
    return count > 0;
  }

  private async hasUsedPlanTx(
    tx: Parameters<Parameters<PrismaService["$transaction"]>[0]>[0],
    userId: string,
    planType: PlanType,
  ): Promise<boolean> {
    const count = await (tx as any).planSelection.count({
      where: {
        userId,
        planType,
        status: { not: PlanSelectionStatus.CANCELLED },
      },
    });
    return count > 0;
  }

  private async countUsages(userId: string, planType: PlanType): Promise<number> {
    return this.prisma.planSelection.count({
      where: {
        userId,
        planType,
        status: { not: PlanSelectionStatus.CANCELLED },
      },
    });
  }

  private async countUsagesTx(
    tx: Parameters<Parameters<PrismaService["$transaction"]>[0]>[0],
    userId: string,
    planType: PlanType,
  ): Promise<number> {
    return (tx as any).planSelection.count({
      where: {
        userId,
        planType,
        status: { not: PlanSelectionStatus.CANCELLED },
      },
    });
  }

  private validateQuantityRange(qty: number, min: number, max: number): void {
    if (!Number.isInteger(qty)) {
      throw new BadRequestException("Quantity must be a whole number");
    }
    if (qty < min || qty > max) {
      throw new BadRequestException(
        `Quantity must be between ${min} and ${max}`,
      );
    }
  }
}
