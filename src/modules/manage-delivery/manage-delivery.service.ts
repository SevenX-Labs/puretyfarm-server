import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  NotImplementedException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PlanType,
  DeliveryFrequency,
  QuantityMode,
  DeliveryStatus,
  PlanSelectionStatus,
  ChangeRequestType,
  ChangeRequestStatus,
} from '../plans/plans.constants';
import {
  toDateOnly,
  generateDeliveryDates,
  quantityForOccurrence,
} from '../plans/plans.service';
import { toIsoDateString } from '../../common/utils/ist-date.util';
import { OrderStatus } from '../orders/orders.constants';
import { PlansService } from '../plans/plans.service';
import type { OrderPriceSnapshot } from '../plans/plans.service';
import { SkipDeliveryDto } from './dto/customer/skip-delivery.dto';
import { ChangeQuantityDto } from './dto/customer/change-quantity.dto';
import { ChangeFrequencyDto } from './dto/customer/change-frequency.dto';
import { ChangePlanDto } from './dto/customer/change-plan.dto';
import { ChangeScheduleDto } from './dto/customer/change-schedule.dto';
import { PauseDeliveryDto } from './dto/customer/pause-delivery.dto';
import { RejectRequestDto } from './dto/admin/reject-request.dto';
import { ListRequestsQueryDto } from './dto/admin/list-requests-query.dto';

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

const ACTIVE_STATUSES: PlanSelectionStatus[] = [
  PlanSelectionStatus.CONFIRMED,
  PlanSelectionStatus.ACTIVE,
];

/**
 * Statuses whose plan the customer may still *see* on Manage Delivery.
 * Broader than ACTIVE_STATUSES, which gates mutations.
 */
const VIEWABLE_STATUSES: PlanSelectionStatus[] = [
  ...ACTIVE_STATUSES,
  PlanSelectionStatus.PAUSED,
];

/**
 * Order statuses that have not left the warehouse, so may still be stood down
 * when a schedule changes. Anything beyond these is a fulfilment record.
 */
const REPLACEABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
];

// ─── Service ────────────────────────────────────────────────────────

@Injectable()
export class ManageDeliveryService {
  private readonly logger = new Logger(ManageDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plansService: PlansService,
  ) {}

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — GET
  // ══════════════════════════════════════════════════════════════════

  async getManageDelivery(userId: string): Promise<ManageDeliveryResponse> {
    // PAUSED is included here (but not in `requireActiveSelection`, which gates
    // mutations): a paused plan must stay visible so the customer can see its
    // state and submit a resume request.
    const selection = await this.prisma.planSelection.findFirst({
      where: { userId, status: { in: VIEWABLE_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (!selection) {
      throw new NotFoundException('No active plan found');
    }
    const [deliveries, config] = await Promise.all([
      this.prisma.planDelivery.findMany({
        where: { selectionId: selection.id, userId },
        orderBy: { deliveryDate: 'asc' },
      }),
      this.prisma.planConfig.findUnique({
        where: { planType: selection.planType as any },
      }),
    ]);
    return this.buildView(
      selection,
      deliveries,
      config?.deliveryStartTime,
      config?.deliveryEndTime,
    );
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — SKIP (immediate, no approval)
  // ══════════════════════════════════════════════════════════════════

  async skipDelivery(
    userId: string,
    dto: SkipDeliveryDto,
  ): Promise<{
    success: true;
    message: string;
    delivery: ManageDeliveryResponse;
  }> {
    const today = toDateOnly(new Date());
    const target = toDateOnly(new Date(dto.deliveryDate));

    if (target.getTime() <= today.getTime()) {
      throw new BadRequestException('Only future deliveries can be skipped');
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
      throw new BadRequestException('This delivery is already skipped');
    }
    if (delivery.status === DeliveryStatus.DELIVERED) {
      throw new BadRequestException('A completed delivery cannot be skipped');
    }

    // Skip the delivery and stand down its dispatch order together, so the
    // warehouse never keeps a live order for a delivery the customer cancelled.
    await this.prisma.$transaction(async (tx) => {
      // The status guard makes a double-click or concurrent request a no-op
      // rather than a second cancellation.
      const res = await tx.planDelivery.updateMany({
        where: { id: delivery.id, status: DeliveryStatus.SCHEDULED },
        data: { status: DeliveryStatus.SKIPPED },
      });
      if (res.count === 0) {
        throw new BadRequestException(
          'This delivery could not be skipped (it was just modified)',
        );
      }

      const order = await tx.order.findUnique({
        where: { planDeliveryId: delivery.id },
        select: { id: true, status: true, orderNumber: true },
      });
      if (!order) return;

      // Cancel, never delete: the order number, invoice and any payment
      // linkage stay auditable, and CANCELLED is excluded from revenue
      // aggregates. An order already out for delivery or delivered is left
      // exactly as it is — it is a fulfilment record, and the delivery-date
      // guard above means this should not normally arise.
      if (!REPLACEABLE_ORDER_STATUSES.includes(order.status as any)) {
        this.logger.warn(
          `Delivery skipped but its order was left untouched because it has ` +
            `advanced: orderNumber=${order.orderNumber} orderStatus=${order.status} ` +
            `deliveryId=${delivery.id}`,
        );
        return;
      }

      await tx.order.updateMany({
        where: {
          id: order.id,
          status: { in: REPLACEABLE_ORDER_STATUSES as any },
        },
        data: { status: 'CANCELLED' },
      });
    });

    const view = await this.getManageDelivery(userId);
    return {
      success: true,
      message: 'Delivery skipped successfully.',
      delivery: view,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — PAUSE / RESUME (both create a PENDING request)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Requests a pause. Creates a PENDING ManageDeliveryChangeRequest and
   * changes nothing about the live plan.
   *
   * This used to skip every future SCHEDULED delivery the instant the customer
   * clicked, with no resume path to undo it — a destructive, unreviewable
   * mutation. Pause now goes through the same admin review as every other
   * change request; `applyPause` performs the actual suspension on approval.
   */
  async pauseDelivery(userId: string, dto: PauseDeliveryDto) {
    const selection = await this.requireActiveSelection(userId);

    await this.rejectDuplicatePending(
      userId,
      selection.id,
      ChangeRequestType.PAUSE,
    );
    // A pending resume and a pending pause would contradict each other.
    await this.rejectDuplicatePending(
      userId,
      selection.id,
      ChangeRequestType.RESUME,
    );

    let resumeDate: string | undefined;
    if (dto.resumeDate) {
      const today = toDateOnly(new Date());
      const resume = toDateOnly(new Date(dto.resumeDate));
      if (resume.getTime() <= today.getTime()) {
        throw new BadRequestException('resumeDate must be in the future');
      }
      if (
        selection.endDate &&
        resume.getTime() > toDateOnly(selection.endDate).getTime()
      ) {
        throw new BadRequestException(
          "resumeDate cannot be after your plan's end date",
        );
      }
      resumeDate = toIsoDateString(resume);
    }

    const request = await this.prisma.manageDeliveryChangeRequest.create({
      data: {
        userId,
        planSelectionId: selection.id,
        requestType: ChangeRequestType.PAUSE,
        status: ChangeRequestStatus.PENDING,
        currentConfiguration: {
          status: selection.status,
          frequency: selection.frequency,
          quantityMode: selection.quantityMode,
          quantity: selection.quantity,
          startDate: this.fmt(selection.startDate),
          endDate: this.fmt(selection.endDate),
        },
        requestedConfiguration: {
          status: PlanSelectionStatus.PAUSED,
          ...(resumeDate ? { resumeDate } : {}),
        },
      },
    });

    return {
      success: true,
      message:
        'Your pause request has been submitted. Deliveries continue as normal until an admin approves it.',
      request: this.formatCustomerRequest(request),
    };
  }

  /**
   * Requests a resume for a PAUSED plan. Also approval-gated.
   */
  async resumeDelivery(userId: string) {
    const selection = await this.prisma.planSelection.findFirst({
      where: { userId, status: PlanSelectionStatus.PAUSED },
      orderBy: { createdAt: 'desc' },
    });
    if (!selection) {
      throw new NotFoundException('You have no paused plan to resume');
    }

    await this.rejectDuplicatePending(
      userId,
      selection.id,
      ChangeRequestType.RESUME,
    );
    await this.rejectDuplicatePending(
      userId,
      selection.id,
      ChangeRequestType.PAUSE,
    );

    const request = await this.prisma.manageDeliveryChangeRequest.create({
      data: {
        userId,
        planSelectionId: selection.id,
        requestType: ChangeRequestType.RESUME,
        status: ChangeRequestStatus.PENDING,
        currentConfiguration: {
          status: selection.status,
          startDate: this.fmt(selection.startDate),
          endDate: this.fmt(selection.endDate),
        },
        requestedConfiguration: {
          status: PlanSelectionStatus.CONFIRMED,
        },
      },
    });

    return {
      success: true,
      message:
        'Your resume request has been submitted. Your plan stays paused until an admin approves it.',
      request: this.formatCustomerRequest(request),
    };
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
        'Your quantity change request has been submitted for admin approval.',
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
        'Frequency changes apply to monthly plans only',
      );
    }

    if (selection.frequency === dto.frequency) {
      throw new BadRequestException(
        'Requested frequency is the same as current',
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
        'Your delivery frequency change request has been submitted for admin approval.',
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
        'Requested plan type is the same as current',
      );
    }

    // Verify the target plan is active in the system.
    const targetConfig = await this.prisma.planConfig.findUnique({
      where: { planType: dto.planType },
    });
    if (!targetConfig || !targetConfig.isActive) {
      throw new BadRequestException(
        'The requested plan type is not currently available',
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
        'Your plan change request has been submitted for admin approval.',
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
        'Frequency and quantity-pattern changes apply to monthly plans only',
      );
    }
    if (!selection.endDate) {
      throw new BadRequestException(
        'This plan has no schedule window to reconfigure',
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
        'Your schedule change request has been submitted for admin approval.',
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
      orderBy: { createdAt: 'desc' },
    });
    return requests.map((r) => this.formatCustomerRequest(r));
  }

  async getCustomerRequest(userId: string, requestId: string) {
    const request = await this.prisma.manageDeliveryChangeRequest.findFirst({
      where: { id: requestId, userId },
    });
    if (!request) {
      throw new NotFoundException('Request not found');
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
        orderBy: { createdAt: 'desc' },
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
      throw new NotFoundException('Request not found');
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
        if (!existing) throw new NotFoundException('Request not found');
        throw new ConflictException(
          `Request has already been ${existing.status.toLowerCase()}`,
        );
      }

      const request = await tx.manageDeliveryChangeRequest.findUnique({
        where: { id: requestId },
      });
      if (!request) throw new NotFoundException('Request not found');

      const warnings = await this.applyApprovedChange(tx, request);

      return {
        success: true,
        message: 'The change request has been approved and applied.',
        /**
         * Operator-facing caveats about what the approval did NOT do. Empty for
         * a fully self-contained change.
         */
        warnings,
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
        if (!existing) throw new NotFoundException('Request not found');
        throw new ConflictException(
          `Request has already been ${existing.status.toLowerCase()}`,
        );
      }

      return {
        success: true,
        message: 'The change request has been rejected.',
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

  private async applyApprovedChange(tx: any, request: any): Promise<string[]> {
    const requested = request.requestedConfiguration as Record<string, any>;
    const selection = await tx.planSelection.findUnique({
      where: { id: request.planSelectionId },
    });

    // Throw, never return: this runs after the request row has already been
    // flipped to APPROVED, so swallowing a missing selection left a request
    // marked approved with nothing applied. Throwing rolls the whole
    // transaction back, keeping the request PENDING and reviewable.
    if (!selection) {
      throw new NotFoundException(
        'The plan this request belongs to no longer exists.',
      );
    }

    // Revalidate the lifecycle against the latest persisted state. A plan may
    // have been cancelled or completed between request and review.
    const requiresActivePlan = request.requestType !== ChangeRequestType.RESUME;
    if (requiresActivePlan && !ACTIVE_STATUSES.includes(selection.status)) {
      throw new ConflictException(
        `This plan is ${selection.status} and can no longer be changed.`,
      );
    }

    switch (request.requestType) {
      case ChangeRequestType.CHANGE_QUANTITY:
        return this.blockQuantityChangeApproval();
      case ChangeRequestType.CHANGE_FREQUENCY:
        await this.applyFrequencyChange(tx, selection, requested);
        return [];
      case ChangeRequestType.CHANGE_PLAN:
        return this.blockPlanChangeApproval();
      case ChangeRequestType.PAUSE:
        await this.applyPause(tx, selection, requested, request.id);
        return [];
      case ChangeRequestType.RESUME:
        await this.applyResume(tx, selection);
        return [];
      default:
        throw new BadRequestException(
          `Unsupported request type: ${request.requestType}`,
        );
    }
  }

  /**
   * TEMPORARILY DISABLED — approving a CHANGE_QUANTITY request is blocked until
   * a prepaid-plan billing / refund / settlement policy exists.
   *
   * A plan's upcoming deliveries are each backed by an order created PAID with
   * an immutable price snapshot and an Invoice, and the money actually
   * collected lives at plan level (`PlanSelection.paidAmountPaise`, what the
   * dashboard aggregates as sales). Changing the active quantity changes what is
   * physically dispatched and therefore what is owed, but there is no defined,
   * consistently implemented rule for reconciling the difference — extra
   * charge, refund, or wallet adjustment — against those immutable financial
   * snapshots. Applying the change anyway would leave deliveries, orders,
   * invoices and collected amounts disagreeing with each other.
   *
   * This throws (rather than returns) on purpose. It runs inside the approval
   * transaction, AFTER the request row was optimistically flipped to APPROVED,
   * so throwing rolls the whole transaction back: the request stays PENDING and
   * reviewable, and the active quantity — along with every delivery, order and
   * invoice — is left exactly as it was. The admin sees the explanation below.
   *
   * Re-enable once a prepaid-plan quantity-change billing/refund/settlement
   * policy is defined and implemented.
   */
  private blockQuantityChangeApproval(): Promise<string[]> {
    throw new NotImplementedException(
      "Approving quantity changes is temporarily disabled. A prepaid plan's " +
        'upcoming deliveries are already paid against fixed price snapshots and ' +
        'invoices, and there is no billing, refund or settlement rule for the ' +
        'difference a new quantity would create. The request has been kept ' +
        'PENDING and the active quantity is unchanged — reject it, or re-enable ' +
        'approval once a prepaid-plan quantity-change billing/refund/settlement ' +
        'policy is in place.',
    );
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

    const freq = requested.frequency as DeliveryFrequency;
    const qMode = (requested.quantityMode ??
      selection.quantityMode ??
      QuantityMode.FIXED) as QuantityMode;
    const qty = requested.quantity ?? selection.quantity;
    const qA = requested.quantityA ?? selection.quantityA;
    const qB = requested.quantityB ?? selection.quantityB;

    const dates = generateDeliveryDates(freq, firstFuture, end);

    // Non-destructive reconciliation. This used to `deleteMany` every future
    // SCHEDULED delivery before regenerating, which severed each one from its
    // dispatch order: the order survived (optional relation, SetNull) as an
    // orphaned CONFIRMED + PAID + invoiced row still counted in revenue, while
    // the new deliveries got no orders at all.
    await this.reconcileFutureSchedule(
      tx,
      selection,
      today,
      dates,
      (occurrence) => quantityForOccurrence(qMode, occurrence, qty, qA, qB),
    );

    // Give the newly created deliveries their dispatch orders. Reconciliation
    // cancelled the orders of any date that dropped out of the cadence, so
    // without this the new cadence had deliveries and no orders.
    //
    // These are new orders for an EXISTING subscription, so they must reuse the
    // price the customer already locked in — not the current PlanConfig, which
    // an admin may have edited since purchase. Resolve the frozen snapshot from
    // the subscription's own orders; if none can be established, the operation
    // is blocked rather than silently repriced (see `requirePriceSnapshot`).
    const freqPriceSnapshot = await this.requirePriceSnapshot(tx, selection.id);
    await this.plansService.materializeOrdersForSchedule(
      tx,
      selection.id,
      selection.userId,
      selection.planType,
      freqPriceSnapshot,
    );

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

  /**
   * Makes the FUTURE portion of a schedule match `targetDates`, preserving
   * everything that carries fulfilment or financial history.
   *
   * Mirrors `PlansService.reconcileScheduleWindow` but is scoped to dates
   * strictly after today in IST, because a cadence change must never disturb
   * today's locked dispatch or anything already past.
   *
   *   - a delivery that is not SCHEDULED is untouched (it is history)
   *   - a SCHEDULED delivery still on the target schedule is KEPT with its
   *     order, so approval is idempotent and no duplicate order appears
   *   - a SCHEDULED delivery that has dropped out of the schedule but whose
   *     order has already advanced past CONFIRMED is also kept — the goods are
   *     in flight, so reality wins over the new cadence
   *   - only an unwanted SCHEDULED delivery whose order is still
   *     PENDING/CONFIRMED (or absent) is stood down: its order is CANCELLED,
   *     never deleted, and the delivery row is marked SKIPPED
   */
  private async reconcileFutureSchedule(
    tx: any,
    selection: any,
    today: Date,
    targetDates: Date[],
    quantityForOccurrenceIndex: (occurrence: number) => number,
  ): Promise<void> {
    const wanted = new Set(targetDates.map((d) => d.getTime()));

    const existing = await tx.planDelivery.findMany({
      where: {
        selectionId: selection.id,
        userId: selection.userId,
        deliveryDate: { gt: today },
      },
      include: { order: { select: { id: true, status: true } } },
    });

    const keptDates = new Set<number>();
    const standDownDeliveryIds: string[] = [];
    const cancelOrderIds: string[] = [];

    for (const delivery of existing) {
      const dateKey = new Date(delivery.deliveryDate).getTime();

      if (delivery.status !== DeliveryStatus.SCHEDULED) {
        keptDates.add(dateKey);
        continue;
      }
      if (wanted.has(dateKey)) {
        keptDates.add(dateKey);
        continue;
      }

      const orderStatus: string | undefined = delivery.order?.status;
      if (
        orderStatus &&
        !REPLACEABLE_ORDER_STATUSES.includes(orderStatus as OrderStatus)
      ) {
        keptDates.add(dateKey);
        this.logger.warn(
          `Cadence reconcile kept out-of-window delivery because its order has ` +
            `advanced: selectionId=${selection.id} ` +
            `deliveryDate=${delivery.deliveryDate} orderStatus=${orderStatus}`,
        );
        continue;
      }

      standDownDeliveryIds.push(delivery.id);
      if (delivery.order) cancelOrderIds.push(delivery.order.id);
    }

    if (cancelOrderIds.length > 0) {
      await tx.order.updateMany({
        where: {
          id: { in: cancelOrderIds },
          status: { in: REPLACEABLE_ORDER_STATUSES },
        },
        data: { status: 'CANCELLED' },
      });
    }

    if (standDownDeliveryIds.length > 0) {
      await tx.planDelivery.updateMany({
        where: {
          id: { in: standDownDeliveryIds },
          status: DeliveryStatus.SCHEDULED,
        },
        data: { status: DeliveryStatus.SKIPPED },
      });
    }

    const newDates = targetDates.filter((d) => !keptDates.has(d.getTime()));
    if (newDates.length === 0) return;

    await tx.planDelivery.createMany({
      data: newDates.map((date: Date) => {
        const occurrence =
          targetDates.findIndex((d) => d.getTime() === date.getTime()) + 1;
        return {
          selectionId: selection.id,
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

  // ══════════════════════════════════════════════════════════════════
  //  Private — apply PAUSE / RESUME
  // ══════════════════════════════════════════════════════════════════

  /**
   * Suspends the plan: moves it to PAUSED and skips the SCHEDULED deliveries
   * inside the pause window (strictly after today, up to `resumeDate` when the
   * customer gave one, otherwise open-ended).
   *
   * Dispatch orders for those deliveries are CANCELLED, not deleted, so order
   * numbers, invoices and payment linkage survive. Deliveries already
   * DELIVERED or SKIPPED, and orders already past CONFIRMED, are left alone.
   */
  private async applyPause(
    tx: any,
    selection: any,
    requested: Record<string, any>,
    requestId: string,
  ) {
    const today = toDateOnly(new Date());
    const dateFilter: any = { gt: today };
    if (requested.resumeDate) {
      dateFilter.lt = toDateOnly(new Date(requested.resumeDate));
    }

    const affected = await tx.planDelivery.findMany({
      where: {
        selectionId: selection.id,
        userId: selection.userId,
        deliveryDate: dateFilter,
        status: DeliveryStatus.SCHEDULED,
      },
      include: { order: { select: { id: true, status: true } } },
    });

    const cancelOrderIds = affected
      .filter(
        (d: any) =>
          d.order && REPLACEABLE_ORDER_STATUSES.includes(d.order.status),
      )
      .map((d: any) => d.order.id);

    if (cancelOrderIds.length > 0) {
      await tx.order.updateMany({
        where: {
          id: { in: cancelOrderIds },
          status: { in: REPLACEABLE_ORDER_STATUSES },
        },
        data: { status: 'CANCELLED' },
      });
    }

    const skippableIds = affected
      .filter(
        (d: any) =>
          !d.order || REPLACEABLE_ORDER_STATUSES.includes(d.order.status),
      )
      .map((d: any) => d.id);

    if (skippableIds.length > 0) {
      await tx.planDelivery.updateMany({
        where: { id: { in: skippableIds }, status: DeliveryStatus.SCHEDULED },
        data: { status: DeliveryStatus.SKIPPED },
      });
    }

    // Record exactly which deliveries this pause suspended. Resume restores
    // precisely these, so a day the CUSTOMER had skipped before the pause stays
    // skipped — there is no other way to tell the two apart, since both end up
    // as DeliveryStatus.SKIPPED.
    await tx.manageDeliveryChangeRequest.update({
      where: { id: requestId },
      data: {
        requestedConfiguration: {
          ...requested,
          pausedDeliveryIds: skippableIds,
        },
      },
    });

    await tx.planSelection.update({
      where: { id: selection.id },
      data: { status: PlanSelectionStatus.PAUSED },
    });
  }

  /**
   * Reactivates a PAUSED plan and rebuilds its remaining cadence from tomorrow
   * (IST) to the plan's existing end date.
   *
   * Never recreates a past delivery and never moves the end date: the billing
   * period is a commercial term settled at purchase. Reconciliation is the same
   * non-destructive routine used by a cadence change, so days already delivered
   * stay delivered and no duplicate order is minted for a date that still has
   * a live one.
   */
  private async applyResume(tx: any, selection: any) {
    if (selection.status !== PlanSelectionStatus.PAUSED) {
      throw new ConflictException(
        `Only a paused plan can be resumed. This plan is ${selection.status}.`,
      );
    }

    await tx.planSelection.update({
      where: { id: selection.id },
      data: { status: PlanSelectionStatus.CONFIRMED },
    });

    const today = toDateOnly(new Date());

    // Step 1 — un-skip exactly the deliveries the pause suspended.
    //
    // Reconciliation alone could not do this: it treats any non-SCHEDULED
    // delivery as history and leaves it alone, so a resume restored nothing and
    // the plan came back with an empty calendar. The pause recorded its own
    // delivery ids, so only those are revived — a day the customer skipped
    // individually stays skipped, and nothing in the past is touched.
    const pauseRequest = await tx.manageDeliveryChangeRequest.findFirst({
      where: {
        planSelectionId: selection.id,
        requestType: ChangeRequestType.PAUSE,
        status: ChangeRequestStatus.APPROVED,
      },
      orderBy: { reviewedAt: 'desc' },
    });

    const pausedIds: string[] = Array.isArray(
      pauseRequest?.requestedConfiguration?.pausedDeliveryIds,
    )
      ? pauseRequest!.requestedConfiguration.pausedDeliveryIds
      : [];

    if (pausedIds.length > 0) {
      await tx.planDelivery.updateMany({
        where: {
          id: { in: pausedIds },
          selectionId: selection.id,
          status: DeliveryStatus.SKIPPED,
          // Strictly future: a paused day that has since passed cannot be
          // delivered, so it is left as history.
          deliveryDate: { gt: today },
        },
        data: { status: DeliveryStatus.SCHEDULED },
      });
    }

    if (!selection.endDate) return;

    const end = toDateOnly(selection.endDate);
    const firstFuture = new Date(today);
    firstFuture.setUTCDate(firstFuture.getUTCDate() + 1);

    // The plan's paid window has already elapsed — the status is resumed, but
    // there is nothing left to schedule. The end date is never extended: it is
    // a commercial term settled at purchase.
    if (end.getTime() < firstFuture.getTime()) return;

    const freq = (selection.frequency ??
      DeliveryFrequency.DAILY) as DeliveryFrequency;
    const qMode = (selection.quantityMode ??
      QuantityMode.FIXED) as QuantityMode;
    const dates = generateDeliveryDates(freq, firstFuture, end);

    // Step 2 — fill any cadence gap left by the pause window, bounded by the
    // existing end date and without duplicating a date that already has a
    // live delivery.
    await this.reconcileFutureSchedule(
      tx,
      selection,
      today,
      dates,
      (occurrence) =>
        quantityForOccurrence(
          qMode,
          occurrence,
          selection.quantity,
          selection.quantityA,
          selection.quantityB,
        ),
    );

    // Step 3 — give every revived or newly created delivery a dispatch order.
    // The pause CANCELLED the originals (kept for audit), so without this the
    // plan would resume with deliveries and no orders.
    //
    // A resume must never silently reprice: the subscription was paid for at a
    // fixed price, so the top-up orders are materialised at the snapshot read
    // back from the subscription's own (cancelled) orders, not at the current
    // PlanConfig. If that snapshot cannot be established the resume is blocked
    // instead of guessing a price (see `requirePriceSnapshot`).
    const resumePriceSnapshot = await this.requirePriceSnapshot(
      tx,
      selection.id,
    );
    await this.plansService.materializeOrdersForSchedule(
      tx,
      selection.id,
      selection.userId,
      selection.planType,
      resumePriceSnapshot,
    );
  }

  /**
   * TEMPORARILY DISABLED — approving a CHANGE_PLAN request is blocked until a
   * complete, consistently implemented plan-type-change policy exists.
   *
   * Switching a selection's `planType` is never just a type swap. A correct
   * change must also define and apply, consistently: the new plan's pricing;
   * its billing duration; the resulting plan end date; the new plan's
   * `quantityMin`/`quantityMax` limits for the current quantity; regeneration
   * of the delivery schedule under the new plan's cadence rules; and how the
   * existing order and invoice financial snapshots are reconciled. None of
   * those rules are defined here yet, and applying a bare type swap would leave
   * the plan priced, dated, quantity-bounded and dispatched as if it were still
   * the old plan.
   *
   * This throws (rather than returns) on purpose — see
   * `blockQuantityChangeApproval` for why: it rolls the approval transaction
   * back so the request stays PENDING and the plan is left completely
   * unchanged. The admin sees the explanation below.
   *
   * Re-enable once pricing, duration, end-date, quantity-limit, delivery and
   * financial-snapshot rules for a plan-type change are defined and
   * implemented.
   */
  private blockPlanChangeApproval(): Promise<string[]> {
    throw new NotImplementedException(
      'Approving plan-type changes is temporarily disabled. Changing the plan ' +
        'type also requires defined rules for pricing, billing duration, the ' +
        "plan end date, the new plan's quantity limits, delivery regeneration " +
        'and reconciling existing order/invoice snapshots — none of which are ' +
        'implemented yet. The request has been kept PENDING and the plan is ' +
        'unchanged — reject it, or re-enable approval once those rules are in ' +
        'place.',
    );
  }

  // ══════════════════════════════════════════════════════════════════
  //  Private — helpers
  // ══════════════════════════════════════════════════════════════════

  /**
   * Reads back the price a subscription has already locked in, from the most
   * recent of its own orders that carries a per-litre price snapshot (orders
   * cancelled by a pause or cadence change still carry theirs, so a resume can
   * recover it). The snapshot — selling/actual per-litre price, delivery fee
   * and delivery window — is what new top-up orders must be billed at so an
   * admin PlanConfig edit made since purchase cannot silently reprice a prepaid
   * plan.
   *
   * Throws when no such snapshot exists: without an established price we cannot
   * safely create new orders for the subscription, so the affected operation is
   * blocked (rolling the transaction back and leaving the change request
   * PENDING) rather than inventing a price from the current configuration.
   */
  private async requirePriceSnapshot(
    tx: any,
    selectionId: string,
  ): Promise<OrderPriceSnapshot> {
    const order = await tx.order.findFirst({
      where: {
        planSelectionId: selectionId,
        sellingPricePerLitrePaise: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        sellingPricePerLitrePaise: true,
        actualPricePerLitrePaise: true,
        deliveryFeePaise: true,
        deliveryStartTime: true,
        deliveryEndTime: true,
      },
    });

    if (!order || order.sellingPricePerLitrePaise == null) {
      throw new ConflictException(
        'This subscription has no established price from an existing order, so ' +
          'new deliveries cannot be scheduled without silently applying the ' +
          'current (possibly changed) plan pricing. The operation was blocked ' +
          "and no new orders were created — resolve the subscription's pricing " +
          'before retrying.',
      );
    }

    return {
      sellingPricePerLitrePaise: order.sellingPricePerLitrePaise,
      actualPricePerLitrePaise: order.actualPricePerLitrePaise ?? null,
      deliveryFeePaise: order.deliveryFeePaise ?? 0,
      deliveryStartTime: order.deliveryStartTime ?? null,
      deliveryEndTime: order.deliveryEndTime ?? null,
    };
  }

  private async requireActiveSelection(userId: string) {
    const selection = await this.prisma.planSelection.findFirst({
      where: { userId, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (!selection) {
      throw new NotFoundException('No active plan found');
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
        'You already have a pending request of this type. Please wait for admin review.',
      );
    }
  }

  private validateScheduleDto(dto: ChangeScheduleDto): void {
    if (dto.quantityMode === QuantityMode.FIXED) {
      if (dto.quantity === undefined || dto.quantity === null) {
        throw new BadRequestException('quantity is required for FIXED mode');
      }
    } else {
      if (dto.quantityA === undefined || dto.quantityA === null) {
        throw new BadRequestException(
          'quantityA is required for ALTERNATING mode',
        );
      }
      if (dto.quantityB === undefined || dto.quantityB === null) {
        throw new BadRequestException(
          'quantityB is required for ALTERNATING mode',
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
      base.message = 'Your change request is pending admin approval.';
    } else if (r.status === ChangeRequestStatus.APPROVED) {
      base.message =
        'Your change request has been approved and your delivery schedule has been updated.';
    } else if (r.status === ChangeRequestStatus.REJECTED) {
      base.message = 'Your change request was rejected.';
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
      // Null means the plan has no configured window. Clients render that as
      // unavailable; substituting a plausible time here would state a delivery
      // promise the business never made.
      deliveryStartTime: deliveryStartTime ?? null,
      deliveryEndTime: deliveryEndTime ?? null,
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
