// Unit tests for the single delivery-billing path.
//
// These run against an in-memory fake of the Prisma client and a fake wallet
// that enforces the two ledger rules the real one has: the balance can never go
// negative, and (type, referenceType, referenceId) is unique. They prove the
// service's decisions. They do NOT prove database-level concurrency safety —
// row locks and the unique index only exist in a real PostgreSQL.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

// The real WalletService pulls in configuration modules these tests do not
// need; the wallet is replaced by an in-memory fake below.
jest.mock('../wallet/wallet.service', () => ({ WalletService: class {} }));

import { DeliveryBillingService } from './delivery-billing.service';
import { toIstDateOnly, addDays } from '../../common/utils/ist-date.util';

const USER = 'user-1';
const ADMIN = 'admin-1';
const UNIT = 7500; // paise per litre

function dateOnly(offsetDays: number): Date {
  return addDays(toIstDateOnly(new Date()), offsetDays);
}

function makeOrder(overrides: Record<string, any> = {}) {
  const quantity = overrides.quantity ?? 1;
  return {
    id: 'order-1',
    orderNumber: 'PF10001',
    userId: USER,
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    settlementStatus: 'PENDING',
    planSelectionId: 'sel-1',
    planDeliveryId: 'del-1',
    deliveryDate: dateOnly(0),
    deliveredAt: null,
    settledAt: null,
    walletTransactionId: null,
    subtotalPaise: UNIT * quantity,
    discountPaise: 0,
    taxPaise: 0,
    deliveryFeePaise: 0,
    totalPaise: UNIT * quantity,
    actualPricePerLitrePaise: null,
    addressSnapshot: { city: 'X' },
    items: [
      {
        id: 'item-1',
        quantity,
        unitPricePaise: UNIT,
        totalPaise: UNIT * quantity,
      },
    ],
    invoice: null,
    planDelivery: {
      id: 'del-1',
      status: 'SCHEDULED',
      quantityLitres: quantity,
    },
    planSelection: { billingModel: 'PER_DELIVERY', planType: 'MONTHLY' },
    ...overrides,
  };
}

/** Builds the service over a tiny in-memory world. */
function setup(order: any, balancePaise: number | null) {
  const world = {
    order,
    wallet: balancePaise === null ? null : { id: 'w-1', balancePaise },
    ledger: [] as Array<{
      id: string;
      key: string;
      amountPaise: number;
      description: string;
    }>,
    invoices: [] as any[],
    planConfig: { quantityMin: 1, quantityMax: 5 } as any,
  };

  const tx: any = {
    // Called both as a tagged template and with a prebuilt Prisma.sql object.
    $queryRaw: jest.fn(async (query: any) => {
      const sql: string = Array.isArray(query)
        ? query.join('?')
        : String(query?.sql ?? (query?.strings ?? []).join('?'));
      if (sql.includes('"wallets"')) {
        return world.wallet
          ? [{ id: world.wallet.id, balancePaise: world.wallet.balancePaise }]
          : [];
      }
      if (sql.includes('nextval')) return [{ nextval: BigInt(1) }];
      return [];
    }),
    order: {
      findUnique: jest.fn(async () =>
        world.order ? { ...world.order } : null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const allowed: string[] | undefined = where.status?.in;
        if (allowed && !allowed.includes(world.order.status))
          return { count: 0 };
        Object.assign(world.order, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) =>
        Object.assign(world.order, data),
      ),
    },
    orderItem: {
      update: jest.fn(async ({ data }: any) =>
        Object.assign(world.order.items[0], data),
      ),
    },
    planDelivery: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.status && world.order.planDelivery.status !== where.status) {
          return { count: 0 };
        }
        Object.assign(world.order.planDelivery, data);
        return { count: 1 };
      }),
    },
    planConfig: { findUnique: jest.fn(async () => world.planConfig) },
    invoice: {
      create: jest.fn(async ({ data }: any) => {
        world.invoices.push(data);
        world.order.invoice = data;
        return data;
      }),
    },
  };

  const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };

  const wallet: any = {
    debitWalletWithin: jest.fn(
      async (
        _tx: any,
        _userId: string,
        amountPaise: number,
        refType: string,
        refId: string,
        description: string,
      ) => {
        const key = `DEBIT:${refType}:${refId}`;
        if (world.ledger.some((l) => l.key === key)) {
          throw new Error('unique violation: ledger row already exists');
        }
        if (!world.wallet || world.wallet.balancePaise < amountPaise) {
          throw new BadRequestException('Insufficient wallet balance');
        }
        world.wallet.balancePaise -= amountPaise;
        const id = `txn-${world.ledger.length + 1}`;
        world.ledger.push({ id, key, amountPaise, description });
        return {
          success: true,
          walletId: 'w-1',
          balanceAfterPaise: world.wallet.balancePaise,
          transactionId: id,
        };
      },
    ),
  };

  return {
    service: new DeliveryBillingService(prisma, wallet),
    world,
    tx,
    wallet,
  };
}

describe('DeliveryBillingService.settleDelivery', () => {
  it('charges one delivery exactly once and records the delivery time separately from the scheduled date', async () => {
    // Scheduled yesterday, confirmed late: today.
    const scheduled = dateOnly(-1);
    const { service, world } = setup(
      makeOrder({ deliveryDate: scheduled }),
      200000,
    );
    const now = new Date();

    const result = await service.settleDelivery('order-1', ADMIN, now);

    expect(result.outcome).toBe('SETTLED');
    expect(result.requiredPaise).toBe(7500);
    expect(result.availableBalancePaise).toBe(200000);
    expect(result.balanceAfterPaise).toBe(192500);
    expect(world.wallet!.balancePaise).toBe(192500);

    expect(world.ledger).toHaveLength(1);
    expect(world.ledger[0].key).toBe('DEBIT:ORDER:order-1');
    expect(world.ledger[0].description).toBe(
      `Delivery charge — Order #PF10001 — Scheduled: ${scheduled.toISOString().slice(0, 10)}`,
    );

    expect(world.order.status).toBe('DELIVERED');
    expect(world.order.paymentStatus).toBe('PAID');
    expect(world.order.settlementStatus).toBe('SETTLED');
    expect(world.order.walletTransactionId).toBe('txn-1');
    // deliveredAt is the confirmation instant; the scheduled date is untouched.
    expect(world.order.deliveredAt).toBe(now);
    expect(world.order.settledAt).toBe(now);
    expect(world.order.deliveryDate).toBe(scheduled);
    expect(world.order.planDelivery.status).toBe('DELIVERED');
    expect(world.order.planDelivery.deliveredAt).toBe(now);
    // The invoice is issued at settlement, for the settled amount.
    expect(world.invoices).toHaveLength(1);
    expect(world.invoices[0].financialSnapshot.totalPaise).toBe(7500);
  });

  it('follows the worked example: ₹2,000 funded, ₹75 per delivered day, nothing for an unmarked day', async () => {
    const day1 = makeOrder({
      id: 'o1',
      orderNumber: 'PF1',
      deliveryDate: dateOnly(-1),
    });
    const first = setup(day1, 200000);
    await first.service.settleDelivery('o1', ADMIN);
    expect(first.world.wallet!.balancePaise).toBe(192500);

    // Day 2 exists but is not marked delivered: no debit just for existing.
    const day2 = makeOrder({
      id: 'o2',
      orderNumber: 'PF2',
      deliveryDate: dateOnly(0),
    });
    const second = setup(day2, 192500);
    expect(second.world.ledger).toHaveLength(0);
    expect(second.world.wallet!.balancePaise).toBe(192500);

    await second.service.settleDelivery('o2', ADMIN);
    expect(second.world.wallet!.balancePaise).toBe(185000);
  });

  it('does not debit again when the same order is marked delivered twice', async () => {
    const { service, world } = setup(makeOrder(), 200000);

    await service.settleDelivery('order-1', ADMIN);
    const again = await service.settleDelivery('order-1', ADMIN);

    expect(again.outcome).toBe('ALREADY_DELIVERED');
    expect(world.ledger).toHaveLength(1);
    expect(world.wallet!.balancePaise).toBe(192500);
  });

  it('records the delivery but leaves the charge outstanding when the wallet is short', async () => {
    const { service, world, wallet } = setup(makeOrder(), 5000);

    const result = await service.settleDelivery('order-1', ADMIN);

    expect(result.outcome).toBe('INSUFFICIENT_BALANCE');
    expect(result.customerId).toBe(USER);
    expect(result.orderNumber).toBe('PF10001');
    expect(result.requiredPaise).toBe(7500);
    expect(result.availableBalancePaise).toBe(5000);
    expect(result.shortfallPaise).toBe(2500);

    // Delivered, but never falsely paid, and the balance is untouched.
    expect(world.order.status).toBe('DELIVERED');
    expect(world.order.deliveredAt).not.toBeNull();
    expect(world.order.paymentStatus).toBe('PENDING');
    expect(world.order.settlementStatus).toBe('OUTSTANDING');
    expect(world.order.settledAt).toBeNull();
    expect(world.wallet!.balancePaise).toBe(5000);
    expect(wallet.debitWalletWithin).not.toHaveBeenCalled();
    expect(world.ledger).toHaveLength(0);
    expect(world.invoices).toHaveLength(0);
  });

  it('treats a customer with no wallet as a zero balance', async () => {
    const { service, world } = setup(makeOrder(), null);
    const result = await service.settleDelivery('order-1', ADMIN);
    expect(result.outcome).toBe('INSUFFICIENT_BALANCE');
    expect(result.availableBalancePaise).toBe(0);
    expect(result.shortfallPaise).toBe(7500);
    expect(world.order.settlementStatus).toBe('OUTSTANDING');
  });

  it('settles an outstanding charge once funds arrive, keeping the original delivery time', async () => {
    const { service, world } = setup(makeOrder(), 0);
    const deliveredAt = new Date('2026-10-12T05:00:00.000Z');
    await service.settleDelivery('order-1', ADMIN, deliveredAt);
    expect(world.order.settlementStatus).toBe('OUTSTANDING');

    world.wallet!.balancePaise = 10000; // admin credit / customer top-up
    const settledAt = new Date('2026-10-13T09:00:00.000Z');
    const retry = await service.settleDelivery('order-1', ADMIN, settledAt);

    expect(retry.outcome).toBe('SETTLED');
    expect(world.ledger).toHaveLength(1);
    expect(world.wallet!.balancePaise).toBe(2500);
    expect(world.order.deliveredAt).toBe(deliveredAt);
    expect(world.order.settledAt).toBe(settledAt);

    // And a further retry cannot charge it a second time.
    const third = await service.settleDelivery('order-1', ADMIN);
    expect(third.outcome).toBe('ALREADY_DELIVERED');
    expect(world.ledger).toHaveLength(1);
  });

  it.each([
    ['CANCELLED', {}],
    ['FAILED', {}],
    ['PENDING', {}],
  ])('never delivers or charges a %s order', async (status) => {
    const { service, world } = setup(makeOrder({ status }), 200000);
    const result = await service.settleDelivery('order-1', ADMIN);
    expect(result.outcome).toBe('NOT_ELIGIBLE');
    expect(world.order.status).toBe(status);
    expect(world.ledger).toHaveLength(0);
    expect(world.wallet!.balancePaise).toBe(200000);
  });

  it('never delivers or charges an order whose delivery was skipped', async () => {
    const order = makeOrder({
      planDelivery: { id: 'del-1', status: 'SKIPPED', quantityLitres: 1 },
    });
    const { service, world } = setup(order, 200000);
    const result = await service.settleDelivery('order-1', ADMIN);
    expect(result.outcome).toBe('NOT_ELIGIBLE');
    expect(world.order.status).toBe('CONFIRMED');
    expect(world.ledger).toHaveLength(0);
  });

  it('refuses to charge a delivery scheduled for a future date', async () => {
    const { service, world } = setup(
      makeOrder({ deliveryDate: dateOnly(2) }),
      200000,
    );
    const result = await service.settleDelivery('order-1', ADMIN);
    expect(result.outcome).toBe('NOT_ELIGIBLE');
    expect(world.order.status).toBe('CONFIRMED');
    expect(world.ledger).toHaveLength(0);
  });

  it('marks a prepaid (legacy) plan order delivered without any debit', async () => {
    const order = makeOrder({
      paymentStatus: 'PAID',
      settlementStatus: null,
      planSelection: { billingModel: 'PREPAID_LEGACY', planType: 'MONTHLY' },
      invoice: { invoiceNumber: 'INV-1' },
    });
    const { service, world, wallet } = setup(order, 200000);

    const result = await service.settleDelivery('order-1', ADMIN);

    expect(result.outcome).toBe('DELIVERED_PREPAID');
    expect(world.order.status).toBe('DELIVERED');
    expect(world.order.deliveredAt).not.toBeNull();
    expect(world.order.settlementStatus).toBeNull();
    expect(wallet.debitWalletWithin).not.toHaveBeenCalled();
    expect(world.wallet!.balancePaise).toBe(200000);
    expect(world.invoices).toHaveLength(0);
  });

  it('does not debit a per-delivery order that is somehow already paid', async () => {
    const { service, world, wallet } = setup(
      makeOrder({ paymentStatus: 'PAID' }),
      200000,
    );
    const result = await service.settleDelivery('order-1', ADMIN);
    expect(result.outcome).toBe('SETTLED');
    expect(wallet.debitWalletWithin).not.toHaveBeenCalled();
    expect(world.wallet!.balancePaise).toBe(200000);
  });

  it('settles a zero-amount delivery without writing a ledger row', async () => {
    const order = makeOrder({
      subtotalPaise: 0,
      totalPaise: 0,
      items: [{ id: 'item-1', quantity: 1, unitPricePaise: 0, totalPaise: 0 }],
    });
    const { service, world, wallet } = setup(order, 0);
    const result = await service.settleDelivery('order-1', ADMIN);
    expect(result.outcome).toBe('SETTLED');
    expect(world.order.settlementStatus).toBe('SETTLED');
    expect(wallet.debitWalletWithin).not.toHaveBeenCalled();
  });

  it('refuses to charge an order whose total disagrees with its items', async () => {
    const { service, world } = setup(makeOrder({ totalPaise: 1 }), 200000);
    await expect(service.settleDelivery('order-1', ADMIN)).rejects.toThrow(
      ConflictException,
    );
    expect(world.ledger).toHaveLength(0);
  });

  it('charges the final approved quantity', async () => {
    const { service, world } = setup(makeOrder({ quantity: 2 }), 200000);
    const result = await service.settleDelivery('order-1', ADMIN);
    expect(result.requiredPaise).toBe(15000);
    expect(world.wallet!.balancePaise).toBe(185000);
  });

  it('throws NotFound for an unknown order', async () => {
    const { service, world } = setup(makeOrder(), 200000);
    world.order = null;
    await expect(service.settleDelivery('missing', ADMIN)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('DeliveryBillingService.applyOrderQuantityChange', () => {
  const future = () => makeOrder({ deliveryDate: dateOnly(3) });

  it('reprices an increase from the order snapshot when the wallet covers it', async () => {
    const { service, world, tx } = setup(future(), 20000);
    const result = await service.applyOrderQuantityChange(tx, 'order-1', 2, {
      checkBalance: true,
    });
    expect(result).toMatchObject({
      oldQuantity: 1,
      newQuantity: 2,
      oldTotalPaise: 7500,
      newTotalPaise: 15000,
      changed: true,
    });
    expect(world.order.items[0]).toMatchObject({
      quantity: 2,
      totalPaise: 15000,
    });
    expect(world.order.totalPaise).toBe(15000);
    expect(world.order.planDelivery.quantityLitres).toBe(2);
    // A quantity change never moves money by itself.
    expect(world.wallet!.balancePaise).toBe(20000);
    expect(world.ledger).toHaveLength(0);
  });

  it('refuses an increase the wallet cannot cover, with the figures the admin needs', async () => {
    const { service, world, tx } = setup(future(), 10000);
    await expect(
      service.applyOrderQuantityChange(tx, 'order-1', 2, {
        checkBalance: true,
      }),
    ).rejects.toMatchObject({
      response: {
        error: 'INSUFFICIENT_WALLET_BALANCE',
        customerId: USER,
        orderNumber: 'PF10001',
        currentQuantity: 1,
        requestedQuantity: 2,
        currentBalancePaise: 10000,
        requiredPaise: 15000,
        shortfallPaise: 5000,
      },
    });
    expect(world.order.items[0].quantity).toBe(1);
    expect(world.order.totalPaise).toBe(7500);
  });

  it('allows a decrease even when the wallet is low', async () => {
    const { service, world, tx } = setup(
      makeOrder({ deliveryDate: dateOnly(3), quantity: 2 }),
      0,
    );
    const result = await service.applyOrderQuantityChange(tx, 'order-1', 1, {
      checkBalance: true,
    });
    expect(result.newTotalPaise).toBe(7500);
    expect(world.order.totalPaise).toBe(7500);
  });

  it.each([
    'DELIVERED',
    'COMPLETED',
    'CANCELLED',
    'FAILED',
    'OUT_FOR_DELIVERY',
  ])('refuses to change a %s order', async (status) => {
    const { service, world, tx } = setup(
      makeOrder({ deliveryDate: dateOnly(3), status }),
      200000,
    );
    await expect(
      service.applyOrderQuantityChange(tx, 'order-1', 2, {
        checkBalance: true,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(world.order.items[0].quantity).toBe(1);
  });

  it('refuses to change a skipped delivery', async () => {
    const order = makeOrder({
      deliveryDate: dateOnly(3),
      planDelivery: { id: 'del-1', status: 'SKIPPED', quantityLitres: 1 },
    });
    const { service, tx } = setup(order, 200000);
    await expect(
      service.applyOrderQuantityChange(tx, 'order-1', 2, {
        checkBalance: true,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses to change a prepaid plan order', async () => {
    const order = makeOrder({
      deliveryDate: dateOnly(3),
      paymentStatus: 'PAID',
      planSelection: { billingModel: 'PREPAID_LEGACY', planType: 'MONTHLY' },
    });
    const { service, world, tx } = setup(order, 200000);
    await expect(
      service.applyOrderQuantityChange(tx, 'order-1', 2, {
        checkBalance: true,
      }),
    ).rejects.toThrow(ConflictException);
    expect(world.order.totalPaise).toBe(7500);
  });

  it('refuses a delivery whose order cut-off has passed', async () => {
    const { service, tx } = setup(
      makeOrder({ deliveryDate: dateOnly(0) }),
      200000,
    );
    await expect(
      service.applyOrderQuantityChange(tx, 'order-1', 2, {
        checkBalance: true,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('enforces the configured quantity limits', async () => {
    const { service, tx } = setup(future(), 9999999);
    await expect(
      service.applyOrderQuantityChange(tx, 'order-1', 6, {
        checkBalance: true,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('is a no-op when the quantity is unchanged', async () => {
    const { service, tx } = setup(future(), 0);
    const result = await service.applyOrderQuantityChange(tx, 'order-1', 1, {
      checkBalance: true,
    });
    expect(result.changed).toBe(false);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });
});
