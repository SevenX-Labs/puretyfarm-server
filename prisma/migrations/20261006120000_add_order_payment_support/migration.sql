-- At most ONE live Payment per Order, mirroring the existing
-- `payments_one_live_payment_per_credit_request` guarantee.
--
-- "Live" means a payment that is either in flight or already resolved as the
-- source of truth for this order's online money: PENDING / PROCESSING / SUCCESS
-- / REFUND_PENDING / REFUNDED. FAILED, CANCELLED and EXPIRED rows do not count,
-- so a customer can retry after a failed online attempt — the second row is
-- allowed because the first is terminal-failed.
--
-- This index is the DB-level guarantee that two concurrent
-- `POST /customer/orders/:id/pay` requests with paymentMethod=ONLINE cannot
-- both create a live Payment row for the same order. The one that loses the
-- race hits this unique index and the handler returns the winning row.
--
-- Does NOT alter the existing credit-request index or the wallet top-up retry
-- behaviour — this is purely additive.
CREATE UNIQUE INDEX "payments_one_live_payment_per_order"
  ON "payments" ("orderId")
  WHERE "orderId" IS NOT NULL
    AND "status" IN ('PENDING', 'PROCESSING', 'SUCCESS', 'REFUND_PENDING', 'REFUNDED');
