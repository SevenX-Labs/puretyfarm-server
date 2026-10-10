jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PlansService } from './plans.service';
import { PaymentsService } from '../payments/payments.service';
import { WalletService } from '../wallet/wallet.service';
import {
  WalletTransactionType,
  WalletTransactionReferenceType,
} from '../wallet/wallet.constants';
import { CashCollectionStatus, PaymentMethod } from '@prisma/client';
import {
  PlanType,
  PlanQuoteStatus,
  PlanSelectionStatus,
  QuantityMode,
  DeliveryStatus,
} from './plans.constants';

type Row = Record<string, any>;

describe('Cash Plan Confirmation -> Wallet Routing Integration', () => {
  const USER_ID = 'user-100';
  const WALLET_ID = 'wallet-100';
  const ADMIN_ID = 'admin-1';

  let db: {
    wallets: Row[];
    transactions: Row[];
    planQuotes: Row[];
    planSelections: Row[];
    cashCollections: Row[];
    planDeliveries: Row[];
    planConfigs: Row[];
    orders: Row[];
    orderItems: Row[];
    invoices: Row[];
    customerAddresses: Row[];
  };

  // Known Trial configuration. The materialised orders MUST be priced from this
  // (₹95/L selling), never the removed ₹80/L fallback, and typed SEVEN_DAY_TRIAL.
  const TRIAL_SELLING_PAISE = 9500;
  const TRIAL_ACTUAL_PAISE = 11000;

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([field, condition]) => {
      if (condition && typeof condition === 'object' && 'in' in condition) {
        return (condition.in as unknown[]).includes(row[field]);
      }
      return row[field] === condition;
    });

  let prisma: any;
  let walletService: WalletService;
  let plansService: PlansService;
  let paymentsService: PaymentsService;

  beforeEach(() => {
    db = {
      wallets: [],
      transactions: [],
      planQuotes: [],
      planSelections: [],
      cashCollections: [],
      planDeliveries: [],
      planConfigs: [
        {
          id: 'cfg-trial',
          planType: PlanType.SEVEN_DAY_TRIAL,
          isActive: true,
          actualPricePerLitre: TRIAL_ACTUAL_PAISE,
          sellingPricePerLitre: TRIAL_SELLING_PAISE,
          deliveryFeePaise: 0,
          deliveryStartTime: '05:00',
          deliveryEndTime: '07:00',
        },
      ],
      orders: [],
      orderItems: [],
      invoices: [],
      customerAddresses: [],
    };

    prisma = {
      wallet: {
        upsert: async ({ where, create }: any) => {
          let row = db.wallets.find((w) => w.userId === where.userId);
          if (!row) {
            row = {
              id: WALLET_ID,
              userId: create.userId,
              balancePaise: 0,
              autoCreditEnabled: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            db.wallets.push(row);
          }
          return { ...row };
        },
        findUnique: async ({ where }: any) => {
          const row = db.wallets.find(
            (w) =>
              (where.userId !== undefined && w.userId === where.userId) ||
              (where.id !== undefined && w.id === where.id),
          );
          return row ? { ...row } : null;
        },
        updateMany: async ({ where, data }: any) => {
          const hits = db.wallets.filter((w) => matches(w, where));
          hits.forEach((w) =>
            Object.assign(w, data, { updatedAt: new Date() }),
          );
          return { count: hits.length };
        },
      },
      walletTransaction: {
        create: async ({ data }: any) => {
          if (
            db.transactions.some(
              (t) =>
                t.type === data.type &&
                t.referenceType === data.referenceType &&
                t.referenceId === data.referenceId,
            )
          ) {
            throw new Error('unique violation: type_referenceType_referenceId');
          }
          const row = { id: randomUUID(), createdAt: new Date(), ...data };
          db.transactions.push(row);
          return { ...row };
        },
        findMany: async ({ where, orderBy }: any) => {
          let list = db.transactions.filter((t) => matches(t, where));
          if (orderBy?.createdAt === 'desc') {
            list = [...list].reverse();
          }
          return list;
        },
        count: async ({ where }: any) => {
          return db.transactions.filter((t) => matches(t, where)).length;
        },
      },
      planSelection: {
        findUnique: async ({ where, include }: any) => {
          const row = db.planSelections.find((s) => s.id === where.id);
          if (!row) return null;
          if (include?.quote) {
            const quote = db.planQuotes.find((q) => q.id === row.quoteId);
            return { ...row, quote };
          }
          return { ...row };
        },
        update: async ({ where, data }: any) => {
          const row = db.planSelections.find((s) => s.id === where.id);
          if (!row) throw new Error('Plan selection not found');
          Object.assign(row, data, { updatedAt: new Date() });
          return { ...row };
        },
      },
      planQuote: {
        updateMany: async ({ where, data }: any) => {
          const hits = db.planQuotes.filter((q) => matches(q, where));
          hits.forEach((q) =>
            Object.assign(q, data, { updatedAt: new Date() }),
          );
          return { count: hits.length };
        },
      },
      planDelivery: {
        createMany: async ({ data }: any) => {
          (data || []).forEach((d: any) => {
            db.planDeliveries.push({ id: randomUUID(), ...d });
          });
          return { count: data.length };
        },
        findMany: async ({ where, orderBy }: any) => {
          let list = db.planDeliveries.filter((d) => matches(d, where));
          if (orderBy?.deliveryDate === 'asc') {
            list = [...list].sort(
              (a, b) =>
                new Date(a.deliveryDate).getTime() -
                new Date(b.deliveryDate).getTime(),
            );
          }
          return list.map((d) => ({ ...d }));
        },
      },
      planConfig: {
        findUnique: async ({ where }: any) => {
          const row = db.planConfigs.find((c) => c.planType === where.planType);
          return row ? { ...row } : null;
        },
      },
      customerAddress: {
        findFirst: async ({ where }: any) => {
          const row = db.customerAddresses.find((a) => matches(a, where));
          return row ? { ...row } : null;
        },
      },
      invoice: {
        count: async () => db.invoices.length,
      },
      order: {
        findUnique: async ({ where }: any) => {
          const row = db.orders.find(
            (o) => o.planDeliveryId === where.planDeliveryId,
          );
          return row ? { ...row } : null;
        },
        count: async () => db.orders.length,
        create: async ({ data }: any) => {
          const { items, invoice, ...orderData } = data;
          const orderId = randomUUID();
          const order = { id: orderId, ...orderData };
          db.orders.push(order);
          if (items?.create) {
            db.orderItems.push({
              id: randomUUID(),
              orderId,
              ...items.create,
            });
          }
          if (invoice?.create) {
            db.invoices.push({
              id: randomUUID(),
              orderId,
              ...invoice.create,
            });
          }
          return { ...order };
        },
      },
      cashCollection: {
        findUnique: async ({ where }: any) => {
          const row = db.cashCollections.find((c) => c.id === where.id);
          return row ? { ...row } : null;
        },
        findUniqueOrThrow: async ({ where }: any) => {
          const row = db.cashCollections.find((c) => c.id === where.id);
          if (!row) throw new Error('Cash collection not found');
          return { ...row };
        },
        findFirst: async ({ where }: any) => {
          const row = db.cashCollections.find((c) => matches(c, where));
          return row ? { ...row } : null;
        },
        updateMany: async ({ where, data }: any) => {
          const hits = db.cashCollections.filter((c) => matches(c, where));
          hits.forEach((c) =>
            Object.assign(c, data, { updatedAt: new Date() }),
          );
          return { count: hits.length };
        },
      },
      $executeRaw: async () => 1,
      $queryRaw: async (strings: any, ...values: any[]) => {
        const sql = Array.isArray(strings)
          ? strings.join('?')
          : String(strings);

        if (sql.includes('FOR UPDATE')) {
          return [{ ok: 1 }];
        }

        if (sql.includes('UPDATE "wallets"')) {
          const [delta, walletId] = values;
          const row = db.wallets.find((w) => w.id === walletId);
          if (!row) return [];
          const next = row.balancePaise + delta;
          if (next < 0) return [];
          row.balancePaise = next;
          row.updatedAt = new Date();
          return [{ balance_paise: next }];
        }

        return [];
      },
      $transaction: async (cb: (tx: any) => Promise<any>) => {
        // Snapshot DB for transaction rollback simulation
        const snapshot = JSON.stringify(db);
        try {
          return await cb(prisma);
        } catch (err) {
          db = JSON.parse(snapshot);
          throw err;
        }
      },
    };

    walletService = new WalletService(prisma, { get: () => undefined } as any);

    plansService = new PlansService(prisma, walletService);

    paymentsService = new PaymentsService(
      prisma,
      { get: () => undefined } as any,
      walletService,
      plansService,
      {} as any,
    );
  });

  function seedCashPlan(planAmountPaise = 25000, collectedAmountPaise = 25000) {
    const quoteId = 'quote-1';
    const selectionId = 'sel-1';
    const collectionId = 'cash-1';

    db.planQuotes.push({
      id: quoteId,
      userId: USER_ID,
      planType: PlanType.SEVEN_DAY_TRIAL,
      totalSellingAmount: planAmountPaise,
      deliveryOccurrences: 7,
      quantity: 1,
      quantityMode: QuantityMode.FIXED,
      frequency: 'DAILY',
      billingPeriodStart: new Date('2026-10-10'),
      billingPeriodEnd: new Date('2026-10-16'),
      status: PlanQuoteStatus.PENDING,
    });

    db.planSelections.push({
      id: selectionId,
      userId: USER_ID,
      quoteId,
      planType: PlanType.SEVEN_DAY_TRIAL,
      status: PlanSelectionStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.CASH,
      frequency: 'DAILY',
      quantityMode: QuantityMode.FIXED,
      quantity: 1,
      quantityA: null,
      quantityB: null,
      startDate: new Date('2026-10-10'),
      endDate: new Date('2026-10-16'),
      paidAt: null,
      paidAmountPaise: null,
    });

    db.cashCollections.push({
      id: collectionId,
      userId: USER_ID,
      planSelectionId: selectionId,
      walletCreditRequestId: null,
      amountPaise: collectedAmountPaise,
      status: CashCollectionStatus.PENDING,
      collectedAt: null,
      confirmedAt: null,
      confirmedByAdminId: null,
      adminNote: null,
    });

    return { quoteId, selectionId, collectionId };
  }

  it('confirmCashCollection: writes atomic CREDIT + DEBIT, updates balance, and activates plan', async () => {
    const { selectionId, collectionId } = seedCashPlan(25000, 25000);

    const result = await paymentsService.confirmCashCollection(
      collectionId,
      ADMIN_ID,
      { note: 'Cash received at hub' },
    );

    expect(result.success).toBe(true);
    expect(result.cashCollection.status).toBe(CashCollectionStatus.CONFIRMED);

    // 1. Verify Plan is marked PAID, but deliveries are NOT materialized during payment approval
    const sel = db.planSelections.find((s) => s.id === selectionId);
    expect(sel?.paidAt).toBeInstanceOf(Date);
    expect(sel?.paidAmountPaise).toBe(25000);
    expect(db.planDeliveries.length).toBe(0);
    expect(db.orders.length).toBe(0);

    // 1b. Now Admin approves the subscription in the Subscriptions tab with first delivery date
    const approveRes = await plansService.adminApproveSubscription(
      ADMIN_ID,
      selectionId,
      { firstDeliveryDate: '2026-10-15' },
    );
    expect(approveRes.success).toBe(true);
    expect(sel?.status).toBe(PlanSelectionStatus.CONFIRMED);
    expect(db.planDeliveries.length).toBe(7);

    // Orders materialised with the CORRECT plan type and configured price —
    // never the Buy Once / ₹80 fallback (Issue 2 regression).
    expect(db.orders.length).toBe(7);
    for (const o of db.orders) {
      expect(o.planType).toBe(PlanType.SEVEN_DAY_TRIAL);
      expect(o.sellingPricePerLitrePaise).toBe(TRIAL_SELLING_PAISE);
      expect(o.actualPricePerLitrePaise).toBe(TRIAL_ACTUAL_PAISE);
      expect(o.sellingPricePerLitrePaise).not.toBe(8000);
      expect(o.paymentStatus).toBe('PAID');
    }
    expect(
      db.orderItems.every((i) => i.unitPricePaise === TRIAL_SELLING_PAISE),
    ).toBe(true);
    expect(db.invoices.length).toBe(7);

    // 2. Verify Wallet Transactions: exactly 1 CREDIT and 1 DEBIT
    expect(db.transactions).toHaveLength(2);

    const creditTx = db.transactions.find(
      (t) => t.type === WalletTransactionType.CREDIT,
    );
    expect(creditTx).toBeDefined();
    expect(creditTx?.amountPaise).toBe(25000);
    expect(creditTx?.referenceType).toBe(
      WalletTransactionReferenceType.CASH_COLLECTION,
    );
    expect(creditTx?.referenceId).toBe(collectionId);
    expect(creditTx?.balanceAfterPaise).toBe(25000); // 0 -> 25000
    expect(creditTx?.description).toBe(
      'Cash collection confirmed (plan payment)',
    );

    const debitTx = db.transactions.find(
      (t) => t.type === WalletTransactionType.DEBIT,
    );
    expect(debitTx).toBeDefined();
    expect(debitTx?.amountPaise).toBe(25000);
    expect(debitTx?.referenceType).toBe(
      WalletTransactionReferenceType.PLAN_SELECTION,
    );
    expect(debitTx?.referenceId).toBe(selectionId);
    expect(debitTx?.balanceAfterPaise).toBe(0); // 25000 -> 0
    expect(debitTx?.description).toBe('Plan payment (SEVEN_DAY_TRIAL)');

    // 3. Verify final wallet balance is 0 (net zero for exact cash plan payment)
    const wallet = db.wallets.find((w) => w.userId === USER_ID);
    expect(wallet?.balancePaise).toBe(0);
    expect(wallet?.autoCreditEnabled).toBe(true);
  });

  it('Customer read: getTransactions returns both CREDIT and DEBIT rows with running balances', async () => {
    const { collectionId } = seedCashPlan(25000, 25000);

    await paymentsService.confirmCashCollection(collectionId, ADMIN_ID, {});

    const history = await walletService.getTransactions(USER_ID, {});

    expect(history.data).toHaveLength(2);
    expect(history.pagination.total).toBe(2);

    // Rows returned in desc order (most recent first)
    const types = history.data.map((t) => t.type);
    expect(types).toContain(WalletTransactionType.CREDIT);
    expect(types).toContain(WalletTransactionType.DEBIT);

    const credit = history.data.find(
      (t) => t.type === WalletTransactionType.CREDIT,
    );
    expect(credit?.amountPaise).toBe(25000);
    expect(credit?.referenceType).toBe(
      WalletTransactionReferenceType.CASH_COLLECTION,
    );
    expect(credit?.balanceAfterPaise).toBe(25000);

    const debit = history.data.find(
      (t) => t.type === WalletTransactionType.DEBIT,
    );
    expect(debit?.amountPaise).toBe(25000);
    expect(debit?.referenceType).toBe(
      WalletTransactionReferenceType.PLAN_SELECTION,
    );
    expect(debit?.balanceAfterPaise).toBe(0);
  });

  it('Re-confirm (duplicate admin confirm): rejects with 409 Conflict and creates NO duplicate ledger rows', async () => {
    const { collectionId } = seedCashPlan(25000, 25000);

    // First confirmation succeeds
    await paymentsService.confirmCashCollection(collectionId, ADMIN_ID, {});
    expect(db.transactions).toHaveLength(2);

    // Duplicate confirmation throws ConflictException
    await expect(
      paymentsService.confirmCashCollection(collectionId, 'admin-2', {}),
    ).rejects.toThrow(ConflictException);

    // Transactions count remains strictly 2 (no second credit or debit)
    expect(db.transactions).toHaveLength(2);
  });

  it('Edge case: collected cash exceeds plan total -> net wallet balance increases by surplus', async () => {
    // Customer paid ₹1000 cash for ₹900 plan
    const { collectionId } = seedCashPlan(90000, 100000);

    await paymentsService.confirmCashCollection(collectionId, ADMIN_ID, {});

    expect(db.transactions).toHaveLength(2);

    const creditTx = db.transactions.find(
      (t) => t.type === WalletTransactionType.CREDIT,
    );
    expect(creditTx?.amountPaise).toBe(100000);
    expect(creditTx?.balanceAfterPaise).toBe(100000);

    const debitTx = db.transactions.find(
      (t) => t.type === WalletTransactionType.DEBIT,
    );
    expect(debitTx?.amountPaise).toBe(90000);
    expect(debitTx?.balanceAfterPaise).toBe(10000); // 100000 - 90000 = 10000 paise (₹100)

    const wallet = db.wallets.find((w) => w.userId === USER_ID);
    expect(wallet?.balancePaise).toBe(10000);
  });

  it('Edge case: collected cash less than plan total -> rejects with CASH_SHORT_FOR_PLAN and rolls back fully', async () => {
    // Underpayment: collected ₹200 for ₹250 plan on 0 balance wallet
    const { selectionId, collectionId } = seedCashPlan(25000, 20000);

    let caught: any;
    try {
      await paymentsService.confirmCashCollection(collectionId, ADMIN_ID, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    const body = caught.getResponse();
    expect(body.error).toBe('CASH_SHORT_FOR_PLAN');
    expect(body.error).not.toBe('INSUFFICIENT_WALLET_BALANCE');
    expect(body.collectedPaise).toBe(20000);
    expect(body.requiredPaise).toBe(25000);
    expect(body.shortfallPaise).toBe(5000);
    expect(body.message).toMatch(/20000/);
    expect(body.message).toMatch(/25000/);

    // Transaction was rolled back fully: no credit, no debit, no claim.
    expect(db.transactions).toHaveLength(0);
    const sel = db.planSelections.find((s) => s.id === selectionId);
    expect(sel?.status).toBe(PlanSelectionStatus.PENDING_PAYMENT);
    expect(db.planDeliveries).toHaveLength(0);
    const col = db.cashCollections.find((c) => c.id === collectionId);
    expect(col?.status).toBe(CashCollectionStatus.PENDING);
  });

  it('Missing plan configuration during subscription approval: fails safely (PLAN_CONFIG_MISSING) and rolls back schedule generation', async () => {
    const { selectionId, collectionId } = seedCashPlan(25000, 25000);
    await paymentsService.confirmCashCollection(collectionId, ADMIN_ID, {});

    // Simulate the plan's configuration being absent at subscription approval time:
    // without it, orders cannot be priced. We fail and roll back instead.
    db.planConfigs = [];

    let caught: any;
    try {
      await plansService.adminApproveSubscription(ADMIN_ID, selectionId, {
        firstDeliveryDate: '2026-10-15',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.getResponse().error).toBe('PLAN_CONFIG_MISSING');

    // Deliveries and orders were not created
    expect(db.planDeliveries).toHaveLength(0);
    expect(db.orders).toHaveLength(0);
    expect(db.invoices).toHaveLength(0);
  });
});
