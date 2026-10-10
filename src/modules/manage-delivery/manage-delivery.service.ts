import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  PlanType,
  DeliveryFrequency,
  QuantityMode,
  DeliveryStatus,
  PlanSelectionStatus,
  ChangeRequestType,
  ChangeRequestStatus,
  DEFAULT_DELIVERY_START_TIME,
  DEFAULT_DELIVERY_END_TIME,
} from "../plans/plans.constants";
import {
  toDateOnly,
  generateDeliveryDates,
  quantityForOccurrence,
} from "../plans/plans.service";
import { SkipDeliveryDto } from "./dto/customer/skip-delivery.dto";
import { ChangeQuantityDto } from "./dto/customer/change-quantity.dto";
import { ChangeFrequencyDto } from "./dto/customer/change-frequency.dto";
import { ChangePlanDto } from "./dto/customer/change-plan.dto";
import { ChangeScheduleDto } from "./dto/customer/change-schedule.dto";
import { PauseDeliveryDto } from "./dto/customer/pause-delivery.dto";
import { RejectRequestDto } from "./dto/admin/reject-request.dto";
import { ListRequestsQueryDto } from "./dto/admin/list-requests-query.dto";

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
  deliveryStartTime?: string | null;
  deliveryEndTime?: string | null;
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

const ACTIVE_STATUSES = [
  PlanSelectionStatus.CONFIRMED,
  PlanSelectionStatus.ACTIVE,
];

// ─── Service ────────────────────────────────────────────────────────

@Injectable()
export class ManageDeliveryService {
  private readonly logger = new Logger(ManageDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — GET
  // ══════════════════════════════════════════════════════════════════

  async getManageDelivery(userId: string): Promise<ManageDeliveryResponse> {
    const selection = await this.requireActiveSelection(userId);
    const [deliveries, config] = await Promise.all([
      this.prisma.planDelivery.findMany({
        where: { selectionId: selection.id, userId },
        orderBy: { deliveryDate: "asc" },
      }),
      this.prisma.planConfig.findUnique({
        where: { planType: selection.planType as any },
      }),
    ]);
    return this.buildView(selection, deliveries, config?.deliveryStartTime, config?.deliveryEndTime);
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — SKIP (immediate, no approval)
  // ══════════════════════════════════════════════════════════════════

  async skipDelivery(
    userId: string,
    dto: SkipDeliveryDto,
  ): Promise<{ success: true; message: string; delivery: ManageDeliveryResponse }> {
    const today = toDateOnly(new Date());
    const target = toDateOnly(new Date(dto.deliveryDate));

    if (target.getTime() <= today.getTime()) {
      throw new BadRequestException("Only future deliveries can be skipped");
    }

    const selection = await this.requireActiveSelection(userId);
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
      throw new BadRequestException("A completed delivery cannot be skipped");
    }

    const res = await this.prisma.planDelivery.updateMany({
      where: { id: delivery.id, status: DeliveryStatus.SCHEDULED },
      data: { status: DeliveryStatus.SKIPPED },
    });
    if (res.count === 0) {
      throw new BadRequestException(
        "This delivery could not be skipped (it was just modified)",
      );
    }

    const view = await this.getManageDelivery(userId);
    return {
      success: true,
      message: "Delivery skipped successfully.",
      delivery: view,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — PAUSE (immediate, no approval)
  // ══════════════════════════════════════════════════════════════════

  async pauseDelivery(
    userId: string,
    dto: PauseDeliveryDto,
  ): Promise<{ success: true; message: string }> {
    const selection = await this.requireActiveSelection(userId);
    const today = toDateOnly(new Date());

    // Pause = skip all future SCHEDULED deliveries.
    // If a resumeDate is given, only skip deliveries before that date.
    const dateFilter: any = { gt: today };
    if (dto.resumeDate) {
      const resume = toDateOnly(new Date(dto.resumeDate));
      if (resume.getTime() <= today.getTime()) {
        throw new BadRequestException("resumeDate must be in the future");
      }
      dateFilter.lt = resume;
    }

    const result = await this.prisma.planDelivery.updateMany({
      where: {
        selectionId: selection.id,
        userId,
        deliveryDate: dateFilter,
        status: DeliveryStatus.SCHEDULED,
      },
      data: { status: DeliveryStatus.SKIPPED },
    });

    const msg = result.count > 0
      ? "Your deliveries have been paused successfully."
      : "No upcoming deliveries to pause.";

    return { success: true, message: msg };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — CHANGE QUANTITY (creates PENDING request)
  // ══════════════════════════════════════════════════════════════════

  async changeQuantity(userId: string, dto: ChangeQuantityDto) {
    const selection = await this.requireActiveSelection(userId);

    await this.rejectDuplicatePending(
      userId,
      selection.id,
      ChangeRequestType.CHANGE_QUANTITY,
    );

    const currentConfig = {
      quantityMode: selection.quantityMode,
      quantity: selection.quantity,
      quantityA: selection.quantityA,
      quantityB: selection.quantityB,
    };
    const requestedConfig = {
      quantityMode: QuantityMode.FIXED,
      quantity: dto.quantityLitres,
    };

    const request = await this.prisma.manageDeliveryChangeRequest.create({
      data: {
        userId,
        planSelectionId: selection.id,
        requestType: ChangeRequestType.CHANGE_QUANTITY,
        currentConfiguration: currentConfig,
        requestedConfiguration: requestedConfig,
      },
    });

    return {
      success: true,
      message:
        "Your quantity change request has been submitted for admin approval.",
      request: {
        id: request.id,
        type: request.requestType,
        status: request.status,
        currentQuantity: selection.quantity,
        requestedQuantity: dto.quantityLitres,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — CHANGE FREQUENCY (creates PENDING request)
  // ══════════════════════════════════════════════════════════════════

  async changeFrequency(userId: string, dto: ChangeFrequencyDto) {
    const selection = await this.requireActiveSelection(userId);

    if (selection.planType !== PlanType.MONTHLY) {
      throw new BadRequestException(
        "Frequency changes apply to monthly plans only",
      );
    }

    if (selection.frequency === dto.frequency) {
      throw new BadRequestException(
        "Requested frequency is the same as current",
      );
    }

    await this.rejectDuplicatePending(
      userId,
      selection.id,
      ChangeRequestType.CHANGE_FREQUENCY,
    );

    const currentConfig = { frequency: selection.frequency };
    const requestedConfig = { frequency: dto.frequency };

    const request = await this.prisma.manageDeliveryChangeRequest.create({
      data: {
        userId,
        planSelectionId: selection.id,
        requestType: ChangeRequestType.CHANGE_FREQUENCY,
        currentConfiguration: currentConfig,
        requestedConfiguration: requestedConfig,
      },
    });

    return {
      success: true,
      message:
        "Your delivery frequency change request has been submitted for admin approval.",
      request: {
        id: request.id,
        type: request.requestType,
        status: request.status,
        currentFrequency: selection.frequency,
        requestedFrequency: dto.frequency,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — CHANGE PLAN (creates PENDING request)
  // ══════════════════════════════════════════════════════════════════

  async changePlan(userId: string, dto: ChangePlanDto) {
    const selection = await this.requireActiveSelection(userId);

    if (selection.planType === dto.planType) {
      throw new BadRequestException(
        "Requested plan type is the same as current",
      );
    }

    // Verify the target plan is active in the system.
    const targetConfig = await this.prisma.planConfig.findUnique({
      where: { planType: dto.planType },
    });
    if (!targetConfig || !targetConfig.isActive) {
      throw new BadRequestException(
        "The requested plan type is not currently available",
      );
    }

    await this.rejectDuplicatePending(
      userId,
      selection.id,
      ChangeRequestType.CHANGE_PLAN,
    );

    const currentConfig = { planType: selection.planType };
    const requestedConfig = { planType: dto.planType };

    const request = await this.prisma.manageDeliveryChangeRequest.create({
      data: {
        userId,
        planSelectionId: selection.id,
        requestType: ChangeRequestType.CHANGE_PLAN,
        currentConfiguration: currentConfig,
        requestedConfiguration: requestedConfig,
      },
    });

    return {
      success: true,
      message:
        "Your plan change request has been submitted for admin approval.",
      request: {
        id: request.id,
        type: request.requestType,
        status: request.status,
        currentPlanType: selection.planType,
        requestedPlanType: dto.planType,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — CHANGE SCHEDULE (kept for backward compat, now creates request)
  // ══════════════════════════════════════════════════════════════════

  async changeSchedule(userId: string, dto: ChangeScheduleDto) {
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

    this.validateScheduleDto(dto);

    await this.rejectDuplicatePending(
      userId,
      selection.id,
      ChangeRequestType.CHANGE_FREQUENCY,
    );

    const currentConfig = {
      frequency: selection.frequency,
      quantityMode: selection.quantityMode,
      quantity: selection.quantity,
      quantityA: selection.quantityA,
      quantityB: selection.quantityB,
    };
    const requestedConfig = {
      frequency: dto.frequency,
      quantityMode: dto.quantityMode,
      quantity: dto.quantity ?? null,
      quantityA: dto.quantityA ?? null,
      quantityB: dto.quantityB ?? null,
    };

    const request = await this.prisma.manageDeliveryChangeRequest.create({
      data: {
        userId,
        planSelectionId: selection.id,
        requestType: ChangeRequestType.CHANGE_FREQUENCY,
        currentConfiguration: currentConfig,
        requestedConfiguration: requestedConfig,
      },
    });

    return {
      success: true,
      message:
        "Your schedule change request has been submitted for admin approval.",
      request: {
        id: request.id,
        type: request.requestType,
        status: request.status,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — VIEW OWN REQUESTS
  // ══════════════════════════════════════════════════════════════════

  async getCustomerRequests(userId: string) {
    const requests = await this.prisma.manageDeliveryChangeRequest.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return requests.map((r) => this.formatCustomerRequest(r));
  }

  async getCustomerRequest(userId: string, requestId: string) {
    const request = await this.prisma.manageDeliveryChangeRequest.findFirst({
      where: { id: requestId, userId },
    });
    if (!request) {
      throw new NotFoundException("Request not found");
    }
    return this.formatCustomerRequest(request);
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — LIST / VIEW REQUESTS
  // ══════════════════════════════════════════════════════════════════

  async getAdminRequests(query: ListRequestsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.requestType) where.requestType = query.requestType;

    const [requests, total] = await Promise.all([
      this.prisma.manageDeliveryChangeRequest.findMany({
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
                select: { firstName: true, lastName: true },
              },
            },
          },
        },
      }),
      this.prisma.manageDeliveryChangeRequest.count({ where }),
    ]);

    return {
      data: requests.map((r) => ({
        id: r.id,
        requestType: r.requestType,
        status: r.status,
        currentConfiguration: r.currentConfiguration,
        requestedConfiguration: r.requestedConfiguration,
        adminNote: r.adminNote,
        reviewedAt: r.reviewedAt,
        createdAt: r.createdAt,
        customer: {
          id: r.user.id,
          mobile: r.user.mobile,
          email: r.user.email,
          name: r.user.customerProfile
            ? `${r.user.customerProfile.firstName} ${r.user.customerProfile.lastName}`
            : null,
        },
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getAdminRequest(requestId: string) {
    const request = await this.prisma.manageDeliveryChangeRequest.findUnique({
      where: { id: requestId },
      include: {
        user: {
          select: {
            id: true,
            mobile: true,
            email: true,
            customerProfile: {
              select: { firstName: true, lastName: true },
            },
          },
        },
      },
    });
    if (!request) {
      throw new NotFoundException("Request not found");
    }
    return {
      id: request.id,
      requestType: request.requestType,
      status: request.status,
      currentConfiguration: request.currentConfiguration,
      requestedConfiguration: request.requestedConfiguration,
      adminId: request.adminId,
      adminNote: request.adminNote,
      reviewedAt: request.reviewedAt,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      customer: {
        id: request.user.id,
        mobile: request.user.mobile,
        email: request.user.email,
        name: request.user.customerProfile
          ? `${request.user.customerProfile.firstName} ${request.user.customerProfile.lastName}`
          : null,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — APPROVE
  // ══════════════════════════════════════════════════════════════════

  async approveRequest(adminId: string, requestId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Atomic state transition: only the first admin to reach a PENDING row wins.
      const updated = await tx.manageDeliveryChangeRequest.updateMany({
        where: { id: requestId, status: ChangeRequestStatus.PENDING },
        data: {
          status: ChangeRequestStatus.APPROVED,
          adminId,
          reviewedAt: new Date(),
        },
      });

      if (updated.count === 0) {
        const existing = await tx.manageDeliveryChangeRequest.findUnique({
          where: { id: requestId },
        });
        if (!existing) throw new NotFoundException("Request not found");
        throw new ConflictException(
          `Request has already been ${existing.status.toLowerCase()}`,
        );
      }

      const request = await tx.manageDeliveryChangeRequest.findUnique({
        where: { id: requestId },
      });
      if (!request) throw new NotFoundException("Request not found");

      await this.applyApprovedChange(tx, request);

      return {
        success: true,
        message: "The change request has been approved and applied.",
        request: {
          id: request.id,
          status: ChangeRequestStatus.APPROVED,
          requestType: request.requestType,
        },
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — REJECT
  // ══════════════════════════════════════════════════════════════════

  async rejectRequest(
    adminId: string,
    requestId: string,
    dto: RejectRequestDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.manageDeliveryChangeRequest.updateMany({
        where: { id: requestId, status: ChangeRequestStatus.PENDING },
        data: {
          status: ChangeRequestStatus.REJECTED,
          adminId,
          adminNote: dto.note,
          reviewedAt: new Date(),
        },
      });

      if (updated.count === 0) {
        const existing = await tx.manageDeliveryChangeRequest.findUnique({
          where: { id: requestId },
        });
        if (!existing) throw new NotFoundException("Request not found");
        throw new ConflictException(
          `Request has already been ${existing.status.toLowerCase()}`,
        );
      }

      return {
        success: true,
        message: "The change request has been rejected.",
        request: {
          id: requestId,
          status: ChangeRequestStatus.REJECTED,
          adminNote: dto.note,
        },
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  Private — apply approved changes
  // ══════════════════════════════════════════════════════════════════

  private async applyApprovedChange(tx: any, request: any) {
    const requested = request.requestedConfiguration as Record<string, any>;
    const selection = await tx.planSelection.findUnique({
      where: { id: request.planSelectionId },
    });
    if (!selection) return;

    switch (request.requestType) {
      case ChangeRequestType.CHANGE_QUANTITY:
        await this.applyQuantityChange(tx, selection, requested);
        break;
      case ChangeRequestType.CHANGE_FREQUENCY:
        await this.applyFrequencyChange(tx, selection, requested);
        break;
      case ChangeRequestType.CHANGE_PLAN:
        await this.applyPlanChange(tx, selection, requested);
        break;
    }
  }

  private async applyQuantityChange(
    tx: any,
    selection: any,
    requested: Record<string, any>,
  ) {
    const today = toDateOnly(new Date());

    await tx.planDelivery.updateMany({
      where: {
        selectionId: selection.id,
        userId: selection.userId,
        deliveryDate: { gt: today },
        status: DeliveryStatus.SCHEDULED,
      },
      data: { quantityLitres: requested.quantity },
    });

    await tx.planSelection.update({
      where: { id: selection.id },
      data: {
        quantityMode: requested.quantityMode ?? QuantityMode.FIXED,
        quantity: requested.quantity,
        quantityA: null,
        quantityB: null,
      },
    });
  }

  private async applyFrequencyChange(
    tx: any,
    selection: any,
    requested: Record<string, any>,
  ) {
    const today = toDateOnly(new Date());
    if (!selection.endDate) return;

    const firstFuture = new Date(today);
    firstFuture.setUTCDate(firstFuture.getUTCDate() + 1);
    const end = toDateOnly(selection.endDate);

    await tx.planDelivery.deleteMany({
      where: {
        selectionId: selection.id,
        userId: selection.userId,
        deliveryDate: { gt: today },
        status: DeliveryStatus.SCHEDULED,
      },
    });

    const freq = requested.frequency as DeliveryFrequency;
    const qMode = (requested.quantityMode ??
      selection.quantityMode ??
      QuantityMode.FIXED) as QuantityMode;
    const qty = requested.quantity ?? selection.quantity;
    const qA = requested.quantityA ?? selection.quantityA;
    const qB = requested.quantityB ?? selection.quantityB;

    const dates = generateDeliveryDates(freq, firstFuture, end);
    if (dates.length > 0) {
      await tx.planDelivery.createMany({
        data: dates.map((date: Date, i: number) => ({
          selectionId: selection.id,
          userId: selection.userId,
          deliveryDate: date,
          occurrence: i + 1,
          quantityLitres: quantityForOccurrence(qMode, i + 1, qty, qA, qB),
          status: DeliveryStatus.SCHEDULED,
        })),
        skipDuplicates: true,
      });
    }

    await tx.planSelection.update({
      where: { id: selection.id },
      data: {
        frequency: freq,
        quantityMode: qMode,
        quantity: qMode === QuantityMode.FIXED ? qty : null,
        quantityA: qMode === QuantityMode.ALTERNATING ? qA : null,
        quantityB: qMode === QuantityMode.ALTERNATING ? qB : null,
      },
    });
  }

  private async applyPlanChange(
    tx: any,
    selection: any,
    requested: Record<string, any>,
  ) {
    await tx.planSelection.update({
      where: { id: selection.id },
      data: { planType: requested.planType },
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  Private — helpers
  // ══════════════════════════════════════════════════════════════════

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

  private async rejectDuplicatePending(
    userId: string,
    planSelectionId: string,
    requestType: ChangeRequestType,
  ) {
    const existing = await this.prisma.manageDeliveryChangeRequest.findFirst({
      where: {
        userId,
        planSelectionId,
        requestType,
        status: ChangeRequestStatus.PENDING,
      },
    });
    if (existing) {
      throw new ConflictException(
        "You already have a pending request of this type. Please wait for admin review.",
      );
    }
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

  private formatCustomerRequest(r: any) {
    const base: any = {
      id: r.id,
      type: r.requestType,
      status: r.status,
      currentConfiguration: r.currentConfiguration,
      requestedConfiguration: r.requestedConfiguration,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
    };

    if (r.status === ChangeRequestStatus.PENDING) {
      base.message = "Your change request is pending admin approval.";
    } else if (r.status === ChangeRequestStatus.APPROVED) {
      base.message =
        "Your change request has been approved and your delivery schedule has been updated.";
    } else if (r.status === ChangeRequestStatus.REJECTED) {
      base.message = "Your change request was rejected.";
      base.adminNote = r.adminNote;
      base.reason = r.adminNote;
    }

    return base;
  }

  buildView(
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
    deliveryStartTime?: string | null,
    deliveryEndTime?: string | null,
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
      deliveryStartTime: deliveryStartTime ?? DEFAULT_DELIVERY_START_TIME,
      deliveryEndTime: deliveryEndTime ?? DEFAULT_DELIVERY_END_TIME,
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

  private fmt(d: Date | null): string | null {
    if (!d) return null;
    return toDateOnly(d).toISOString().slice(0, 10);
  }
}
