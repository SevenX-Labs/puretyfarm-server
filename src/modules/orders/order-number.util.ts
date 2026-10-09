import { Prisma } from "@prisma/client";
import { ORDER_NUMBER_PREFIX, INVOICE_NUMBER_PREFIX } from "./orders.constants";

/**
 * Postgres sequences backing the globally-unique, human-readable order and
 * invoice numbers.
 *
 * These REPLACE the previous `count()`-based scheme (`PF${10001 + count}`),
 * which was not collision-safe: any deleted row left `count` below the highest
 * existing suffix, and two concurrent inserts read the same `count`, so the
 * next generated number duplicated an existing one and hit the `@unique`
 * constraint — surfacing as an uncaught Prisma P2002 / HTTP 500.
 *
 * Sequences are non-transactional (nextval never rolls back), so numbers are
 * always unique and monotonic; a rolled-back insert simply leaves a gap, which
 * is expected and acceptable for a display number.
 */
export const ORDER_NUMBER_SEQUENCE = "order_number_seq";
export const INVOICE_NUMBER_SEQUENCE = "invoice_number_seq";

/** Any Prisma client or interactive-transaction client that runs raw SQL. */
interface RawQueryClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

export async function generateOrderNumber(
  client: RawQueryClient,
): Promise<string> {
  const rows = await client.$queryRaw<Array<{ nextval: bigint }>>(
    Prisma.sql`SELECT nextval('order_number_seq') AS nextval`,
  );
  return `${ORDER_NUMBER_PREFIX}${rows[0].nextval.toString()}`;
}

export async function generateInvoiceNumber(
  client: RawQueryClient,
): Promise<string> {
  const rows = await client.$queryRaw<Array<{ nextval: bigint }>>(
    Prisma.sql`SELECT nextval('invoice_number_seq') AS nextval`,
  );
  return `${INVOICE_NUMBER_PREFIX}${rows[0].nextval.toString()}`;
}
