import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  PlanType,
  DeliveryFrequency,
  QuantityMode,
  DeliveryStatus,
  PlanSelectionStatus,
} from "../plans/plans.constants";
import {
  toDateOnly,
  generateDeliveryDates,
  quantityForOccurrence,
} from "../plans/plans.service";
import { SkipDeliveryDto } from "./dto/customer/skip-delivery.dto";
import { ChangeQuantityDto } from "./dto/customer/change-quantity.dto";
import { ChangeScheduleDto } from "./dto/customer/change-schedule.dto";

// ─── Response interfaces ────────────────────────────────────────────

export interface ActivePlanView {
  selectionId: string;
  planType: string;
  status: string;
  frequency: string | null;
  quantityMode: string | null;
  quantityLitres?: number | null;
  quantityA?: number | null;
  quantityB?: number | null;
  startDate: string | null;
  endDate: string | null;
}

export interface UpcomingDeliveryView {
  date: string;
  occurrence: number;
  quantityLitres: number;
  status: string;
  canSkip: boolean;
  canModify: boolean;
}

export interface ManageDeliveryResponse {
  activePlan: ActivePlanView;
  upcomingDeliveries: UpcomingDeliveryView[];
}

// Statuses that count as a live, manageable plan.
const ACTIVE_STATUSES = [
  PlanSelectionStatus.CONFIRMED,
  PlanSelectionStatus.ACTIVE,
];

// ─── Service ────────────────────────────────────────────────────────

@Injectable()
export class ManageDeliveryService {
  private readonly logger = new Logger(ManageDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── GET ──────────────────────────────────────────────────────────

  async getManageDelivery(userId: string): Promise<ManageDeliveryResponse> {
    const selection = await this.requireActiveSelection(userId);
    const deliveries = await this.prisma.planDelivery.findMany({
      where: { selectionId: selection.id, userId },
      orderBy: { deliveryDate: "asc" },
    });
    return this.buildView(selection, deliveries);
  }

  // ── Skip ─────────────────────────────────────────────────────────

  async skipDelivery(
    userId: string,
    dto: SkipDeliveryDto,
  ): Promise<ManageDeliveryResponse> {
    const today = toDateOnly(new Date());
    const target = toDateOnly(new Date(dto.deliveryDate));

    // Only strictly-future deliveries may be skipped.
    if (target.getTime() <= today.getTime()) {
      throw new BadRequestException(
        "Only future deliveries can be skipped",
      );
    }

    const selection = await this.requireActiveSelection(userId);

    // Scope by userId AND selectionId — a customer can only ever reach their
    // own deliveries (isolation / IDOR protection).
    const delivery = await this.prisma.planDelivery.findFirst({
      where: { selectionId: selection.id, userId, deliveryDate: target },
    });

    if (!delivery) {
      throw new BadRequestException(
        `${dto.deliveryDate} is not a scheduled delivery date`,
      );
    }
    if (delivery.status === DeliveryStatus.SKIPPED) {
      throw new BadRequestException("This delivery is already skipped");
    }
    if (delivery.status === DeliveryStatus.DELIVERED) {
      throw new BadRequestException(
        "A completed delivery cannot be skipped",
      );
    }

    // Race-safe transition: the guarded updateMany only matches while the row
    // is still SCHEDULED, so two concurrent skips of the same delivery cannot
    // both succeed.
    const res = await this.prisma.planDelivery.updateMany({
      where: { id: delivery.id, status: DeliveryStatus.SCHEDULED },
      data: { status: DeliveryStatus.SKIPPED },
    });
    if (res.count === 0) {
      throw new BadRequestException(
        "This delivery could not be skipped (it was just modified)",
      );
    }

    return this.getManageDelivery(userId);
  }

  // ── Change quantity (future-only, becomes FIXED) ─────────────────

  async changeQuantity(
    userId: string,
    dto: ChangeQuantityDto,
  ): Promise<ManageDeliveryResponse> {
    const selection = await this.requireActiveSelection(userId);
    const today = toDateOnly(new Date());

    await this.prisma.$transaction(async (tx) => {
      // Only future, still-scheduled deliveries change. Past and skipped
      // deliveries are left untouched (future-only rule).
      await tx.planDelivery.updateMany({
        where: {
          selectionId: selection.id,
          userId,
          deliveryDate: { gt: today },
          status: DeliveryStatus.SCHEDULED,
        },
        data: { quantityLitres: dto.quantityLitres },
      });

      // Reflect the new quantity in the live config as a FIXED quantity.
      await tx.planSelection.update({
        where: { id: selection.id },
        data: {
          quantityMode: QuantityMode.FIXED,
          quantity: dto.quantityLitres,
          quantityA: null,
          quantityB: null,
        },
      });
    });

    return this.getManageDelivery(userId);
  }

  // ── Change schedule: frequency + quantity pattern (MONTHLY only) ─

  async changeSchedule(
    userId: string,
    dto: ChangeScheduleDto,
  ): Promise<ManageDeliveryResponse> {
    const selection = await this.requireActiveSelection(userId);

    if (selection.planType !== PlanType.MONTHLY) {
      throw new BadRequestException(
        "Frequency and quantity-pattern changes apply to monthly plans only",
      );
    }
    if (!selection.endDate) {
      throw new BadRequestException(
        "This plan has no schedule window to reconfigure",
      );
    }

    // Belt-and-suspenders validation (the DTO also enforces this).
    this.validateScheduleDto(dto);

    const today = toDateOnly(new Date());
    const firstFuture = new Date(today);
    firstFuture.setUTCDate(firstFuture.getUTCDate() + 1);
    const end = toDateOnly(selection.endDate);

    await this.prisma.$transaction(async (tx) => {
      // Remove only FUTURE, still-scheduled deliveries. Past deliveries and any
      // already-skipped future deliveries are preserved.
      await tx.planDelivery.deleteMany({
        where: {
          selectionId: selection.id,
          userId,
          deliveryDate: { gt: today },
          status: DeliveryStatus.SCHEDULED,
        },
      });

      // Regenerate the future window with the new frequency/pattern. The new
      // ALTERNATING pattern restarts at occurrence #1 for the future segment.
      const dates = generateDeliveryDates(dto.frequency, firstFuture, end);
      if (dates.length > 0) {
        await tx.planDelivery.createMany({
          data: dates.map((date, i) => ({
            selectionId: selection.id,
            userId,
            deliveryDate: date,
            occurrence: i + 1,
            quantityLitres: quantityForOccurrence(
              dto.quantityMode,
              i + 1,
              dto.quantity,
              dto.quantityA,
              dto.quantityB,
            ),
            status: DeliveryStatus.SCHEDULED,
          })),
          // Skip any date that already holds a (retained) skipped delivery.
          skipDuplicates: true,
        });
      }

      await tx.planSelection.update({
        where: { id: selection.id },
        data: {
          frequency: dto.frequency,
          quantityMode: dto.quantityMode,
          quantity:
            dto.quantityMode === QuantityMode.FIXED ? dto.quantity : null,
          quantityA:
            dto.quantityMode === QuantityMode.ALTERNATING ? dto.quantityA : null,
          quantityB:
            dto.quantityMode === QuantityMode.ALTERNATING ? dto.quantityB : null,
        },
      });
    });

    return this.getManageDelivery(userId);
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async requireActiveSelection(userId: string) {
    const selection = await this.prisma.planSelection.findFirst({
      where: { userId, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: "desc" },
    });
    if (!selection) {
      throw new NotFoundException("No active plan found");
    }
    return selection;
  }

  private validateScheduleDto(dto: ChangeScheduleDto): void {
    if (dto.quantityMode === QuantityMode.FIXED) {
      if (dto.quantity === undefined || dto.quantity === null) {
        throw new BadRequestException("quantity is required for FIXED mode");
      }
    } else {
      if (dto.quantityA === undefined || dto.quantityA === null) {
        throw new BadRequestException(
          "quantityA is required for ALTERNATING mode",
        );
      }
      if (dto.quantityB === undefined || dto.quantityB === null) {
        throw new BadRequestException(
          "quantityB is required for ALTERNATING mode",
        );
      }
    }
  }

  private buildView(
    selection: {
      id: string;
      planType: string;
      status: string;
      frequency: string | null;
      quantityMode: string | null;
      quantity: number | null;
      quantityA: number | null;
      quantityB: number | null;
      startDate: Date | null;
      endDate: Date | null;
    },
    deliveries: Array<{
      deliveryDate: Date;
      occurrence: number;
      quantityLitres: number;
      status: string;
    }>,
  ): ManageDeliveryResponse {
    const today = toDateOnly(new Date()).getTime();

    const activePlan: ActivePlanView = {
      selectionId: selection.id,
      planType: selection.planType,
      status: selection.status,
      frequency: selection.frequency,
      quantityMode: selection.quantityMode,
      startDate: this.fmt(selection.startDate),
      endDate: this.fmt(selection.endDate),
    };
    if (selection.quantityMode === QuantityMode.ALTERNATING) {
      activePlan.quantityA = selection.quantityA;
      activePlan.quantityB = selection.quantityB;
    } else {
      activePlan.quantityLitres = selection.quantity;
    }

    const upcomingDeliveries: UpcomingDeliveryView[] = deliveries
      .filter((d) => toDateOnly(d.deliveryDate).getTime() >= today)
      .map((d) => {
        const isFuture = toDateOnly(d.deliveryDate).getTime() > today;
        const modifiable = isFuture && d.status === DeliveryStatus.SCHEDULED;
        return {
          date: this.fmt(d.deliveryDate) as string,
          occurrence: d.occurrence,
          quantityLitres: d.quantityLitres,
          status: d.status,
          canSkip: modifiable,
          canModify: modifiable,
        };
      });

    return { activePlan, upcomingDeliveries };
  }

  /** Formats a date-only value as YYYY-MM-DD (UTC), or null. */
  private fmt(d: Date | null): string | null {
    if (!d) return null;
    return toDateOnly(d).toISOString().slice(0, 10);
  }
}
