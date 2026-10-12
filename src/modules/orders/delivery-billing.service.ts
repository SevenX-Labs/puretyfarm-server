import { RealtimeEventsService } from '../realtime/realtime-events.service';
import {
  Optional,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletTransactionReferenceType } from '../wallet/wallet.constants';
import {
  toIstDateOnly,
  toIsoDateString,
} from '../../common/utils/ist-date.util';
import {
  OrderSettlementStatus,
  OrderStatus,
  PaymentStatus,
} from './orders.constants';
import { generateInvoiceNumber } from './order-number.util';
import { DeliveryStatus, PlanBillingModel } from '../plans/plans.constants';
import { resolveFirstDeliveryDate } from '../plans/plans.service';

/** Statuses a delivery may be confirmed from. */
export const DELIVERABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.OUT_FOR_DELIVERY,
];

/** Statuses whose quantity may still change (the order has not been dispatched). */
export const QUANTITY_EDITABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
];

export type SettlementOutcome =
  /** Delivered and charged (or the charge was zero). */
  | 'SETTLED'
  /** Delivered; nothing to charge because the plan was paid upfront. */
  | 'DELIVERED_PREPAID'
  /** Delivered, but the wallet could not cover the charge. Left outstanding. */
  | 'INSUFFICIENT_BALANCE'
  /** Already delivered and settled; nothing was changed. */
  | 'ALREADY_DELIVERED'
  /** Cancelled, failed, skipped or not yet due; nothing was changed. */
  | 'NOT_ELIGIBLE';

export interface SettlementResult {
  outcome: SettlementOutcome;
  orderId: string;
  orderNumber: string;
  customerId: string;
  /** Scheduled delivery date (YYYY-MM-DD), never the confirmation time. */
  scheduledDate: string | null;
  deliveredAt: Date | null;
  settledAt: Date | null;
  /** The delivery charge in paise. Null when nothing is charged per delivery. */
  requiredPaise: number | null;
  /** Wallet balance read inside the transaction, before any debit. */
  availableBalancePaise: number | null;
  balanceAfterPaise: number | null;
  shortfallPaise: number | null;
  walletTransactionId: string | null;
  message: string;
}

export interface OrderQuantityChangeResult {
  orderId: string;
  orderNumber: string;
  customerId: string;
  scheduledDate: string | null;
  oldQuantity: number;
  newQuantity: number;
  oldTotalPaise: number;
  newTotalPaise: number;
  changed: boolean;
}

type Tx = Prisma.TransactionClient;

/**
 * The single billing path for plan deliveries.
 *
 * Every route that can mark an order DELIVERED — the single-order status
 * endpoint, the bulk endpoint and the admin "settle" retry — goes through
 * {@link settleDelivery}. Every route that can change a delivery's quantity —
 * an approved change request or a direct admin edit — goes through
 * {@link applyOrderQuantityChange}. Neither accepts an amount from a caller:
 * amounts are always derived from the persisted order.
 */
@Injectable()
export class DeliveryBillingService {
  private readonly logger = new Logger(DeliveryBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => WalletService))
    private readonly walletService: WalletService,
    @Optional() private readonly realtimeService?: RealtimeEventsService,
  ) {}

  // ══════════════════════════════════════════════════════════════════
  //  DELIVERY SETTLEMENT
  // ══════════════════════════════════════════════════════════════════

  /**
   * Confirms one delivery and charges it to the wallet exactly once.
   *
   * Runs in a single transaction. Locks are always taken in the same order —
   * the order row first, then the wallet row — so two concurrent calls cannot
   * deadlock. The ledger's unique (type, referenceType, referenceId) key is the
   * final guard: a second DEBIT for the same order cannot be written even if
   * every check above it were wrong.
   *
   * Calling it again on a delivered order whose charge is still outstanding
   * retries the charge; that is what the admin "Settle" action does.
   */
  async settleDelivery(
    orderId: string,
    adminId: string | null,
    now: Date = new Date(),
  ): Promise<SettlementResult> {
    try {
      const result = await this.prisma.$transaction((tx) =>
        this.settleDeliveryWithin(tx, orderId, adminId, now),
      );
      try {
        if (result.outcome === 'SETTLED') {
          this.realtimeService?.publishToCustomer(result.customerId, ['orders.updated', 'wallet.updated']);
          this.realtimeService?.publishToAdmins(['admin.orders.updated', 'admin.deliveries.updated', 'admin.wallets.updated', 'admin.dashboard.updated']);
        } else if (result.outcome === 'DELIVERED_PREPAID' || result.outcome === 'INSUFFICIENT_BALANCE') {
          this.realtimeService?.publishToCustomer(result.customerId, ['orders.updated']);
          this.realtimeService?.publishToAdmins(['admin.orders.updated', 'admin.deliveries.updated', 'admin.dashboard.updated']);
        }
      } catch {}
      return result;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // The ledger already holds a debit for this order. The transaction was
        // rolled back, so nothing was charged twice.
        throw new ConflictException({
          error: 'DELIVERY_ALREADY_CHARGED',
          message:
            'This delivery has already been charged. Reload the order and try again.',
        });
      }
      throw err;
    }
  }

  private async settleDeliveryWithin(
    tx: Tx,
    orderId: string,
    adminId: string | null,
    now: Date,
  ): Promise<SettlementResult> {
    // 1. Lock the order row for the rest of the transaction.
    await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;

    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        invoice: true,
        planDelivery: true,
        planSelection: { select: { billingModel: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const scheduledDate = order.deliveryDate
      ? toIsoDateString(new Date(order.deliveryDate))
      : null;
    const base = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.userId,
      scheduledDate,
      deliveredAt: order.deliveredAt,
      settledAt: order.settledAt,
      requiredPaise: null,
      availableBalancePaise: null,
      balanceAfterPaise: null,
      shortfallPaise: null,
      walletTransactionId: order.walletTransactionId,
    };

    const alreadyDelivered =
      order.status === OrderStatus.DELIVERED ||
      order.status === OrderStatus.COMPLETED;
    const isOutstanding =
      order.settlementStatus === OrderSettlementStatus.OUTSTANDING;

    // 2. Already delivered and nothing left to collect: change nothing.
    if (alreadyDelivered && !isOutstanding) {
      return {
        ...base,
        outcome: 'ALREADY_DELIVERED',
        message: `Order is already ${order.status}.`,
      };
    }

    if (!alreadyDelivered) {
      if (!DELIVERABLE_ORDER_STATUSES.includes(order.status as OrderStatus)) {
        return {
          ...base,
          outcome: 'NOT_ELIGIBLE',
          message: `Cannot transition from ${order.status} to ${OrderStatus.DELIVERED}`,
        };
      }
      if (order.planDelivery?.status === DeliveryStatus.SKIPPED) {
        return {
          ...base,
          outcome: 'NOT_ELIGIBLE',
          message: 'Associated delivery was SKIPPED by customer/admin',
        };
      }
    }

    const perDelivery =
      order.planSelection?.billingModel === PlanBillingModel.PER_DELIVERY;
    const chargeable =
      perDelivery && order.paymentStatus !== PaymentStatus.PAID;

    // A delivery that is charged on confirmation cannot be confirmed before
    // its scheduled day: that would debit the wallet for goods not yet due.
    if (!alreadyDelivered && chargeable && order.deliveryDate) {
      const today = toIstDateOnly(now).getTime();
      if (new Date(order.deliveryDate).getTime() > today) {
        return {
          ...base,
          outcome: 'NOT_ELIGIBLE',
          message: `This delivery is scheduled for ${scheduledDate} and cannot be marked delivered before that date.`,
        };
      }
    }

    // 3. Claim the DELIVERED transition. The status guard makes a concurrent
    //    or repeated call match zero rows instead of delivering twice.
    let deliveredAt = order.deliveredAt;
    if (!alreadyDelivered) {
      const claimed = await tx.order.updateMany({
        where: {
          id: order.id,
          status: { in: DELIVERABLE_ORDER_STATUSES as string[] as any },
        },
        data: { status: OrderStatus.DELIVERED, deliveredAt: now },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'This order changed while it was being updated. Reload it and try again.',
        );
      }
      deliveredAt = now;

      if (order.planDeliveryId) {
        // Guarded on SCHEDULED so a skipped delivery is never rewritten, and
        // stamped with the same instant as the order.
        await tx.planDelivery.updateMany({
          where: { id: order.planDeliveryId, status: DeliveryStatus.SCHEDULED },
          data: { status: DeliveryStatus.DELIVERED, deliveredAt: now },
        });
      }
    }

    // 4. Prepaid plans and orders already paid some other way: no debit, ever.
    if (!chargeable) {
      if (perDelivery) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            settlementStatus: OrderSettlementStatus.SETTLED,
            settledAt: order.settledAt ?? now,
          },
        });
      }
      this.logger.log(
        `DELIVERY CONFIRMED (no charge) orderNumber=${order.orderNumber} ` +
          `billing=${perDelivery ? 'ALREADY_PAID' : 'PREPAID'} adminId=${adminId ?? 'unknown'}`,
      );
      return {
        ...base,
        deliveredAt,
        settledAt: perDelivery ? (order.settledAt ?? now) : order.settledAt,
        outcome: perDelivery ? 'SETTLED' : 'DELIVERED_PREPAID',
        message: perDelivery
          ? 'Order marked delivered. It was already paid.'
          : 'Order marked delivered. This plan was paid upfront, so nothing was charged.',
      };
    }

    // 5. The charge comes from the persisted order, never from the caller.
    const amountPaise = this.assertConsistentTotal(order);

    if (amountPaise === 0) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: PaymentStatus.PAID,
          settlementStatus: OrderSettlementStatus.SETTLED,
          settledAt: now,
        },
      });
      await this.ensureInvoice(tx, order);
      return {
        ...base,
        deliveredAt,
        settledAt: now,
        requiredPaise: 0,
        outcome: 'SETTLED',
        message: 'Order marked delivered. Nothing was due.',
      };
    }

    // 6. Lock the wallet and read the balance inside the transaction.
    const wallets = await tx.$queryRaw<
      Array<{ id: string; balancePaise: number }>
    >`SELECT "id", "balancePaise" FROM "wallets" WHERE "userId" = ${order.userId} FOR UPDATE`;
    const availableBalancePaise = wallets[0]?.balancePaise ?? 0;

    if (wallets.length === 0 || availableBalancePaise < amountPaise) {
      // The delivery happened, so it is recorded as delivered; the charge is
      // left outstanding rather than driving the balance negative.
      await tx.order.update({
        where: { id: order.id },
        data: { settlementStatus: OrderSettlementStatus.OUTSTANDING },
      });
      const shortfallPaise = amountPaise - availableBalancePaise;
      this.logger.warn(
        `DELIVERY CHARGE OUTSTANDING orderNumber=${order.orderNumber} ` +
          `requiredPaise=${amountPaise} availablePaise=${availableBalancePaise} ` +
          `shortfallPaise=${shortfallPaise} adminId=${adminId ?? 'unknown'}`,
      );
      return {
        ...base,
        deliveredAt,
        requiredPaise: amountPaise,
        availableBalancePaise,
        shortfallPaise,
        outcome: 'INSUFFICIENT_BALANCE',
        message:
          `Delivery recorded, but the wallet is short by ${shortfallPaise} paise ` +
          `(needs ${amountPaise}, has ${availableBalancePaise}). The charge is outstanding — ` +
          `add funds to the customer's wallet and settle it.`,
      };
    }

    // 7. Debit through the wallet's single balance path, in this transaction.
    const debit = await this.walletService.debitWalletWithin(
      tx,
      order.userId,
      amountPaise,
      WalletTransactionReferenceType.ORDER,
      order.id,
      `Delivery charge — Order #${order.orderNumber} — Scheduled: ${scheduledDate ?? 'n/a'}`,
    );

    await tx.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: PaymentStatus.PAID,
        settlementStatus: OrderSettlementStatus.SETTLED,
        settledAt: now,
        walletTransactionId: debit.transactionId,
      },
    });
    await this.ensureInvoice(tx, order);

    this.logger.log(
      `DELIVERY CHARGED orderNumber=${order.orderNumber} amountPaise=${amountPaise} ` +
        `walletTransactionId=${debit.transactionId} adminId=${adminId ?? 'unknown'}`,
    );

    return {
      ...base,
      deliveredAt,
      settledAt: now,
      requiredPaise: amountPaise,
      availableBalancePaise,
      balanceAfterPaise: debit.balanceAfterPaise,
      shortfallPaise: 0,
      walletTransactionId: debit.transactionId,
      outcome: 'SETTLED',
      message: 'Order marked delivered and charged to the wallet.',
    };
  }

  /**
   * Returns the order's charge, refusing to bill an order whose stored total
   * disagrees with its own line items and delivery fee.
   */
  private assertConsistentTotal(order: {
    orderNumber: string;
    totalPaise: number;
    deliveryFeePaise: number;
    taxPaise: number;
    items: Array<{ totalPaise: number }>;
  }): number {
    const itemsPaise = order.items.reduce((sum, i) => sum + i.totalPaise, 0);
    const expected = itemsPaise + order.deliveryFeePaise + order.taxPaise;
    if (
      !Number.isInteger(order.totalPaise) ||
      order.totalPaise < 0 ||
      order.totalPaise !== expected
    ) {
      throw new ConflictException({
        error: 'ORDER_TOTAL_MISMATCH',
        message:
          `Order ${order.orderNumber} has a total that does not match its items, ` +
          `so it was not charged. Correct the order before marking it delivered.`,
        totalPaise: order.totalPaise,
        expectedPaise: expected,
      });
    }
    return order.totalPaise;
  }

  /**
   * Issues the invoice for a settled delivery, using the existing numbering.
   * Orders created under the prepaid model already have one and keep it.
   */
  private async ensureInvoice(
    tx: Tx,
    order: {
      id: string;
      invoice: unknown;
      addressSnapshot: unknown;
      subtotalPaise: number;
      discountPaise: number;
      taxPaise: number;
      deliveryFeePaise: number;
      totalPaise: number;
    },
  ): Promise<void> {
    if (order.invoice) return;
    const invoiceNumber = await generateInvoiceNumber(tx);
    await tx.invoice.create({
      data: {
        invoiceNumber,
        orderId: order.id,
        addressSnapshot: order.addressSnapshot as Prisma.InputJsonValue,
        financialSnapshot: {
          subtotalPaise: order.subtotalPaise,
          discountPaise: order.discountPaise,
          taxPaise: order.taxPaise,
          deliveryFeePaise: order.deliveryFeePaise,
          totalPaise: order.totalPaise,
        },
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  QUANTITY CHANGES
  // ══════════════════════════════════════════════════════════════════

  /**
   * The order total a quantity would produce, using the order's own price
   * snapshot: unit price x quantity, plus the order's delivery fee and tax.
   * This is the same arithmetic `PlansService.materializeOrdersForSchedule`
   * uses when it creates the order.
   */
  static priceForQuantity(
    order: { deliveryFeePaise: number; taxPaise: number },
    unitPricePaise: number,
    quantity: number,
  ): { itemTotalPaise: number; totalPaise: number } {
    const itemTotalPaise = unitPricePaise * quantity;
    return {
      itemTotalPaise,
      totalPaise: itemTotalPaise + order.deliveryFeePaise + order.taxPaise,
    };
  }

  /** The earliest delivery date whose order may still be changed at `now`. */
  static earliestChangeableDate(now: Date = new Date()): Date {
    return resolveFirstDeliveryDate(now);
  }

  /**
   * Applies a new quantity to one upcoming delivery's order, inside the
   * caller's transaction.
   *
   * Refuses delivered, cancelled, failed and skipped orders, orders past the
   * order cut-off, and prepaid plans (their deliveries are already paid against
   * fixed snapshots and there is no refund or top-up rule for them). For a
   * per-delivery order, when `checkBalance` is set and the change raises the
   * charge, the wallet must cover the revised charge; the balance is read under
   * a row lock so a concurrent debit cannot be missed.
   */
  async applyOrderQuantityChange(
    tx: Tx,
    orderId: string,
    newQuantity: number,
    opts: { checkBalance: boolean; now?: Date },
  ): Promise<OrderQuantityChangeResult> {
    const now = opts.now ?? new Date();

    await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        planDelivery: true,
        planSelection: { select: { billingModel: true, planType: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const scheduledDate = order.deliveryDate
      ? toIsoDateString(new Date(order.deliveryDate))
      : null;

    if (
      !QUANTITY_EDITABLE_ORDER_STATUSES.includes(order.status as OrderStatus)
    ) {
      throw new BadRequestException(
        `Cannot edit quantity: order ${order.orderNumber} is already ${order.status}`,
      );
    }
    if (order.planDelivery?.status === DeliveryStatus.SKIPPED) {
      throw new BadRequestException(
        `Cannot edit quantity: delivery for order ${order.orderNumber} was SKIPPED`,
      );
    }
    if (order.planDelivery?.status === DeliveryStatus.DELIVERED) {
      throw new BadRequestException(
        `Cannot edit quantity: delivery for order ${order.orderNumber} is already DELIVERED`,
      );
    }
    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new ConflictException({
        error: 'QUANTITY_CHANGE_NOT_SUPPORTED_FOR_PAID_ORDER',
        message:
          `Order ${order.orderNumber} is already paid (a prepaid plan), so its quantity ` +
          `cannot be changed: there is no refund or extra-charge rule for prepaid deliveries.`,
      });
    }
    if (order.planSelection?.billingModel !== PlanBillingModel.PER_DELIVERY) {
      throw new ConflictException({
        error: 'QUANTITY_CHANGE_NOT_SUPPORTED_FOR_PREPAID_PLAN',
        message:
          `Order ${order.orderNumber} belongs to a plan that was paid upfront, so its ` +
          `quantity cannot be changed: there is no refund or extra-charge rule for prepaid deliveries.`,
      });
    }
    if (order.deliveryDate) {
      const earliest = DeliveryBillingService.earliestChangeableDate(now);
      if (new Date(order.deliveryDate).getTime() < earliest.getTime()) {
        throw new BadRequestException(
          `Cannot edit quantity: the order cut-off for the ${scheduledDate} delivery has passed`,
        );
      }
    }

    const item = order.items[0];
    if (!item) {
      throw new BadRequestException(
        `Order ${order.orderNumber} has no line items to update`,
      );
    }

    // Quantity limits are the plan's configured ones, read here so a stale
    // client cannot exceed them.
    if (order.planSelection?.planType) {
      const config = await tx.planConfig.findUnique({
        where: { planType: order.planSelection.planType },
        select: { quantityMin: true, quantityMax: true },
      });
      if (
        config &&
        (newQuantity < config.quantityMin || newQuantity > config.quantityMax)
      ) {
        throw new BadRequestException(
          `Quantity must be between ${config.quantityMin} and ${config.quantityMax} litres`,
        );
      }
    }

    const oldQuantity = item.quantity;
    const oldTotalPaise = order.totalPaise;
    const priced = DeliveryBillingService.priceForQuantity(
      order,
      item.unitPricePaise,
      newQuantity,
    );

    const result: OrderQuantityChangeResult = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.userId,
      scheduledDate,
      oldQuantity,
      newQuantity,
      oldTotalPaise,
      newTotalPaise: priced.totalPaise,
      changed: oldQuantity !== newQuantity,
    };
    if (!result.changed) return result;

    if (opts.checkBalance && priced.totalPaise > oldTotalPaise) {
      const wallets = await tx.$queryRaw<
        Array<{ balancePaise: number }>
      >`SELECT "balancePaise" FROM "wallets" WHERE "userId" = ${order.userId} FOR UPDATE`;
      const currentBalancePaise = wallets[0]?.balancePaise ?? 0;
      if (currentBalancePaise < priced.totalPaise) {
        throw new BadRequestException({
          error: 'INSUFFICIENT_WALLET_BALANCE',
          message:
            `Customer ${order.userId} does not have enough wallet balance for this change. ` +
            `Order ${order.orderNumber} (${scheduledDate}) would cost ${priced.totalPaise} paise ` +
            `at ${newQuantity} L, but the wallet holds ${currentBalancePaise} paise. ` +
            `Add funds to the wallet, then try again.`,
          customerId: order.userId,
          orderId: order.id,
          orderNumber: order.orderNumber,
          scheduledDate,
          currentQuantity: oldQuantity,
          requestedQuantity: newQuantity,
          currentBalancePaise,
          currentAmountPaise: oldTotalPaise,
          requiredPaise: priced.totalPaise,
          shortfallPaise: priced.totalPaise - currentBalancePaise,
        });
      }
    }

    // Keep the stored discount in step when it was derived per litre.
    const perLitreDiscount =
      order.actualPricePerLitrePaise != null
        ? order.actualPricePerLitrePaise - item.unitPricePaise
        : null;
    const discountPaise =
      perLitreDiscount != null &&
      perLitreDiscount > 0 &&
      order.discountPaise === perLitreDiscount * oldQuantity
        ? perLitreDiscount * newQuantity
        : order.discountPaise;

    await tx.orderItem.update({
      where: { id: item.id },
      data: { quantity: newQuantity, totalPaise: priced.itemTotalPaise },
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        subtotalPaise: priced.itemTotalPaise,
        discountPaise,
        totalPaise: priced.totalPaise,
      },
    });
    if (order.planDeliveryId) {
      await tx.planDelivery.updateMany({
        where: { id: order.planDeliveryId, status: DeliveryStatus.SCHEDULED },
        data: { quantityLitres: newQuantity },
      });
    }

    return result;
  }
}
