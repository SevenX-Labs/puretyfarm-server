import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
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
  ORDER_CUTOFF_HHMM,
  ORDER_CUTOFF_MINUTES_IST,
  LEAD_DAYS_BEFORE_CUTOFF,
  LEAD_DAYS_AFTER_CUTOFF,
} from "./plans.constants";
import {
  IST_TIMEZONE,
  toIstDateOnly,
  istMinutesSinceMidnight,
  addDays,
  toIsoDateString,
  parseHhMmToMinutes,
  formatHhMmTo12h,
  formatMinutesTo12h,
} from "../../common/utils/ist-date.util";
import { BuyOnceQuoteDto } from "./dto/customer/buy-once-quote.dto";
import { TrialQuoteDto } from "./dto/customer/trial-quote.dto";
import { MonthlyQuoteDto } from "./dto/customer/monthly-quote.dto";
import { ConfirmPlanDto, PlanPaymentMethod } from "./dto/customer/confirm-plan.dto";
import { parseUpdateAdminPlanDto } from "./dto/admin/update-admin-plan.dto";
import { ApproveSubscriptionPlanDto } from "./dto/admin/approve-subscription.dto";
import {
  generateOrderNumber,
  generateInvoiceNumber,
} from "../orders/order-number.util";

// ─── Response interfaces ────────────────────────────────────────────

export interface PlanAvailability {
  type: string;
  available: boolean;
  usageCount?: number;
  remainingUses?: number;
  maxUses?: number;
  used?: boolean;
  blockedReason?: string;
  deliveryStartTime?: string | null;
  deliveryEndTime?: string | null;
}

export interface PlansOverviewResponse {
  plans: PlanAvailability[];
  /**
   * The order cut-off policy, so the customer app can state it accurately
   * instead of hardcoding a time that may drift from the server's rule.
   */
  orderCutoff: OrderCutoffPolicy;
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
  /**
   * Configured delivery window, 24h "HH:MM". Null means the admin has not set
   * one; clients must show that as unavailable, never substitute a default.
   */
  deliveryStartTime: string | null;
  deliveryEndTime: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminPlansResponse {
  plans: AdminPlanConfigResponse[];
  /** Plan types with no PlanConfig row yet (initialise one via PATCH). */
  unconfigured: PlanType[];
  /**
   * The order cut-off, which is a business-wide policy rather than a per-plan
   * setting. Surfaced here so the admin UI shows the real rule next to each
   * plan's delivery window without restating it client-side.
   */
  orderCutoff: OrderCutoffPolicy;
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
  // Pin to the INDIAN calendar date (the business day), represented as UTC
  // midnight so downstream UTC date-stepping and ISO formatting stay stable.
  //
  // This used to read the server's local fields, which silently made the
  // business day follow Render's UTC clock: after 18:30 UTC it is already
  // tomorrow in India, so every date derived from "now" was a day behind.
  // Values that are already date-only (Postgres DATE columns, "YYYY-MM-DD"
  // strings) arrive as midnight UTC and are unaffected by the shift.
  return toIstDateOnly(d);
}

/** Parses a 24h "HH:MM" time into minutes since midnight, or null if malformed. */
export const parseDeliveryTimeMinutes = parseHhMmToMinutes;

/** Renders a 24h "HH:MM" time as 12h "h:mm AM/PM", or null if malformed. */
export const formatDeliveryTime12h = formatHhMmTo12h;

/** The order cut-off as the API and both frontends present it. */
export interface OrderCutoffPolicy {
  /** 24h "HH:MM" in `timezone`. */
  time: string;
  /** Human-readable form of `time`, e.g. "11:00 PM". */
  timeLabel: string;
  /** IANA zone the cut-off is evaluated in, always Asia/Kolkata. */
  timezone: string;
  /** Calendar days to the first delivery when ordering before the cut-off. */
  leadDaysBeforeCutoff: number;
  /** Calendar days to the first delivery when ordering at/after it. */
  leadDaysAfterCutoff: number;
}

/**
 * The single source of truth for the cut-off, shaped for API exposure so no
 * frontend has to restate the rule.
 */
export function getOrderCutoffPolicy(): OrderCutoffPolicy {
  return {
    time: ORDER_CUTOFF_HHMM,
    timeLabel: formatMinutesTo12h(ORDER_CUTOFF_MINUTES_IST),
    timezone: IST_TIMEZONE,
    leadDaysBeforeCutoff: LEAD_DAYS_BEFORE_CUTOFF,
    leadDaysAfterCutoff: LEAD_DAYS_AFTER_CUTOFF,
  };
}

/** Whether `now` falls at or after the cut-off on its own Indian calendar day. */
export function isAfterOrderCutoff(now: Date): boolean {
  return istMinutesSinceMidnight(now) >= ORDER_CUTOFF_MINUTES_IST;
}

/**
 * The earliest date a plan or order placed at `now` can be delivered on.
 *
 * Deliveries are never same-day: the morning run is loaded the night before,
 * so the best case is tomorrow. Ordering at or after 23:00 IST misses that
 * loading, pushing the first delivery to the day after.
 *
 *   10 Oct 22:59 IST -> 11 Oct
 *   10 Oct 23:00 IST -> 12 Oct   (the cut-off instant itself is "after")
 *   10 Oct 23:01 IST -> 12 Oct
 *
 * Both the calendar date and the wall clock are read in IST, so the result is
 * identical whether the process runs with TZ=UTC, TZ=Asia/Kolkata or anything
 * else. Day-stepping is calendar-based, so month-end and year-end roll over
 * correctly.
 *
 * Takes no delivery-window argument on purpose: the window says when the van
 * arrives, never whether an order still makes today's list.
 */
export function resolveFirstDeliveryDate(now: Date = new Date()): Date {
  const leadDays = isAfterOrderCutoff(now)
    ? LEAD_DAYS_AFTER_CUTOFF
    : LEAD_DAYS_BEFORE_CUTOFF;
  return addDays(toIstDateOnly(now), leadDays);
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
/**
 * Selection statuses from which an admin may approve a delivery schedule.
 *
 * PENDING_PAYMENT is included because a cash plan sits there until the admin
 * confirms the collection; the separate `paidAt` check above is what actually
 * enforces payment. CONFIRMED is included so re-setting the first delivery
 * date on an approved subscription stays possible. PAUSED, COMPLETED and
 * CANCELLED are excluded: scheduling those would resurrect or contradict a
 * decided lifecycle.
 */
const APPROVABLE_SELECTION_STATUSES: string[] = [
  PlanSelectionStatus.PENDING_PAYMENT,
  PlanSelectionStatus.CONFIRMED,
  PlanSelectionStatus.ACTIVE,
];

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
    const [buyOnceElig, trialElig, monthlyConfig, buyOnceConfig, trialConfig] = await Promise.all([
      this.getBuyOnceEligibility(userId),
      this.getTrialEligibility(userId),
      this.getActiveConfig(PlanType.MONTHLY),
      this.getActiveConfig(PlanType.BUY_ONCE),
      this.getActiveConfig(PlanType.SEVEN_DAY_TRIAL),
    ]);

    return {
      plans: [
        {
          type: PlanType.BUY_ONCE,
          available: buyOnceElig.eligible,
          usageCount: buyOnceElig.usageCount,
          remainingUses: buyOnceElig.remainingUses,
          deliveryStartTime: buyOnceConfig?.deliveryStartTime ?? null,
          deliveryEndTime: buyOnceConfig?.deliveryEndTime ?? null,
          ...(buyOnceElig.blockedReason
            ? { blockedReason: buyOnceElig.blockedReason }
            : {}),
        },
        {
          type: PlanType.SEVEN_DAY_TRIAL,
          available: trialElig.eligible,
          used: trialElig.used,
          deliveryStartTime: trialConfig?.deliveryStartTime ?? null,
          deliveryEndTime: trialConfig?.deliveryEndTime ?? null,
          ...(trialElig.blockedReason
            ? { blockedReason: trialElig.blockedReason }
            : {}),
        },
        {
          type: PlanType.MONTHLY,
          available: monthlyConfig !== null,
          ...(monthlyConfig
            ? {
                deliveryStartTime: monthlyConfig.deliveryStartTime,
                deliveryEndTime: monthlyConfig.deliveryEndTime,
              }
            : {
                deliveryStartTime: null,
                deliveryEndTime: null,
                blockedReason: "PLAN_NOT_CONFIGURED",
              }),
        },
      ],
      // Exposed so the customer app can state the cut-off without restating
      // the rule, and so it cannot drift from the server's policy.
      orderCutoff: getOrderCutoffPolicy(),
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

    // The plan starts on the first deliverable date under the order cut-off
    // (tomorrow, or the day after if quoting at/after 23:00 IST) and the
    // billing window runs to the end of that month. Occurrences are counted
    // from the actual start date, so the customer is never charged for a day
    // that cannot be delivered.
    //
    // MONTHLY resolves the cut-off here rather than at confirmation because the
    // occurrence count, and therefore the quoted price, derives from it. The
    // 30-minute quote expiry bounds how stale that decision can get for a
    // wallet payment; see resolveMonthlyWindow for the late-cash-confirmation
    // case.
    const billingStart = resolveFirstDeliveryDate();
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

        // Materialise delivery rows only after payment. Pass the actual plan
        // type so orders are priced and typed from the correct PlanConfig
        // (never the Buy Once / ₹80 fallback).
        await this.materializeDeliveries(
          tx,
          selection.id,
          userId,
          schedule,
          quote.planType as PlanType,
        );

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
   * Statuses whose order has not yet left the warehouse. Only these may be
   * stood down when a schedule is regenerated.
   */
  private static readonly REPLACEABLE_ORDER_STATUSES = ["PENDING", "CONFIRMED"];

  /**
   * Makes an existing schedule match `targetDates` without destroying history.
   *
   * Rules, in order of precedence:
   *   1. A delivery that is not SCHEDULED (DELIVERED / SKIPPED) is never
   *      touched — it is a record of what happened.
   *   2. A SCHEDULED delivery whose date is still wanted is KEPT, together with
   *      its order. This is what makes re-approval idempotent and stops a
   *      second paid order appearing for a date that already has one.
   *   3. A SCHEDULED delivery whose date is no longer wanted, and whose order
   *      has already advanced past CONFIRMED (or has been completed), is also
   *      kept: the goods are in flight or delivered, so the schedule yields to
   *      reality rather than the reverse.
   *   4. Only a SCHEDULED delivery that is unwanted AND whose order is still
   *      PENDING/CONFIRMED (or absent) is stood down. Its order is CANCELLED,
   *      never deleted, so the order number, invoice and payment linkage
   *      survive as an auditable record; the delivery row itself is marked
   *      SKIPPED rather than removed, preserving the (selectionId, deliveryDate)
   *      history and the unique constraint.
   *
   * Returns the dates still needing a new PlanDelivery row.
   */
  private async reconcileScheduleWindow(
    tx: Parameters<Parameters<PrismaService["$transaction"]>[0]>[0],
    selectionId: string,
    targetDates: Date[],
    /** Litres for the 1-based occurrence index within `targetDates`. */
    quantityForOccurrenceIndex: (occurrence: number) => number,
  ): Promise<void> {
    const wanted = new Set(targetDates.map((d) => d.getTime()));

    const existing = await (tx as any).planDelivery.findMany({
      where: { selectionId },
      include: { order: { select: { id: true, status: true } } },
    });

    const keptDates = new Set<number>();
    const standDownDeliveryIds: string[] = [];
    const cancelOrderIds: string[] = [];

    for (const delivery of existing) {
      const dateKey = new Date(delivery.deliveryDate).getTime();

      // Rule 1: fulfilment history is immutable.
      if (delivery.status !== DeliveryStatus.SCHEDULED) {
        keptDates.add(dateKey);
        continue;
      }

      // Rule 2: already on the target schedule — keep it and its order.
      if (wanted.has(dateKey)) {
        keptDates.add(dateKey);
        continue;
      }

      // Rule 3: the order has moved on; reality wins.
      const orderStatus: string | undefined = delivery.order?.status;
      if (
        orderStatus &&
        !PlansService.REPLACEABLE_ORDER_STATUSES.includes(orderStatus)
      ) {
        keptDates.add(dateKey);
        this.logger.warn(
          `Schedule reconcile kept out-of-window delivery because its order ` +
            `has advanced: selectionId=${selectionId} ` +
            `deliveryDate=${toIsoDateString(new Date(delivery.deliveryDate))} ` +
            `orderStatus=${orderStatus}`,
        );
        continue;
      }

      // Rule 4: safe to stand down.
      standDownDeliveryIds.push(delivery.id);
      if (delivery.order) cancelOrderIds.push(delivery.order.id);
    }

    if (cancelOrderIds.length > 0) {
      // Cancelled, not deleted: the invoice, order number and any payment
      // linkage stay intact and auditable. CANCELLED is also excluded from the
      // dashboard's revenue aggregates, so the money stops counting.
      await (tx as any).order.updateMany({
        where: {
          id: { in: cancelOrderIds },
          status: { in: PlansService.REPLACEABLE_ORDER_STATUSES },
        },
        data: { status: "CANCELLED" },
      });
    }

    if (standDownDeliveryIds.length > 0) {
      await (tx as any).planDelivery.updateMany({
        where: {
          id: { in: standDownDeliveryIds },
          status: DeliveryStatus.SCHEDULED,
        },
        data: { status: DeliveryStatus.SKIPPED },
      });
    }

    // Create only the genuinely new dates. `skipDuplicates` plus the
    // (selectionId, deliveryDate) unique constraint make a concurrent retry a
    // no-op instead of a constraint violation.
    const newDates = targetDates.filter((d) => !keptDates.has(d.getTime()));
    if (newDates.length === 0) return;

    const selection = await (tx as any).planSelection.findUnique({
      where: { id: selectionId },
      select: { userId: true },
    });
    if (!selection) {
      throw new NotFoundException("Subscription not found");
    }

    await (tx as any).planDelivery.createMany({
      data: newDates.map((date) => {
        // 1-based position within the full target window, so the ALTERNATING
        // pattern stays aligned with the schedule rather than with insertion
        // order.
        const occurrence =
          targetDates.findIndex((d) => d.getTime() === date.getTime()) + 1;
        return {
          selectionId,
          userId: selection.userId,
          deliveryDate: date,
          occurrence,
          quantityLitres: quantityForOccurrenceIndex(occurrence),
          status: DeliveryStatus.SCHEDULED,
        };
      }),
      skipDuplicates: true,
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
    planType: PlanType,
  ): Promise<void> {
    const dates = generateDeliveryDates(
      schedule.frequency,
      schedule.start,
      schedule.end,
    );
    if (dates.length === 0) {
      return;
    }

    // Reconcile the existing schedule WITHOUT deleting anything that carries
    // fulfilment or financial history.
    //
    // This used to `order.deleteMany({ status: CONFIRMED })` followed by
    // `planDelivery.deleteMany(...)`. Those orders are created below as
    // CONFIRMED + PAID with a nested Invoice, and Invoice cascades on order
    // delete, so re-approving a subscription destroyed paid orders and burned
    // their invoice numbers out of a non-transactional Postgres sequence —
    // leaving unexplained gaps with no void or credit-note trail. Worse, the
    // delete filtered orders on CONFIRMED but deleted deliveries regardless, so
    // a delivery whose order had advanced (OUT_FOR_DELIVERY / DELIVERED /
    // COMPLETED) lost its delivery row, had `planDeliveryId` nulled by the
    // optional relation's SetNull, and then got a SECOND paid, invoiced order
    // for the same date — double-counted in revenue.
    //
    // The strategy now: cancel-and-replace only what is genuinely untouched,
    // and leave everything else exactly where it is.
    await this.reconcileScheduleWindow(tx, selectionId, dates, (occurrence) =>
      quantityForOccurrence(
        schedule.quantityMode,
        occurrence,
        schedule.quantity,
        schedule.quantityA,
        schedule.quantityB,
      ),
    );

    await this.materializeOrdersForSchedule(tx, selectionId, userId, planType);
  }

  /**
   * Creates the dispatch Order (and Invoice) for every SCHEDULED delivery of a
   * selection that does not already have one.
   *
   * Idempotent by construction: each delivery is skipped when an order already
   * references it, so retries, concurrent approvals and post-reconciliation
   * top-ups all converge on exactly one order per delivery. Extracted from
   * `materializeDeliveries` so Manage Delivery can top up orders after a
   * cadence change or a resume without duplicating pricing rules — previously
   * those paths created deliveries with no dispatch order at all.
   */
  async materializeOrdersForSchedule(
    tx: Parameters<Parameters<PrismaService["$transaction"]>[0]>[0],
    selectionId: string,
    userId: string,
    planType: PlanType,
  ): Promise<void> {
    // The authoritative plan configuration prices these orders. A valid plan
    // selection MUST have a configuration; without it we cannot price the order
    // correctly. We fail safely (rolling back the whole transaction) rather
    // than silently materialising a wrongly-priced order
    // (e.g. a Trial/Monthly plan priced as Buy Once at the ₹80/L fallback).
    const config: PlanConfig | null = await (tx as any).planConfig.findUnique({
      where: { planType },
    });
    if (!config) {
      throw new BadRequestException({
        error: "PLAN_CONFIG_MISSING",
        message: `Plan configuration for ${planType} is missing; cannot materialise priced orders`,
        planType,
      });
    }

    // Materialize orders for dispatch visibility. Any failure here propagates
    // and rolls back the transaction — a paid plan must never be confirmed
    // with missing or mis-priced orders.
    // SCHEDULED only. Reconciliation marks stood-down deliveries SKIPPED
    // rather than deleting them, so an unfiltered query would mint a fresh
    // dispatch order for a delivery that is no longer happening.
    const deliveries = await (tx as any).planDelivery.findMany({
      where: { selectionId, status: DeliveryStatus.SCHEDULED },
      orderBy: { deliveryDate: "asc" },
    });

    if (!deliveries || deliveries.length === 0) {
      return;
    }

    const address = await (tx as any).customerAddress.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    const addressSnapshot = address
      ? {
          fullName: address.fullName,
          mobile: address.mobile,
          houseNumber: address.houseNumber,
          buildingName: address.buildingName,
          streetName: address.streetName,
          landmark: address.landmark,
          city: address.city,
          state: address.state,
          area: address.area,
          pincode: address.pincode,
          latitude: address.latitude,
          longitude: address.longitude,
        }
      : {
          fullName: "Customer",
          mobile: "",
          houseNumber: "",
          city: "Raipur",
          state: "Chhattisgarh",
          area: "Raipur",
        };

    for (const d of deliveries) {
      const existingOrder = await (tx as any).order.findUnique({
        where: { planDeliveryId: d.id },
      });
      if (existingOrder) continue;

      const orderNumber = await generateOrderNumber(tx as any);
      const invoiceNumber = await generateInvoiceNumber(tx as any);

      const qty = d.quantityLitres || 1;
      const unitPrice = config.sellingPricePerLitre;
      const actualPrice = config.actualPricePerLitre;
      const itemTotal = unitPrice * qty;
      const deliveryFee = config.deliveryFeePaise ?? 0;
      const total = itemTotal + deliveryFee;

      await (tx as any).order.create({
        data: {
          orderNumber,
          userId,
          planSelectionId: selectionId,
          planDeliveryId: d.id,
          planType,
          status: "CONFIRMED",
          paymentStatus: "PAID",
          subtotalPaise: itemTotal,
          discountPaise: 0,
          taxPaise: 0,
          deliveryFeePaise: deliveryFee,
          totalPaise: total,
          deliveryDate: d.deliveryDate,
          // Snapshot the configured window verbatim. An unconfigured plan
          // stores null, which every client renders as "not available" —
          // fabricating a plausible window here would promise a delivery time
          // the business never set.
          deliveryStartTime: config.deliveryStartTime,
          deliveryEndTime: config.deliveryEndTime,
          addressSnapshot,
          actualPricePerLitrePaise: actualPrice,
          sellingPricePerLitrePaise: unitPrice,
          items: {
            create: {
              productNameSnapshot: "A2 Desi Gir Cow Milk",
              quantity: qty,
              unitPricePaise: unitPrice,
              discountPaise: 0,
              taxPaise: 0,
              totalPaise: itemTotal,
            },
          },
          invoice: {
            create: {
              invoiceNumber,
              addressSnapshot,
              financialSnapshot: {
                subtotalPaise: itemTotal,
                discountPaise: 0,
                taxPaise: 0,
                deliveryFeePaise: deliveryFee,
                totalPaise: total,
              },
            },
          },
        },
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
    cashCollection?: { id: string; amountPaise: number },
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

    const collection =
      cashCollection ||
      (await (tx as any).cashCollection?.findFirst?.({
        where: { planSelectionId },
      }));

    if (collection) {
      if (collection.amountPaise < selection.quote.totalSellingAmount) {
        throw new BadRequestException({
          error: "CASH_SHORT_FOR_PLAN",
          message:
            `Collected cash (${collection.amountPaise} paise) is less than ` +
            `plan total (${selection.quote.totalSellingAmount} paise)`,
          collectedPaise: collection.amountPaise,
          requiredPaise: selection.quote.totalSellingAmount,
          shortfallPaise:
            selection.quote.totalSellingAmount - collection.amountPaise,
        });
      }

      // 1. CREDIT the wallet by the collected cash amount
      await this.walletService.creditWalletWithin(
        tx as any,
        selection.userId,
        collection.amountPaise,
        WalletTransactionReferenceType.CASH_COLLECTION,
        collection.id,
        "Cash collection confirmed (plan payment)",
      );

      // 2. DEBIT the wallet for the plan total (reusing exact scheme as wallet-paid plan)
      await this.walletService.debitWalletWithin(
        tx as any,
        selection.userId,
        selection.quote.totalSellingAmount,
        WalletTransactionReferenceType.PLAN_SELECTION,
        planSelectionId,
        `Plan payment (${selection.quote.planType})`,
      );
    }

    const now = new Date();

    // Mark plan as paid, but DO NOT activate subscription schedule or materialize delivery rows.
    // The subscription schedule is activated only when the admin explicitly approves and sets the
    // first delivery date via the Subscription tab.
    await (tx as any).planSelection.update({
      where: { id: planSelectionId },
      data: {
        paidAt: now,
        paidAmountPaise: selection.quote.totalSellingAmount,
      },
    });
  }

  async adminApproveSubscription(
    adminId: string,
    subscriptionId: string,
    dto: ApproveSubscriptionPlanDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const selection = await (tx as any).planSelection.findUnique({
        where: { id: subscriptionId },
        include: { quote: true, cashCollection: true },
      });

      if (!selection) {
        throw new NotFoundException("Subscription not found");
      }

      // ── Payment eligibility ──────────────────────────────────────
      //
      // `paidAt` is the authoritative persisted proof of payment: the WALLET
      // path sets it in the same transaction as the wallet debit, and the CASH
      // path only once an admin confirms the collection. Scheduling approval
      // therefore requires it, full stop.
      //
      // The previous guard was an AND-chain gated on
      // `paymentMethod === "CASH"`, so it protected only the cash path — any
      // other (or null, legacy) payment method passed straight through with
      // `paidAt` null. Inverting it makes payment the precondition and the
      // cash wording merely a more helpful message.
      if (!selection.paidAt) {
        if (
          selection.paymentMethod === PlanPaymentMethod.CASH &&
          selection.cashCollection?.status !== "CONFIRMED"
        ) {
          throw new BadRequestException({
            error: "CASH_NOT_CONFIRMED",
            message:
              "Physical cash receipt has not been confirmed yet. Please confirm payment in Payments/Wallets first.",
          });
        }
        throw new BadRequestException({
          error: "SUBSCRIPTION_NOT_PAID",
          message:
            "This subscription has no confirmed payment. Verify the payment before approving a delivery schedule.",
        });
      }

      // ── Lifecycle eligibility ────────────────────────────────────
      if (!APPROVABLE_SELECTION_STATUSES.includes(selection.status)) {
        throw new BadRequestException({
          error: "SUBSCRIPTION_NOT_APPROVABLE",
          message: `A ${selection.status} subscription cannot be scheduled.`,
          status: selection.status,
        });
      }

      const now = new Date();
      const schedule = this.resolveScheduleFromQuote(
        selection.quote,
        now,
        dto.firstDeliveryDate,
      );

      // Conditional update: a concurrent approval that already moved this row
      // out of an approvable status loses the race rather than overwriting the
      // winner's schedule.
      //
      // `paidAt` and `paidAmountPaise` are deliberately NOT written here.
      // Scheduling approval is not a payment event; the old
      // `...(selection.paidAt ? {} : { paidAt: now })` fabricated a payment
      // timestamp that the admin dashboard then aggregated as revenue.
      const claimed = await (tx as any).planSelection.updateMany({
        where: { id: subscriptionId, status: { in: APPROVABLE_SELECTION_STATUSES } },
        data: {
          status: PlanSelectionStatus.CONFIRMED,
          startDate: schedule.start,
          endDate: schedule.end,
          // Audit only. `adminId` used to be accepted and discarded, and the
          // note the admin UI collects was validated then dropped.
          approvedByAdminId: adminId,
          approvedAt: now,
          ...(dto.note ? { approvalNote: dto.note } : {}),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          error: "SUBSCRIPTION_APPROVAL_CONFLICT",
          message:
            "This subscription was updated by another request. Reload it and try again.",
        });
      }

      await (tx as any).planQuote.updateMany({
        where: { id: selection.quoteId, status: PlanQuoteStatus.PENDING },
        data: { status: PlanQuoteStatus.CONFIRMED },
      });

      await this.materializeDeliveries(
        tx,
        subscriptionId,
        selection.userId,
        schedule,
        selection.planType as PlanType,
      );

      return {
        success: true,
        message: "Subscription approved and delivery schedule generated successfully",
        subscriptionId,
        startDate: toIsoDateString(schedule.start),
        endDate: toIsoDateString(schedule.end),
        approvedAt: now.toISOString(),
        approvalNote: dto.note ?? null,
      };
    });
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
      orderCutoff: getOrderCutoffPolicy(),
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
      deliveryStartTime?: string | null;
      deliveryEndTime?: string | null;
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
    // The window end is also the daily order cut-off, so an inverted or
    // zero-length window would push every order to the next day forever.
    const windowStart = parseDeliveryTimeMinutes(config.deliveryStartTime);
    const windowEnd = parseDeliveryTimeMinutes(config.deliveryEndTime);
    if (windowStart !== null && windowEnd !== null && windowStart >= windowEnd) {
      throw new BadRequestException(
        `deliveryStartTime (${config.deliveryStartTime}) must be earlier than ` +
          `deliveryEndTime (${config.deliveryEndTime})`,
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
  /**
   * Resolves the MONTHLY delivery window, preserving the quoted commercial
   * terms wherever possible.
   *
   * MONTHLY prices by occurrence count, so the billing period is part of the
   * immutable quote and is normally used exactly as quoted. The exception is a
   * quote confirmed late — a cash plan sits in PENDING_PAYMENT until an admin
   * confirms the collection, which can be the next day. By then the quoted
   * start may be in the past, and materialising it would book deliveries on
   * days that have already gone.
   *
   * Policy when that happens: shift the window forward to begin on the first
   * deliverable date and keep the paid occurrence count intact. The customer
   * receives exactly the number of deliveries they paid for, at the price they
   * were quoted; only the calendar window moves. The alternative — refusing to
   * confirm — would strand cash the admin has already collected, and shortening
   * the window to the quoted end date would silently deliver less than was
   * paid for.
   *
   * The shift is logged so a late confirmation is auditable rather than
   * invisible.
   */
  private resolveMonthlyWindow(
    quotedStart: Date,
    quotedEnd: Date,
    frequency: DeliveryFrequency,
    deliveryOccurrences: number,
    now: Date,
  ): { start: Date; end: Date; shifted: boolean } {
    const earliest = resolveFirstDeliveryDate(now);

    // On time: honour the quote verbatim.
    if (quotedStart.getTime() >= earliest.getTime()) {
      return { start: quotedStart, end: quotedEnd, shifted: false };
    }

    const occurrences = Math.max(1, deliveryOccurrences);
    const step = frequency === DeliveryFrequency.ALTERNATE_DAYS ? 2 : 1;
    const start = earliest;
    const end = addDays(start, (occurrences - 1) * step);

    this.logger.warn(
      `MONTHLY schedule shifted forward: quotedStart=${toIsoDateString(quotedStart)} ` +
        `quotedEnd=${toIsoDateString(quotedEnd)} -> start=${toIsoDateString(start)} ` +
        `end=${toIsoDateString(end)} occurrences=${occurrences} frequency=${frequency} ` +
        `reason=quoted_start_in_past`,
    );

    return { start, end, shifted: true };
  }

  resolveScheduleFromQuote(
    quote: {
      planType: string;
      frequency: string | null;
      quantityMode: string | null;
      quantity: number | null;
      quantityA: number | null;
      quantityB: number | null;
      deliveryOccurrences: number;
      billingPeriodStart: Date | null;
      billingPeriodEnd: Date | null;
    },
    /**
     * Evaluation instant for the order cut-off. Injectable so callers that
     * confirm long after the quote was issued (cash) and tests can both be
     * explicit about "now".
     */
    now: Date = new Date(),
    explicitStartDate?: Date | string | null,
  ): {
    frequency: DeliveryFrequency;
    quantityMode: QuantityMode;
    quantity: number | null;
    quantityA: number | null;
    quantityB: number | null;
    start: Date;
    end: Date;
  } {
    if (explicitStartDate) {
      let parsedDate: Date;
      if (explicitStartDate instanceof Date) {
        if (isNaN(explicitStartDate.getTime())) {
          throw new BadRequestException("Invalid first delivery date");
        }
        parsedDate = toIstDateOnly(explicitStartDate);
      } else if (typeof explicitStartDate === "string") {
        const trimmed = explicitStartDate.trim();
        if (!/^d{4}-d{2}-d{2}$/.test(trimmed) && isNaN(Date.parse(trimmed))) {
          throw new BadRequestException("Invalid first delivery date");
        }
        if (/^d{4}-d{2}-d{2}$/.test(trimmed)) {
          parsedDate = new Date(`${trimmed}T00:00:00.000Z`);
        } else {
          parsedDate = toIstDateOnly(new Date(trimmed));
        }
      } else {
        throw new BadRequestException("Invalid first delivery date");
      }

      if (isNaN(parsedDate.getTime())) {
        throw new BadRequestException("Invalid first delivery date");
      }

      const start = parsedDate;
      const today = toIstDateOnly(now);
      if (start.getTime() < today.getTime()) {
        throw new BadRequestException("First delivery date cannot be in the past");
      }

      if (quote.planType === PlanType.MONTHLY) {
        const frequency =
          (quote.frequency as DeliveryFrequency | null) ?? DeliveryFrequency.DAILY;
        const occurrences = Math.max(1, quote.deliveryOccurrences);
        const step = frequency === DeliveryFrequency.ALTERNATE_DAYS ? 2 : 1;
        const end = addDays(start, (occurrences - 1) * step);

        return {
          frequency,
          quantityMode:
            (quote.quantityMode as QuantityMode | null) ?? QuantityMode.FIXED,
          quantity: quote.quantity,
          quantityA: quote.quantityA,
          quantityB: quote.quantityB,
          start,
          end,
        };
      }

      const occurrences =
        quote.planType === PlanType.SEVEN_DAY_TRIAL
          ? Math.max(1, quote.deliveryOccurrences)
          : 1;
      const end = addDays(start, occurrences - 1);
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

    if (quote.planType === PlanType.MONTHLY) {
      const frequency =
        (quote.frequency as DeliveryFrequency | null) ?? DeliveryFrequency.DAILY;
      const quotedStart = toDateOnly(quote.billingPeriodStart ?? now);
      const quotedEnd = toDateOnly(quote.billingPeriodEnd ?? now);
      const { start, end } = this.resolveMonthlyWindow(
        quotedStart,
        quotedEnd,
        frequency,
        quote.deliveryOccurrences,
        now,
      );
      return {
        frequency,
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
    // FIXED-quantity DAILY schedules. Neither one's price depends on the start
    // date, so the cut-off is evaluated here, at confirmation time — which for
    // a cash plan means when the admin confirms, not when the customer
    // ordered. The duration is preserved regardless of where the start lands.
    const start = resolveFirstDeliveryDate(now);
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
  async getAdminSubscriptions(query: {
    page?: number;
    limit?: number;
    status?: string;
    planType?: string;
    search?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: any = {};
    if (query.status && query.status !== "ALL") {
      where.status = query.status;
    }
    if (query.planType && query.planType !== "ALL") {
      where.planType = query.planType;
    }
    if (query.search) {
      const s = query.search.trim();
      where.user = {
        OR: [
          { mobile: { contains: s, mode: "insensitive" } },
          { email: { contains: s, mode: "insensitive" } },
          {
            customerProfile: {
              OR: [
                { firstName: { contains: s, mode: "insensitive" } },
                { lastName: { contains: s, mode: "insensitive" } },
              ],
            },
          },
        ],
      };
    }

    const [selections, total] = await Promise.all([
      this.prisma.planSelection.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              mobile: true,
              email: true,
              customerProfile: {
                select: {
                  firstName: true,
                  lastName: true,
                  profileImagePath: true,
                },
              },
              addresses: {
                take: 1,
                orderBy: { createdAt: "desc" },
                select: {
                  fullName: true,
                  houseNumber: true,
                  buildingName: true,
                  streetName: true,
                  area: true,
                  city: true,
                  pincode: true,
                },
              },
            },
          },
          deliveries: {
            select: {
              id: true,
              deliveryDate: true,
              quantityLitres: true,
              status: true,
            },
          },
          cashCollection: {
            select: {
              id: true,
              status: true,
              amountPaise: true,
            },
          },
        },
      }),
      this.prisma.planSelection.count({ where }),
    ]);

    // The admin scheduling modal needs each subscription's delivery window and
    // quantity bounds, and must be able to tell "not configured" from a real
    // window. Join PlanConfig once per plan type rather than per row.
    const configs = await this.prisma.planConfig.findMany();
    const configByType = new Map(configs.map((c) => [c.planType as string, c]));

    return {
      data: selections.map((s: any) => ({
        id: s.id,
        userId: s.userId,
        planType: s.planType,
        status: s.status,
        frequency: s.frequency,
        quantityMode: s.quantityMode,
        quantity: s.quantity,
        startDate: s.startDate,
        endDate: s.endDate,
        paymentMethod: s.paymentMethod,
        paidAmountPaise: s.paidAmountPaise,
        paidAt: s.paidAt,
        approvedByAdminId: s.approvedByAdminId ?? null,
        approvedAt: s.approvedAt ?? null,
        approvalNote: s.approvalNote ?? null,
        createdAt: s.createdAt,
        deliveriesCount: s.deliveries?.length || 0,
        /**
         * Authoritative Plan Configuration for this subscription's plan type.
         * `deliveryStartTime`/`deliveryEndTime` are null when the admin has not
         * configured a window — the scheduling modal must surface that and
         * block approval rather than substituting a default.
         */
        planConfig: (() => {
          const c = configByType.get(s.planType);
          if (!c) return null;
          return {
            planType: c.planType,
            isActive: c.isActive,
            deliveryStartTime: c.deliveryStartTime,
            deliveryEndTime: c.deliveryEndTime,
            quantityMin: c.quantityMin,
            quantityMax: c.quantityMax,
            sellingPricePerLitre: c.sellingPricePerLitre,
            deliveryFeePaise: c.deliveryFeePaise,
          };
        })(),
        cashCollection: s.cashCollection
          ? { id: s.cashCollection.id, status: s.cashCollection.status, amountPaise: s.cashCollection.amountPaise }
          : null,
        customer: {
          id: s.user?.id,
          mobile: s.user?.mobile,
          email: s.user?.email,
          name: s.user?.customerProfile
            ? `${s.user.customerProfile.firstName} ${s.user.customerProfile.lastName}`
            : null,
          address: s.user?.addresses?.[0] || null,
        },
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

}
