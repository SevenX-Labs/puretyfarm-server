-- Replace the count()-based order/invoice number generation with Postgres
-- sequences. The old scheme (`PF${10001 + count}`) collided with the @unique
-- constraint whenever a row had been deleted or two inserts raced, surfacing
-- as an uncaught P2002 / HTTP 500 (e.g. when confirming a cash collection for
-- a plan payment, which materialises orders).
--
-- Each sequence is seeded to the highest existing numeric suffix so the next
-- nextval() continues the series without colliding with existing rows. When a
-- table is empty the suffix floor is 10000, so the first value is 10001 —
-- matching the previous starting point.

CREATE SEQUENCE IF NOT EXISTS "order_number_seq";
CREATE SEQUENCE IF NOT EXISTS "invoice_number_seq";

SELECT setval(
  'order_number_seq',
  GREATEST(
    10000,
    COALESCE(
      (SELECT MAX(CAST(SUBSTRING("orderNumber" FROM '[0-9]+$') AS BIGINT))
       FROM "orders"
       WHERE "orderNumber" ~ '[0-9]+$'),
      10000
    )
  ),
  true
);

SELECT setval(
  'invoice_number_seq',
  GREATEST(
    10000,
    COALESCE(
      (SELECT MAX(CAST(SUBSTRING("invoiceNumber" FROM '[0-9]+$') AS BIGINT))
       FROM "invoices"
       WHERE "invoiceNumber" ~ '[0-9]+$'),
      10000
    )
  ),
  true
);
