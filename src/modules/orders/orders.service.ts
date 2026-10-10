import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  OrderStatus,
  PaymentStatus,
  ALLOWED_STATUS_TRANSITIONS,
  REORDER_ELIGIBLE_STATUSES,
  COMPLETION_ELIGIBLE_STATUSES,
} from "./orders.constants";
import {
  generateOrderNumber,
  generateInvoiceNumber,
} from "./order-number.util";
import {
  PlanType,
  DeliveryStatus,
  PlanSelectionStatus,
} from "../plans/plans.constants";
import { CreateOrderDto } from "./dto/customer/create-order.dto";
import { ReorderDto } from "./dto/customer/reorder.dto";
import { CustomerListOrdersQueryDto } from "./dto/customer/list-orders-query.dto";
import { AdminListOrdersQueryDto } from "./dto/admin/list-orders-query.dto";
import { UpdateOrderStatusDto } from "./dto/admin/update-order-status.dto";
import { toDateOnly, resolveFirstDeliveryDate } from "../plans/plans.service";

const ACTIVE_STATUSES = [PlanSelectionStatus.CONFIRMED, PlanSelectionStatus.ACTIVE];

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ══════════════════════════════════════════════════════════════════
  //  ORDER NUMBER GENERATION
  // ══════════════════════════════════════════════════════════════════

  private generateOrderNumber(): Promise<string> {
    return generateOrderNumber(this.prisma);
  }

  private generateInvoiceNumber(): Promise<string> {
    return generateInvoiceNumber(this.prisma);
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADDRESS SNAPSHOT
  // ══════════════════════════════════════════════════════════════════

  private async buildAddressSnapshot(userId: string, addressId: string) {
    const address = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, userId },
    });
    if (!address) {
      throw new BadRequestException("Address not found or does not belong to you");
    }
    return {
      fullName: address.fullName,
      mobile: address.mobile,
      houseNumber: address.houseNumber,
      buildingName: address.buildingName,
      streetName: address.streetName,
      landmark: address.landmark,
      state: address.state,
      city: address.city,
      area: address.area,
      pincode: address.pincode,
      latitude: address.latitude,
      longitude: address.longitude,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — CREATE ORDER
  // ══════════════════════════════════════════════════════════════════

  async createOrder(userId: string, dto: CreateOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Verify the PlanDelivery belongs to this user and is SCHEDULED.
      const delivery = await tx.planDelivery.findFirst({
        where: { id: dto.planDeliveryId, userId },
      });
      if (!delivery) {
        throw new BadRequestException("Delivery not found or does not belong to you");
      }
      if (delivery.status !== DeliveryStatus.SCHEDULED) {
        throw new BadRequestException("This delivery is not in a schedulable state");
      }

      // 2. Verify no order already exists for this delivery (DB unique + app check).
      const existingOrder = await tx.order.findUnique({
        where: { planDeliveryId: delivery.id },
      });
      if (existingOrder) {
        throw new ConflictException("An order already exists for this delivery");
      }

      // 3. Get the PlanSelection.
      const selection = await tx.planSelection.findFirst({
        where: { id: delivery.selectionId, userId, status: { in: ACTIVE_STATUSES } },
      });
      if (!selection) {
        throw new BadRequestException("No active plan found for this delivery");
      }

      // Prepaid plan: the plan payment covers all deliveries, so the order
      // is born PAID. The customer is never charged again for this delivery.
      const isPrepaid = selection.paidAmountPaise != null && selection.paidAmountPaise > 0;

      // 4. Get the PlanConfig for pricing & delivery config.
      const config = await tx.planConfig.findUnique({
        where: { planType: selection.planType },
      });
      if (!config || !config.isActive) {
        throw new BadRequestException("Plan configuration is not available");
      }

      // 5. Build address snapshot.
      const addressSnapshot = await this.buildAddressSnapshot(userId, dto.addressId);

      // 6. Calculate financials (all in paise).
      const quantityLitres = delivery.quantityLitres;
      const unitPricePaise = config.sellingPricePerLitre;
      const actualPricePaise = config.actualPricePerLitre;
      const itemTotal = unitPricePaise * quantityLitres;
      const itemDiscount = (actualPricePaise - unitPricePaise) * quantityLitres;
      const deliveryFeePaise = config.deliveryFeePaise;
      const subtotalPaise = itemTotal;
      const totalPaise = subtotalPaise + deliveryFeePaise;

      // 7. Generate order number.
      const orderNumber = await this.generateOrderNumber();

      // 8. Create the order with one item (milk delivery).
      const order = await tx.order.create({
        data: {
          orderNumber,
          userId,
          planSelectionId: selection.id,
          planDeliveryId: delivery.id,
          planType: selection.planType,
          status: OrderStatus.CONFIRMED,
          paymentStatus: isPrepaid ? PaymentStatus.PAID : PaymentStatus.PENDING,
          subtotalPaise,
          discountPaise: itemDiscount > 0 ? itemDiscount : 0,
          taxPaise: 0,
          deliveryFeePaise,
          totalPaise,
          deliveryDate: delivery.deliveryDate,
          // Verbatim snapshot: null when the plan has no configured window, so
          // clients show "not available" rather than an invented time.
          deliveryStartTime: config.deliveryStartTime,
          deliveryEndTime: config.deliveryEndTime,
          addressSnapshot,
          actualPricePerLitrePaise: actualPricePaise,
          sellingPricePerLitrePaise: unitPricePaise,
          items: {
            create: {
              productNameSnapshot: "Milk",
              quantity: quantityLitres,
              unitPricePaise,
              discountPaise: itemDiscount > 0 ? itemDiscount : 0,
              taxPaise: 0,
              totalPaise: itemTotal,
            },
          },
        },
        include: { items: true },
      });

      // 9. Create the invoice.
      const invoiceNumber = await this.generateInvoiceNumber();
      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          orderId: order.id,
          financialSnapshot: {
            subtotalPaise,
            discountPaise: order.discountPaise,
            taxPaise: order.taxPaise,
            deliveryFeePaise,
            totalPaise,
            items: order.items.map((i) => ({
              productNameSnapshot: i.productNameSnapshot,
              quantity: i.quantity,
              unitPricePaise: i.unitPricePaise,
              discountPaise: i.discountPaise,
              taxPaise: i.taxPaise,
              totalPaise: i.totalPaise,
            })),
          },
          addressSnapshot,
        },
      });

      return {
        success: true,
        message: "Order created successfully.",
        order: this.formatOrderResponse(order, order.items, invoice),
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — LIST ORDERS
  // ══════════════════════════════════════════════════════════════════

  async getCustomerOrders(userId: string, query: CustomerListOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: any = { userId };
    if (query.status) where.status = query.status;
    if (query.planType) where.planType = query.planType;
    if (query.orderNumber) where.orderNumber = { contains: query.orderNumber, mode: "insensitive" };
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        end.setUTCDate(end.getUTCDate() + 1);
        where.createdAt.lt = end;
      }
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { items: true, invoice: true },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders.map((o) => this.formatOrderResponse(o, o.items, o.invoice)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — GET ONE ORDER
  // ══════════════════════════════════════════════════════════════════

  async getCustomerOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { items: true, invoice: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    return this.formatOrderResponse(order, order.items, order.invoice);
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — INVOICE
  // ══════════════════════════════════════════════════════════════════

  async getCustomerInvoice(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { invoice: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!order.invoice) throw new NotFoundException("Invoice not found for this order");

    return {
      invoiceNumber: order.invoice.invoiceNumber,
      orderNumber: order.orderNumber,
      issuedAt: order.invoice.issuedAt,
      financialSnapshot: order.invoice.financialSnapshot,
      addressSnapshot: order.invoice.addressSnapshot,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — REORDER
  // ══════════════════════════════════════════════════════════════════

  async reorder(userId: string, orderId: string, dto: ReorderDto) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Verify original order belongs to customer and is eligible.
      const original = await tx.order.findFirst({
        where: { id: orderId, userId },
        include: { items: true },
      });
      if (!original) throw new NotFoundException("Order not found");

      if (!REORDER_ELIGIBLE_STATUSES.includes(original.status as OrderStatus)) {
        throw new BadRequestException("This order is not eligible for reorder");
      }

      // 2. Get current PlanConfig for current pricing.
      const config = await tx.planConfig.findUnique({
        where: { planType: original.planType },
      });
      if (!config || !config.isActive) {
        throw new BadRequestException("The plan type for this order is no longer available");
      }

      // 3. Build address snapshot with current address.
      const addressSnapshot = await this.buildAddressSnapshot(userId, dto.addressId);

      // 4. Recalculate using CURRENT configuration.
      const originalItem = original.items[0];
      if (!originalItem) throw new BadRequestException("Original order has no items");

      const quantityLitres = originalItem.quantity;
      const unitPricePaise = config.sellingPricePerLitre;
      const actualPricePaise = config.actualPricePerLitre;
      const itemTotal = unitPricePaise * quantityLitres;
      const itemDiscount = (actualPricePaise - unitPricePaise) * quantityLitres;
      const deliveryFeePaise = config.deliveryFeePaise;
      const subtotalPaise = itemTotal;
      const totalPaise = subtotalPaise + deliveryFeePaise;

      // A reorder is a fresh order placed now, so it inherits the same order
      // cut-off as a new plan: tomorrow (IST), or the day after when placed at
      // or after 23:00 IST. Previously no deliveryDate was set at all, which
      // left the UI rendering the creation date as if it were the delivery day.
      const deliveryDate = resolveFirstDeliveryDate();
      if (!(deliveryDate instanceof Date) || Number.isNaN(deliveryDate.getTime())) {
        // Unreachable with a sane clock, but a reorder must never be persisted
        // without a delivery date — that is what produced the createdAt
        // fallback in the first place.
        throw new BadRequestException(
          "Could not determine a delivery date for this reorder. Please try again.",
        );
      }

      const orderNumber = await this.generateOrderNumber();

      const newOrder = await tx.order.create({
        data: {
          orderNumber,
          userId,
          planType: original.planType,
          status: OrderStatus.PENDING,
          paymentStatus: PaymentStatus.PENDING,
          subtotalPaise,
          discountPaise: itemDiscount > 0 ? itemDiscount : 0,
          taxPaise: 0,
          deliveryFeePaise,
          totalPaise,
          deliveryDate,
          deliveryStartTime: config.deliveryStartTime,
          deliveryEndTime: config.deliveryEndTime,
          addressSnapshot,
          actualPricePerLitrePaise: actualPricePaise,
          sellingPricePerLitrePaise: unitPricePaise,
          reorderedFromOrderId: original.id,
          items: {
            create: original.items.map((item) => ({
              productId: item.productId,
              productNameSnapshot: item.productNameSnapshot,
              quantity: item.quantity,
              unitPricePaise,
              discountPaise: itemDiscount > 0 ? itemDiscount : 0,
              taxPaise: 0,
              totalPaise: unitPricePaise * item.quantity,
            })),
          },
        },
        include: { items: true },
      });

      // 5. Create invoice for the new order.
      const invoiceNumber = await this.generateInvoiceNumber();
      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          orderId: newOrder.id,
          financialSnapshot: {
            subtotalPaise,
            discountPaise: newOrder.discountPaise,
            taxPaise: newOrder.taxPaise,
            deliveryFeePaise,
            totalPaise,
            items: newOrder.items.map((i) => ({
              productNameSnapshot: i.productNameSnapshot,
              quantity: i.quantity,
              unitPricePaise: i.unitPricePaise,
              discountPaise: i.discountPaise,
              taxPaise: i.taxPaise,
              totalPaise: i.totalPaise,
            })),
          },
          addressSnapshot,
        },
      });

      return {
        success: true,
        message: "Reorder created successfully.",
        order: this.formatOrderResponse(newOrder, newOrder.items, invoice),
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — LIST ORDERS
  // ══════════════════════════════════════════════════════════════════

  async getAdminOrders(query: AdminListOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.paymentStatus) where.paymentStatus = query.paymentStatus;
    if (query.planType) where.planType = query.planType;
    if (query.orderNumber) where.orderNumber = { contains: query.orderNumber, mode: "insensitive" };
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        end.setUTCDate(end.getUTCDate() + 1);
        where.createdAt.lt = end;
      }
    }
    if (query.customerSearch) {
      where.user = {
        OR: [
          { mobile: { contains: query.customerSearch, mode: "insensitive" } },
          { email: { contains: query.customerSearch, mode: "insensitive" } },
          {
            customerProfile: {
              OR: [
                { firstName: { contains: query.customerSearch, mode: "insensitive" } },
                { lastName: { contains: query.customerSearch, mode: "insensitive" } },
              ],
            },
          },
        ],
      };
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          items: true,
          invoice: true,
          user: {
            select: {
              id: true,
              mobile: true,
              email: true,
              customerProfile: { select: { firstName: true, lastName: true } },
            },
          },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders.map((o) => ({
        ...this.formatOrderResponse(o, o.items, o.invoice),
        customer: {
          id: o.user.id,
          mobile: o.user.mobile,
          email: o.user.email,
          name: o.user.customerProfile
            ? `${o.user.customerProfile.firstName} ${o.user.customerProfile.lastName}`
            : null,
        },
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — GET ONE ORDER
  // ══════════════════════════════════════════════════════════════════

  async getAdminOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        invoice: true,
        user: {
          select: {
            id: true,
            mobile: true,
            email: true,
            customerProfile: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    return {
      ...this.formatOrderResponse(order, order.items, order.invoice),
      customer: {
        id: order.user.id,
        mobile: order.user.mobile,
        email: order.user.email,
        name: order.user.customerProfile
          ? `${order.user.customerProfile.firstName} ${order.user.customerProfile.lastName}`
          : null,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — UPDATE STATUS
  // ══════════════════════════════════════════════════════════════════

  async updateOrderStatus(orderId: string, dto: UpdateOrderStatusDto) {
    // COMPLETED carries eligibility rules of its own (the delivery behind the
    // order must actually have fallen due and not been skipped). Routing it
    // through the dedicated path means the generic status endpoint cannot be
    // used to sidestep those rules.
    if (dto.status === OrderStatus.COMPLETED) {
      return this.completeOrder(orderId);
    }

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException("Order not found");

      const allowed = ALLOWED_STATUS_TRANSITIONS[order.status] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `Cannot transition from ${order.status} to ${dto.status}`,
        );
      }

      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: dto.status },
        include: { items: true, invoice: true },
      });

      return {
        success: true,
        message: `Order status updated to ${dto.status}.`,
        order: this.formatOrderResponse(updated, updated.items, updated.invoice),
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — COMPLETE ORDER
  // ══════════════════════════════════════════════════════════════════

  /**
   * Closes a delivered order by moving it to the terminal COMPLETED status.
   *
   * Completion is deliberately an accounting act and nothing more. It writes
   * exactly two columns on exactly one `orders` row — `status` and
   * `completedAt` — and touches no PlanDelivery, PlanSelection, Wallet,
   * Payment, CashCollection or Invoice record. That is what keeps it safe to
   * expose as a one-click admin action: there is no money and no delivery
   * promise riding on the button.
   *
   * Consequently it never *creates* the evidence that a delivery happened. The
   * order must already be DELIVERED (reached through the normal status flow),
   * and for a plan order the individual PlanDelivery behind it is read — never
   * written — to confirm it was not skipped and is not still in the future.
   * Sibling deliveries of the same plan, past or future, are not queried at
   * all, so completing one day of a Trial or Monthly plan cannot disturb the
   * rest of the schedule.
   *
   * Repeating the call on an already-completed order is a no-op success: the
   * conditional update matches zero rows, and the original `completedAt` is
   * returned unchanged.
   */
  async completeOrder(orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { planDelivery: true, items: true, invoice: true },
      });
      if (!order) throw new NotFoundException("Order not found");

      // Idempotency: already completed is a success, not a conflict, and must
      // not refresh completedAt — the first completion is the real one.
      if (order.status === OrderStatus.COMPLETED) {
        return {
          success: true,
          message: "Order is already completed.",
          alreadyCompleted: true,
          order: this.formatOrderResponse(order, order.items, order.invoice),
        };
      }

      if (!COMPLETION_ELIGIBLE_STATUSES.includes(order.status as OrderStatus)) {
        throw new BadRequestException(
          `Only a ${OrderStatus.DELIVERED} order can be completed. This order is ${order.status}.`,
        );
      }

      // Plan orders own exactly one PlanDelivery (orders.planDeliveryId is
      // unique). Its status is the record of what physically happened, so it
      // decides eligibility — and is left exactly as it is.
      if (order.planDeliveryId) {
        const delivery = order.planDelivery;
        if (!delivery) {
          throw new ConflictException(
            "The delivery record for this order is missing, so it cannot be completed.",
          );
        }
        if (delivery.status === DeliveryStatus.SKIPPED) {
          throw new BadRequestException(
            "This order's delivery was skipped, so the order cannot be completed.",
          );
        }
        const today = toDateOnly(new Date()).getTime();
        if (toDateOnly(new Date(delivery.deliveryDate)).getTime() > today) {
          throw new BadRequestException(
            "This order's delivery is still scheduled for a future date.",
          );
        }
      }

      // Conditional update: the status we validated is part of the WHERE, so a
      // concurrent completion (or cancellation) loses the race instead of
      // overwriting the winner.
      const result = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.DELIVERED },
        data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
      });

      if (result.count === 0) {
        const latest = await tx.order.findUnique({
          where: { id: orderId },
          include: { items: true, invoice: true },
        });
        if (latest?.status === OrderStatus.COMPLETED) {
          return {
            success: true,
            message: "Order is already completed.",
            alreadyCompleted: true,
            order: this.formatOrderResponse(latest, latest.items, latest.invoice),
          };
        }
        throw new ConflictException(
          "This order changed while it was being completed. Reload it and try again.",
        );
      }

      const updated = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true, invoice: true },
      });

      this.logger.log(
        `ORDER COMPLETED orderId=${orderId} orderNumber=${order.orderNumber} ` +
          `planType=${order.planType} planDeliveryId=${order.planDeliveryId ?? "none"}`,
      );

      return {
        success: true,
        message: "Order marked as completed.",
        alreadyCompleted: false,
        order: this.formatOrderResponse(updated, updated!.items, updated!.invoice),
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  FORMATTING
  // ══════════════════════════════════════════════════════════════════

  private formatOrderResponse(order: any, items: any[], invoice: any) {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      planType: order.planType,
      status: order.status,
      paymentStatus: order.paymentStatus,
      items: items.map((i: any) => ({
        id: i.id,
        productId: i.productId,
        productNameSnapshot: i.productNameSnapshot,
        quantity: i.quantity,
        unitPricePaise: i.unitPricePaise,
        discountPaise: i.discountPaise,
        taxPaise: i.taxPaise,
        totalPaise: i.totalPaise,
      })),
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      taxPaise: order.taxPaise,
      deliveryFeePaise: order.deliveryFeePaise,
      totalPaise: order.totalPaise,
      deliveryDate: order.deliveryDate
        ? new Date(order.deliveryDate).toISOString().slice(0, 10)
        : null,
      deliveryStartTime: order.deliveryStartTime,
      deliveryEndTime: order.deliveryEndTime,
      addressSnapshot: order.addressSnapshot,
      actualPricePerLitrePaise: order.actualPricePerLitrePaise,
      sellingPricePerLitrePaise: order.sellingPricePerLitrePaise,
      reorderedFromOrderId: order.reorderedFromOrderId,
      completedAt: order.completedAt ?? null,
      invoice: invoice
        ? {
            invoiceNumber: invoice.invoiceNumber,
            issuedAt: invoice.issuedAt,
          }
        : null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
}
