export enum OrderStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  PROCESSING = "PROCESSING",
  OUT_FOR_DELIVERY = "OUT_FOR_DELIVERY",
  DELIVERED = "DELIVERED",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
  FAILED = "FAILED",
}

export enum PaymentStatus {
  PENDING = "PENDING",
  PAID = "PAID",
  FAILED = "FAILED",
  REFUNDED = "REFUNDED",
  PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED",
}

/** Valid admin-initiated status transitions. */
export const ALLOWED_STATUS_TRANSITIONS: Record<string, string[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED, OrderStatus.FAILED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CANCELLED, OrderStatus.FAILED],
  [OrderStatus.OUT_FOR_DELIVERY]: [OrderStatus.DELIVERED, OrderStatus.FAILED],
  [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.FAILED]: [],
};

/**
 * Statuses an order may be completed from.
 *
 * Only DELIVERED: completion closes an order whose goods have already
 * arrived, so it must never be the step that *claims* a delivery happened.
 * Everything earlier in the lifecycle has to walk the normal status flow
 * (and, for plan orders, have its delivery actually fall due) first.
 */
export const COMPLETION_ELIGIBLE_STATUSES = [OrderStatus.DELIVERED];

/**
 * Order statuses that allow reorder. COMPLETED is included because it is
 * DELIVERED plus an administrative close: a customer who could reorder the
 * day before completion must still be able to the day after.
 */
export const REORDER_ELIGIBLE_STATUSES = [
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
];

/** Order number prefix. */
export const ORDER_NUMBER_PREFIX = "PF";

/** Invoice number prefix. */
export const INVOICE_NUMBER_PREFIX = "INV-";
