import { generateOrderNumber, generateInvoiceNumber } from "./order-number.util";
import { ORDER_NUMBER_PREFIX, INVOICE_NUMBER_PREFIX } from "./orders.constants";

describe("order/invoice number generation", () => {
  it("uses the Postgres sequence when the client can serve one", async () => {
    const client = {
      $queryRaw: jest.fn().mockResolvedValue([{ nextval: 10042n }]),
      order: { count: jest.fn() },
    };

    await expect(generateOrderNumber(client as any)).resolves.toBe(
      `${ORDER_NUMBER_PREFIX}10042`,
    );
    // The collision-prone count() scheme must not be consulted at all.
    expect(client.order.count).not.toHaveBeenCalled();
  });

  it("renders a large sequence value without precision loss", async () => {
    const client = {
      $queryRaw: jest.fn().mockResolvedValue([
        { nextval: 9007199254740993n },
      ]),
    };
    await expect(generateInvoiceNumber(client as any)).resolves.toBe(
      `${INVOICE_NUMBER_PREFIX}9007199254740993`,
    );
  });

  // The whole point of the sequences is that a failure is loud. These helpers
  // run inside an interactive transaction, and Postgres aborts the entire
  // transaction on the first failed statement — so swallowing a missing
  // sequence (an unapplied migration) buried the real cause under an
  // unrelated "current transaction is aborted" from a later query, and fell
  // back to the very scheme the sequences replaced.
  it("propagates a sequence failure instead of silently falling back", async () => {
    const client = {
      $queryRaw: jest
        .fn()
        .mockRejectedValue(
          new Error('relation "order_number_seq" does not exist'),
        ),
      order: { count: jest.fn().mockResolvedValue(5) },
    };

    await expect(generateOrderNumber(client as any)).rejects.toThrow(
      /order_number_seq/,
    );
    expect(client.order.count).not.toHaveBeenCalled();
  });

  it("propagates an invoice sequence failure too", async () => {
    const client = {
      $queryRaw: jest.fn().mockRejectedValue(new Error("boom")),
      invoice: { count: jest.fn().mockResolvedValue(5) },
    };

    await expect(generateInvoiceNumber(client as any)).rejects.toThrow("boom");
    expect(client.invoice.count).not.toHaveBeenCalled();
  });

  // Test doubles that predate the sequences keep working.
  it("falls back to count() for a client with no raw-query support", async () => {
    const client = { order: { count: jest.fn().mockResolvedValue(7) } };
    await expect(generateOrderNumber(client as any)).resolves.toBe(
      `${ORDER_NUMBER_PREFIX}10008`,
    );
  });

  it("falls back to count() when the sequence query returns no rows", async () => {
    const client = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      invoice: { count: jest.fn().mockResolvedValue(2) },
    };
    await expect(generateInvoiceNumber(client as any)).resolves.toBe(
      `${INVOICE_NUMBER_PREFIX}10003`,
    );
  });
});
