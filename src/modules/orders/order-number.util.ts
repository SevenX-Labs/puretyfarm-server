import { Prisma } from '@prisma/client';
import { ORDER_NUMBER_PREFIX, INVOICE_NUMBER_PREFIX } from './orders.constants';

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
export const ORDER_NUMBER_SEQUENCE = 'order_number_seq';
export const INVOICE_NUMBER_SEQUENCE = 'invoice_number_seq';

/** Any Prisma client or interactive-transaction client that runs raw SQL. */
interface RawQueryClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

/**
 * Reads the next value of a number sequence, or `null` when the client cannot
 * serve one (a test double without `$queryRaw`, or one that returns no rows).
 *
 * A genuine query failure is deliberately NOT swallowed. These helpers run
 * inside an interactive transaction, and Postgres aborts the whole transaction
 * on the first failed statement: every later statement then fails with
 * `25P02 current transaction is aborted`. Hiding the sequence error therefore
 * replaced a precise cause ("sequence does not exist" — an unapplied
 * migration) with an opaque cascade from an unrelated query, and silently fell
 * back to the collision-prone `count()` scheme the sequences exist to replace.
 */
async function nextSequenceValue(
  client: RawQueryClient,
  query: Prisma.Sql,
): Promise<string | null> {
  if (typeof client?.$queryRaw !== 'function') {
    return null;
  }
  const rows = await client.$queryRaw<Array<{ nextval: bigint }>>(query);
  const next = rows?.[0]?.nextval;
  return next == null ? null : next.toString();
}

export async function generateOrderNumber(
  client: RawQueryClient,
): Promise<string> {
  const next = await nextSequenceValue(
    client,
    Prisma.sql`SELECT nextval('order_number_seq') AS nextval`,
  );
  if (next !== null) {
    return `${ORDER_NUMBER_PREFIX}${next}`;
  }
  const count =
    typeof (client as any)?.order?.count === 'function'
      ? await (client as any).order.count()
      : 0;
  return `${ORDER_NUMBER_PREFIX}${10001 + count}`;
}

export async function generateInvoiceNumber(
  client: RawQueryClient,
): Promise<string> {
  const next = await nextSequenceValue(
    client,
    Prisma.sql`SELECT nextval('invoice_number_seq') AS nextval`,
  );
  if (next !== null) {
    return `${INVOICE_NUMBER_PREFIX}${next}`;
  }
  const count =
    typeof (client as any)?.invoice?.count === 'function'
      ? await (client as any).invoice.count()
      : 0;
  return `${INVOICE_NUMBER_PREFIX}${10001 + count}`;
}
