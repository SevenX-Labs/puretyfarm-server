import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import type { PlanConfig } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { WalletService } from "../wallet/wallet.service";
import { WalletTransactionReferenceType } from "../wallet/wallet.constants";
import {
  PlanType,
  DeliveryFrequency,
  QuantityMode,
  PlanQuoteStatus,
  PlanSelectionStatus,
  DeliveryStatus,
  QUOTE_EXPIRY_MINUTES,
  TRIAL_MAX_USES,
  TRIAL_DURATION_DAYS,
} from "./plans.constants";
import { BuyOnceQuoteDto } from "./dto/customer/buy-once-quote.dto";
import { TrialQuoteDto } from "./dto/customer/trial-quote.dto";
import { MonthlyQuoteDto } from "./dto/customer/monthly-quote.dto";
import { ConfirmPlanDto, PlanPaymentMethod } from "./dto/customer/confirm-plan.dto";
import { parseUpdateAdminPlanDto } from "./dto/admin/update-admin-plan.dto";

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

// NOTE: all monetary fields below (`*PricePerLitre`, `*Amount`, `discountAmount`)
// are INTEGER PAISE, never rupees and never floats. Divide by 100 for display.
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

// Admin view of one PlanConfig row. Prices are INTEGER PAISE. Only fields that
// apply to the plan type are included.
export interface AdminPlanConfigResponse {
  type: PlanType;
  isActive: boolean;
  actualPricePerLitre: number;
  sellingPricePerLitre: number;
  quantityMin: number;
  quantityMax: number;
  /** BUY_ONCE: configurable. SEVEN_DAY_TRIAL: fixed business rule (read-only). */
  maxUsages?: number;
  /** SEVEN_DAY_TRIAL: fixed business rule (read-only 7 days). */
  trialDurationDays?: number;
  dailyEnabled?: boolean;
  alternateDaysEnabled?: boolean;
  fixedQuantityEnabled?: boolean;
  alternatingQuantityEnabled?: boolean;
  /** MONTHLY: derived from the toggles — exactly what customers are offered. */
  frequencies?: DeliveryFrequency[];
  quantityModes?: QuantityMode[];
  deliveryFeePaise: number;
  deliveryStartTime: string | null;
  deliveryEndTime: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminPlansResponse {
  plans: AdminPlanConfigResponse[];
  /** Plan types with no PlanConfig row yet (initialise one via PATCH). */
  unconfigured: PlanType[];
}

export interface ConfirmationResponse {
  selectionId: string;
  quoteId: string;
  plan: string;
  status: string;
  paymentMethod: string;
  paidAmountPaise: number;
  cashCollectionId?: string;
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
  // Count the actual delivery dates from the plan's START DATE through the end
  // of that calendar month. This is start-date aware: a plan beginning mid-month
  // is NOT charged for deliveries before its start date, and the count always
  // matches the dates produced by generateDeliveryDates (single source of truth).
  // The calendar month's real length (28/29/30/31) is respected automatically.
  const start = toDateOnly(startDate);
  const monthEnd = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  );
  return generateDeliveryDates(frequency, start, monthEnd).length;
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
  // Pin to the LOCAL calendar date (the business day), represented as UTC
  // midnight so downstream UTC date-stepping and ISO formatting stay stable.
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
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

/** Monthly delivery frequencies the admin has enabled, in enum order. */
export function enabledFrequencies(config: PlanConfig): DeliveryFrequency[] {
  return [
    ...(config.dailyEnabled ? [DeliveryFrequency.DAILY] : []),
    ...(config.alternateDaysEnabled ? [DeliveryFrequency.ALTERNATE_DAYS] : []),
  ];
}

/** Monthly quantity modes the admin has enabled, in enum order. */
export function enabledQuantityModes(config: PlanConfig): QuantityMode[] {
  return [
    ...(config.fixedQuantityEnabled ? [QuantityMode.FIXED] : []),
    ...(config.alternatingQuantityEnabled ? [QuantityMode.ALTERNATING] : []),
  ];
}

/** Column defaults from the PlanConfig model, used to validate a new row. */
const PLAN_CONFIG_DEFAULTS = {
  quantityMin: 1,
  quantityMax: 5,
  trialDurationDays: TRIAL_DURATION_DAYS,
  dailyEnabled: true,
  alternateDaysEnabled: true,
  fixedQuantityEnabled: true,
  alternatingQuantityEnabled: true,
};

/** Maps a PlanConfig row to the admin response, exposing only relevant fields. */
export function toAdminPlanResponse(config: PlanConfig): AdminPlanConfigResponse {
  const type = config.planType as PlanType;
  const base = {
    type,
    isActive: config.isActive,
    actualPricePerLitre: config.actualPricePerLitre,
    sellingPricePerLitre: config.sellingPricePerLitre,
    quantityMin: config.quantityMin,
    quantityMax: config.quantityMax,
    deliveryFeePaise: config.deliveryFeePaise,
    deliveryStartTime: config.deliveryStartTime,
    deliveryEndTime: config.deliveryEndTime,
  };
  const timestamps = { createdAt: config.createdAt, updatedAt: config.updatedAt };

  switch (type) {
    case PlanType.BUY_ONCE:
      return { ...base, maxUsages: config.maxUsages, ...timestamps };
    case PlanType.SEVEN_DAY_TRIAL:
      return {
        ...base,
        trialDurationDays: TRIAL_DURATION_DAYS,
        maxUsages: TRIAL_MAX_USES,
        ...timestamps,
      };
    case PlanType.MONTHLY:
      return {
        ...base,
        dailyEnabled: config.dailyEnabled,
        alternateDaysEnabled: config.alternateDaysEnabled,
        fixedQuantityEnabled: config.fixedQuantityEnabled,
        alternatingQuantityEnabled: config.alternatingQuantityEnabled,
        frequencies: enabledFrequencies(config),
        quantityModes: enabledQuantityModes(config),
        ...timestamps,
      };
  }
}

// ─── Service ────────────────────────────────────────────────────────

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  // ── Plans Overview ──────────────────────────────────────────────

  async getPlansOverview(userId: string): Promise<PlansOverviewResponse> {
    const [buyOnceElig, trialElig, monthlyConfig] = await Promise.all([
      this.getBuyOnceEligibility(userId),
      this.getTrialEligibility(userId),
      this.getActiveConfig(PlanType.MONTHLY),
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
          available: monthlyConfig !== null,
          ...(monthlyConfig ? {} : { blockedReason: "PLAN_NOT_CONFIGURED" }),
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
        trialDurationDays: TRIAL_DURATION_DAYS,
        maxQuantityLitres: config.quantityMax,
        blockedReason: "BUY_ONCE_ALREADY_USED",
      };
    }

    const trialUsed = await this.hasUsedPlan(userId, PlanType.SEVEN_DAY_TRIAL);
    if (trialUsed) {
      return {
        eligible: false,
        used: true,
        trialDurationDays: TRIAL_DURATION_DAYS,
        maxQuantityLitres: config.quantityMax,
        blockedReason: "TRIAL_ALREADY_USED",
      };
    }

    return {
      eligible: true,
      used: false,
      trialDurationDays: TRIAL_DURATION_DAYS,
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

    const deliveryOccurrences = TRIAL_DURATION_DAYS;
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
      durationDays: TRIAL_DURATION_DAYS,
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
      frequencies: enabledFrequencies(config),
      quantityModes: enabledQuantityModes(config),
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
    this.assertMonthlyOptionsEnabled(config, dto.frequency, dto.quantityMode);

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

    // The plan starts today (date-only) and the billing window runs to the end
    // of the current calendar month. Occurrences are counted from the actual
    // start date, so a mid-month start is never charged for earlier dates.
    const billingStart = toDateOnly(new Date());
    const deliveryOccurrences = calculateMonthlyDeliveryOccurrences(
      dto.frequency,
      billingStart,
    );

    const billingEnd = new Date(
      Date.UTC(
        billingStart.getUTCFullYear(),
        billingStart.getUTCMonth() + 1,
        0,
      ),
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;

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
        await tx.planQuote.update({
          where: { id: quote.id },
          data: { status: PlanQuoteStatus.EXPIRED },
        });
        throw new BadRequestException("Quote has expired");
      }

      const activeConfig = await this.getActiveConfigTx(tx, quote.planType as PlanType);
      if (!activeConfig) {
        throw new ForbiddenException(
          `Plan ${quote.planType} is not currently available`,
        );
      }
      if (quote.planType === PlanType.MONTHLY) {
        this.assertMonthlyOptionsEnabled(
          activeConfig,
          quote.frequency as DeliveryFrequency,
          quote.quantityMode as QuantityMode,
          ForbiddenException,
        );
      }

      if (quote.planType === PlanType.BUY_ONCE) {
        const trialUsed = await this.hasUsedPlanTx(tx, userId, PlanType.SEVEN_DAY_TRIAL);
        if (trialUsed) {
          throw new ForbiddenException("Buy Once is no longer available");
        }
        const usageCount = await this.countUsagesTx(tx, userId, PlanType.BUY_ONCE);
        const config = await this.getActiveConfigTx(tx, PlanType.BUY_ONCE);
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

      const schedule = this.resolveScheduleFromQuote(quote);
      const paymentAmount = quote.totalSellingAmount;

      // Step 1: Create PlanSelection in PENDING_PAYMENT state first, so we have
      // the ID for the wallet ledger reference before the debit.
      const selection = await tx.planSelection.create({
        data: {
          userId,
          quoteId: quote.id,
          planType: quote.planType as PlanType,
          status: PlanSelectionStatus.PENDING_PAYMENT,
          paymentMethod: dto.paymentMethod,
          frequency: schedule.frequency,
          quantityMode: schedule.quantityMode,
          quantity: schedule.quantity,
          quantityA: schedule.quantityA,
          quantityB: schedule.quantityB,
          startDate: schedule.start,
          endDate: schedule.end,
        },
      });

      if (dto.paymentMethod === PlanPaymentMethod.WALLET) {
        // Check balance before attempting debit for a clearer error.
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        if (!wallet || wallet.balancePaise < paymentAmount) {
          // Rollback: delete the PENDING_PAYMENT selection so it doesn't
          // block future attempts via the partial unique index.
          await tx.planSelection.delete({ where: { id: selection.id } });
          throw new BadRequestException({
            error: "INSUFFICIENT_WALLET_BALANCE",
            message: "Insufficient wallet balance",
            currentBalancePaise: wallet?.balancePaise ?? 0,
            requiredPaise: paymentAmount,
            shortfallPaise: paymentAmount - (wallet?.balancePaise ?? 0),
          });
        }

        // Debit wallet using the existing atomic balance path.
        await this.walletService.debitWalletWithin(
          tx,
          userId,
          paymentAmount,
          WalletTransactionReferenceType.PLAN_SELECTION,
          selection.id,
          `Plan payment (${quote.planType})`,
        );

        // Payment succeeded — confirm everything atomically.
        const now = new Date();
        await tx.planSelection.update({
          where: { id: selection.id },
          data: {
            status: PlanSelectionStatus.CONFIRMED,
            paidAt: now,
            paidAmountPaise: paymentAmount,
          },
        });

        await tx.planQuote.updateMany({
          where: { id: quote.id, status: PlanQuoteStatus.PENDING },
          data: { status: PlanQuoteStatus.CONFIRMED },
        });

        // Materialise delivery rows only after payment.
        await this.materializeDeliveries(tx, selection.id, userId, schedule);

        return {
          selectionId: selection.id,
          quoteId: quote.id,
          plan: quote.planType,
          status: PlanSelectionStatus.CONFIRMED,
          paymentMethod: dto.paymentMethod,
          paidAmountPaise: paymentAmount,
        };
      }

      // CASH payment: create CashCollection, do NOT activate plan.
      const cashCollection = await tx.cashCollection.create({
        data: {
          userId,
          planSelectionId: selection.id,
          amountPaise: paymentAmount,
          status: "PENDING",
        },
      });

      // Quote stays PENDING until admin confirms the cash.

      return {
        selectionId: selection.id,
        quoteId: quote.id,
        plan: quote.planType,
        status: PlanSelectionStatus.PENDING_PAYMENT,
        paymentMethod: dto.paymentMethod,
        paidAmountPaise: paymentAmount,
        cashCollectionId: cashCollection.id,
      };
    });
  }

  /**
   * Materialises PlanDelivery rows from a schedule. Extracted so it can be
   * called both from wallet payment (inline) and cash confirmation (admin).
   */
  async materializeDeliveries(
    tx: Parameters<Parameters<PrismaService["$transaction"]>[0]>[0],
    selectionId: string,
    userId: string,
    schedule: ReturnType<PlansService["resolveScheduleFromQuote"]>,
  ): Promise<void> {
    const dates = generateDeliveryDates(
      schedule.frequency,
      schedule.start,
      schedule.end,
    );
    if (dates.length > 0) {
      await (tx as any).planDelivery.createMany({
        data: dates.map((date, i) => ({
          selectionId,
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
  }

  /**
   * Called by the Payments module when an admin confirms a plan cash payment.
   * Completes the plan purchase atomically.
   */
  async confirmPlanAfterCashPayment(
    tx: Parameters<Parameters<PrismaService["$transaction"]>[0]>[0],
    planSelectionId: string,
  ): Promise<void> {
    const selection = await (tx as any).planSelection.findUnique({
      where: { id: planSelectionId },
      include: { quote: true },
    });

    if (!selection) {
      throw new NotFoundException("Plan selection not found");
    }

    if (selection.status !== PlanSelectionStatus.PENDING_PAYMENT) {
      throw new BadRequestException(
        `Plan selection is not pending payment (status: ${selection.status})`,
      );
    }

    const now = new Date();

    await (tx as any).planSelection.update({
      where: { id: planSelectionId },
      data: {
        status: PlanSelectionStatus.CONFIRMED,
        paidAt: now,
        paidAmountPaise: selection.quote.totalSellingAmount,
      },
    });

    await (tx as any).planQuote.updateMany({
      where: { id: selection.quoteId, status: PlanQuoteStatus.PENDING },
      data: { status: PlanQuoteStatus.CONFIRMED },
    });

    const schedule = this.resolveScheduleFromQuote(selection.quote);
    await this.materializeDeliveries(tx, planSelectionId, selection.userId, schedule);
  }

  // ── Admin: Plan Configuration ───────────────────────────────────
  //
  // Admins edit the SAME PlanConfig rows the customer methods above read, so a
  // change applies to the next customer eligibility check / quote. Admin
  // identity is enforced by the controller guard and never reaches this layer.

  async getAdminPlans(): Promise<AdminPlansResponse> {
    const configs = await this.prisma.planConfig.findMany();
    const byType = new Map(configs.map((c) => [c.planType as PlanType, c]));
    const order = Object.values(PlanType);
    return {
      plans: order
        .filter((t) => byType.has(t))
        .map((t) => toAdminPlanResponse(byType.get(t)!)),
      unconfigured: order.filter((t) => !byType.has(t)),
    };
  }

  async getAdminPlan(planType: PlanType): Promise<AdminPlanConfigResponse> {
    const config = await this.prisma.planConfig.findUnique({
      where: { planType },
    });
    if (!config) {
      throw new NotFoundException(`Plan ${planType} is not configured`);
    }
    return toAdminPlanResponse(config);
  }

  /**
   * Partially updates a plan's configuration. `body` is validated against the
   * plan-specific DTO, then the MERGED result (stored + incoming) is checked
   * for cross-field consistency before anything is written.
   *
   * If the plan has no row yet, it is initialised — but only when both prices
   * are supplied, since prices have no safe default. Plan types are a fixed
   * enum, so this can never create an arbitrary plan.
   */
  async updateAdminPlan(
    planType: PlanType,
    body: unknown,
  ): Promise<AdminPlanConfigResponse> {
    const dto = await parseUpdateAdminPlanDto(planType, body);

    return this.prisma.$transaction(async (tx) => {
      // Serialise concurrent edits of the same plan so two partial updates
      // (e.g. min=4 and max=2) cannot each pass validation against a stale row.
      const lockKey = `plan_config:${planType}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

      const existing = await tx.planConfig.findUnique({ where: { planType } });

      if (existing) {
        this.validateAdminPlanConfiguration(planType, { ...existing, ...dto });
        const updated = await tx.planConfig.update({
          where: { planType },
          data: dto,
        });
        return toAdminPlanResponse(updated);
      }

      const { actualPricePerLitre, sellingPricePerLitre } = dto;
      if (actualPricePerLitre === undefined || sellingPricePerLitre === undefined) {
        throw new NotFoundException(
          `Plan ${planType} is not configured. Provide actualPricePerLitre and sellingPricePerLitre to initialise it.`,
        );
      }
      this.validateAdminPlanConfiguration(planType, {
        ...PLAN_CONFIG_DEFAULTS,
        ...dto,
        actualPricePerLitre,
        sellingPricePerLitre,
      });
      const created = await tx.planConfig.create({
        data: { ...dto, planType, actualPricePerLitre, sellingPricePerLitre },
      });
      return toAdminPlanResponse(created);
    });
  }

  /**
   * Cross-field rules that single-field DTO validation cannot express. Runs on
   * the merged config, so a PATCH of only `quantityMin` is still checked
   * against the stored `quantityMax`.
   */
  validateAdminPlanConfiguration(
    planType: PlanType,
    config: {
      actualPricePerLitre: number;
      sellingPricePerLitre: number;
      quantityMin: number;
      quantityMax: number;
      dailyEnabled: boolean;
      alternateDaysEnabled: boolean;
      fixedQuantityEnabled: boolean;
      alternatingQuantityEnabled: boolean;
    },
  ): void {
    if (config.quantityMin > config.quantityMax) {
      throw new BadRequestException(
        `quantityMin (${config.quantityMin}) cannot exceed quantityMax (${config.quantityMax})`,
      );
    }
    // A selling price above the actual price would yield a negative discount.
    if (config.sellingPricePerLitre > config.actualPricePerLitre) {
      throw new BadRequestException(
        `sellingPricePerLitre (${config.sellingPricePerLitre}) cannot exceed actualPricePerLitre (${config.actualPricePerLitre})`,
      );
    }
    if (planType === PlanType.MONTHLY) {
      if (!config.dailyEnabled && !config.alternateDaysEnabled) {
        throw new BadRequestException(
          "At least one Monthly frequency (dailyEnabled, alternateDaysEnabled) must be enabled",
        );
      }
      if (!config.fixedQuantityEnabled && !config.alternatingQuantityEnabled) {
        throw new BadRequestException(
          "At least one Monthly quantity mode (fixedQuantityEnabled, alternatingQuantityEnabled) must be enabled",
        );
      }
    }
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
  resolveScheduleFromQuote(quote: {
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

  private async getActiveConfigTx(
    tx: Parameters<Parameters<PrismaService["$transaction"]>[0]>[0],
    planType: PlanType,
  ) {
    return (tx as any).planConfig.findFirst({
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

  /**
   * Rejects a Monthly frequency / quantity mode the admin has disabled. The
   * DTO only proves the value is a known enum; this enforces the live config.
   */
  private assertMonthlyOptionsEnabled(
    config: PlanConfig,
    frequency: DeliveryFrequency,
    quantityMode: QuantityMode,
    Exception: new (message: string) => Error = BadRequestException,
  ): void {
    if (!enabledFrequencies(config).includes(frequency)) {
      throw new Exception(`Frequency ${frequency} is not currently available`);
    }
    if (!enabledQuantityModes(config).includes(quantityMode)) {
      throw new Exception(
        `Quantity mode ${quantityMode} is not currently available`,
      );
    }
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
