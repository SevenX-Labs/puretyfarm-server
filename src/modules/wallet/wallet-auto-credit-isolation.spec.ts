jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { randomUUID } from 'crypto';
import { WalletService } from './wallet.service';
import {
  WalletCreditRequestStatus,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from './wallet.constants';

type Row = Record<string, any>;

/**
 * Pins the final business rule: per-wallet auto-credit, with no global switch.
 *
 * Runs the real WalletService against a stateful in-memory Prisma double that
 * mirrors the DB rules the real schema enforces — one PENDING per wallet, a
 * non-negative balance, a conditional flag flip on first-credit completion
 * and the (type, referenceType, referenceId) uniqueness that stops a credit
 * being double-written.
 */
describe('Wallet auto-credit — customer-specific isolation', () => {
  interface Wallet {
    id: string;
    userId: string;
    balancePaise: number;
    autoCreditEnabled: boolean;
    updatedAt: Date;
  }
  interface CreditRequest {
    id: string;
    walletId: string;
    amountPaise: number;
    status: WalletCreditRequestStatus;
    refundStatus: string;
    autoApproved: boolean;
    source: string | null;
    idempotencyKey: string;
    requestHash: string;
    reviewedByAdminId: string | null;
    adminNote: string | null;
    reviewedAt: Date | null;
    completedAt: Date | null;
    updatedAt: Date;
  }
  interface Transaction {
    id: string;
    walletId: string;
    type: WalletTransactionType;
    amountPaise: number;
    balanceAfterPaise: number;
    referenceType: WalletTransactionReferenceType;
    referenceId: string;
    creditRequestId: string | null;
    description: string | null;
    createdAt: Date;
  }

  let db: {
    wallets: Wallet[];
    creditRequests: CreditRequest[];
    transactions: Transaction[];
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([field, condition]) => {
      if (condition && typeof condition === 'object' && 'in' in condition) {
        return (condition.in as unknown[]).includes(row[field]);
      }
      return row[field] === condition;
    });

  const prisma: any = {
    wallet: {
      upsert: async ({ where, create }: any) => {
        let row = db.wallets.find((w) => w.userId === where.userId);
        if (!row) {
          row = {
            id: randomUUID(),
            userId: create.userId,
            balancePaise: 0,
            autoCreditEnabled: false,
            updatedAt: new Date(),
          };
          db.wallets.push(row);
        }
        return { ...row };
      },
      findUnique: async ({ where, select }: any) => {
        const row = db.wallets.find(
          (w) =>
            (where.id !== undefined && w.id === where.id) ||
            (where.userId !== undefined && w.userId === where.userId),
        );
        if (!row) return null;
        if (!select) return { ...row };
        const out: Row = {};
        for (const key of Object.keys(select)) out[key] = (row as any)[key];
        return out;
      },
      updateMany: async ({ where, data }: any) => {
        const hits = db.wallets.filter(
          (w) =>
            w.id === where.id &&
            (where.autoCreditEnabled === undefined ||
              w.autoCreditEnabled === where.autoCreditEnabled),
        );
        hits.forEach((w) => Object.assign(w, data, { updatedAt: new Date() }));
        return { count: hits.length };
      },
    },
    walletCreditRequest: {
      create: async ({ data }: any) => {
        if (
          data.status === WalletCreditRequestStatus.PENDING &&
          db.creditRequests.some(
            (r) =>
              r.walletId === data.walletId &&
              r.status === WalletCreditRequestStatus.PENDING,
          )
        ) {
          throw new Error('unique violation: one_pending_per_wallet');
        }
        const row: CreditRequest = {
          id: randomUUID(),
          refundStatus: 'NOT_REQUIRED',
          reviewedByAdminId: null,
          adminNote: null,
          reviewedAt: null,
          completedAt: null,
          autoApproved: false,
          source: null,
          updatedAt: new Date(),
          ...data,
        };
        db.creditRequests.push(row);
        return { ...row };
      },
      findUnique: async ({ where }: any) => {
        const row = db.creditRequests.find(
          (r) =>
            (where.id !== undefined && r.id === where.id) ||
            (where.walletId_idempotencyKey !== undefined &&
              r.walletId === where.walletId_idempotencyKey.walletId &&
              r.idempotencyKey ===
                where.walletId_idempotencyKey.idempotencyKey),
        );
        return row ? { ...row } : null;
      },
      findFirst: async ({ where }: any) => {
        const row = db.creditRequests.find((r) => matches(r, where));
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }: any) => {
        const hits = db.creditRequests.filter((r) => matches(r, where));
        hits.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
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
        const row: Transaction = {
          id: randomUUID(),
          createdAt: new Date(),
          creditRequestId: null,
          description: null,
          ...data,
        };
        db.transactions.push(row);
        return { ...row };
      },
      findFirst: async ({ where }: any) => {
        const row = db.transactions.find((t) => matches(t, where));
        return row ? { ...row } : null;
      },
    },
    $queryRaw: async (strings: any, ...values: any[]) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('FOR UPDATE')) return [{ ok: 1 }];
      if (sql.includes('UPDATE "wallets"')) {
        const [delta, walletId] = values;
        const row = db.wallets.find((w) => w.id === walletId);
        if (!row) return [];
        const next = row.balancePaise + delta;
        if (next < 0) return []; // mirrors the CHECK constraint
        row.balancePaise = next;
        row.updatedAt = new Date();
        return [{ balance_paise: next }];
      }
      return [];
    },
    $transaction: async (cb: any) => cb(prisma),
  };

  const makeService = () =>
    new WalletService(prisma, {
      get: (key: string) =>
        ({
          WALLET_CREDIT_MIN_PAISE: '100',
          WALLET_CREDIT_MAX_PAISE: '1000000',
        })[key],
    } as any);

  beforeEach(() => {
    db = { wallets: [], creditRequests: [], transactions: [] };
  });

  const walletFor = (userId: string): Wallet | undefined =>
    db.wallets.find((w) => w.userId === userId);

  async function createRequest(
    service: WalletService,
    userId: string,
    amountPaise: number,
    source: 'ONLINE' | 'CASH',
    key: string,
  ) {
    return prisma.$transaction((tx: any) =>
      service.createPaymentBackedCreditRequest(tx, {
        userId,
        amountPaise,
        source,
        idempotencyKey: key,
      }),
    );
  }

  async function completeFirstOnline(
    service: WalletService,
    userId: string,
    amountPaise: number,
  ) {
    const { request } = await createRequest(
      service,
      userId,
      amountPaise,
      'ONLINE',
      `first-${userId}`,
    );
    await service.approveCreditRequest(request.id, 'admin-1');
    return request;
  }

  // ── New-wallet default ────────────────────────────────────────────

  it('a brand-new wallet starts with autoCreditEnabled=false', async () => {
    const service = makeService();
    await createRequest(service, 'cust-new', 100_000, 'ONLINE', 'init');
    expect(walletFor('cust-new')!.autoCreditEnabled).toBe(false);
  });

  // ── First credit always requires approval ─────────────────────────

  it('first ONLINE credit stays PENDING irrespective of any other customer', async () => {
    const service = makeService();

    // Customer A completes a first credit; A's flag flips true.
    await completeFirstOnline(service, 'cust-A', 100_000);
    expect(walletFor('cust-A')!.autoCreditEnabled).toBe(true);

    // Customer B's first attempt: flag is still false on B's wallet.
    const { request: bReq } = await createRequest(
      service,
      'cust-B',
      100_000,
      'ONLINE',
      'b-first',
    );
    const settlement = await prisma.$transaction((tx: any) =>
      service.settleAfterVerifiedPayment(tx, bReq.id),
    );

    expect(settlement.requiresAdminApproval).toBe(true);
    expect(settlement.credited).toBe(false);
    expect(walletFor('cust-B')!.balancePaise).toBe(0);
    expect(walletFor('cust-B')!.autoCreditEnabled).toBe(false);
  });

  // ── Flag flip is exactly on first completion ──────────────────────

  it('autoCreditEnabled flips to true only when the first credit completes (admin approval)', async () => {
    const service = makeService();

    const { request } = await createRequest(
      service,
      'cust-A',
      100_000,
      'ONLINE',
      'k1',
    );
    // Payment reaches SUCCESS but admin has not approved yet — flag MUST
    // remain false until the credit actually completes.
    expect(walletFor('cust-A')!.autoCreditEnabled).toBe(false);
    const beforeApproval = await prisma.$transaction((tx: any) =>
      service.settleAfterVerifiedPayment(tx, request.id),
    );
    expect(beforeApproval.requiresAdminApproval).toBe(true);
    expect(walletFor('cust-A')!.autoCreditEnabled).toBe(false);

    await service.approveCreditRequest(request.id, 'admin-1');
    expect(walletFor('cust-A')!.autoCreditEnabled).toBe(true);
    expect(walletFor('cust-A')!.balancePaise).toBe(100_000);
  });

  it('autoCreditEnabled flips to true after first CASH credit is confirmed', async () => {
    const service = makeService();
    const { request } = await createRequest(
      service,
      'cust-D',
      100_000,
      'CASH',
      'd-cash',
    );
    expect(walletFor('cust-D')!.autoCreditEnabled).toBe(false);

    await prisma.$transaction((tx: any) =>
      service.creditConfirmedCashRequest(tx, request.id, 'admin-7'),
    );

    expect(walletFor('cust-D')!.autoCreditEnabled).toBe(true);
    expect(walletFor('cust-D')!.balancePaise).toBe(100_000);
  });

  it('autoCreditEnabled stays false when the first ONLINE credit is REJECTED', async () => {
    const service = makeService();
    const { request } = await createRequest(
      service,
      'cust-C',
      100_000,
      'ONLINE',
      'c-first',
    );

    await service.rejectCreditRequest(request.id, 'admin-1', {
      note: 'fraud suspected',
    });

    expect(walletFor('cust-C')!.autoCreditEnabled).toBe(false);
    expect(walletFor('cust-C')!.balancePaise).toBe(0);
    expect(db.transactions).toHaveLength(0);
  });

  it('autoCreditEnabled stays false when the first ONLINE credit is CANCELLED (expiry)', async () => {
    const service = makeService();
    const { request } = await createRequest(
      service,
      'cust-E',
      100_000,
      'ONLINE',
      'e-first',
    );

    await prisma.$transaction((tx: any) =>
      service.cancelCreditRequest(tx, request.id, 'payment expired'),
    );

    expect(walletFor('cust-E')!.autoCreditEnabled).toBe(false);
    expect(walletFor('cust-E')!.balancePaise).toBe(0);
  });

  // ── Second+ ONLINE auto-credit is per customer ────────────────────

  it("customer A's enabled flag does NOT bleed into customer B's wallet", async () => {
    const service = makeService();

    // A completes first credit; A is now auto-credit-eligible.
    await completeFirstOnline(service, 'cust-A', 100_000);
    expect(walletFor('cust-A')!.autoCreditEnabled).toBe(true);

    // A second online top-up for A auto-credits.
    const { request: aSecond } = await createRequest(
      service,
      'cust-A',
      50_000,
      'ONLINE',
      'a-second',
    );
    const aSettlement = await prisma.$transaction((tx: any) =>
      service.settleAfterVerifiedPayment(tx, aSecond.id),
    );
    expect(aSettlement.credited).toBe(true);
    expect(walletFor('cust-A')!.balancePaise).toBe(150_000);

    // B is independent: new user with no history, still false, still pending.
    const { request: bFirst } = await createRequest(
      service,
      'cust-B',
      100_000,
      'ONLINE',
      'b-first',
    );
    const bSettlement = await prisma.$transaction((tx: any) =>
      service.settleAfterVerifiedPayment(tx, bFirst.id),
    );
    expect(bSettlement.requiresAdminApproval).toBe(true);
    expect(walletFor('cust-B')!.autoCreditEnabled).toBe(false);
    expect(walletFor('cust-B')!.balancePaise).toBe(0);
  });

  it('customer B auto-credits only after B has personally completed a first credit', async () => {
    const service = makeService();

    // B's first credit must go through admin approval.
    await completeFirstOnline(service, 'cust-B', 100_000);
    expect(walletFor('cust-B')!.autoCreditEnabled).toBe(true);
    expect(walletFor('cust-B')!.balancePaise).toBe(100_000);

    // Second online top-up for B now auto-credits.
    const { request } = await createRequest(
      service,
      'cust-B',
      50_000,
      'ONLINE',
      'b-second',
    );
    const settlement = await prisma.$transaction((tx: any) =>
      service.settleAfterVerifiedPayment(tx, request.id),
    );
    expect(settlement.credited).toBe(true);
    expect(walletFor('cust-B')!.balancePaise).toBe(150_000);
  });

  it('a zero balance after a prior credit does NOT reset auto-credit', async () => {
    const service = makeService();
    await completeFirstOnline(service, 'cust-F', 100_000);
    await service.debitWallet(
      'cust-F',
      100_000,
      WalletTransactionReferenceType.ORDER,
      'order-1',
    );
    expect(walletFor('cust-F')!.balancePaise).toBe(0);
    expect(walletFor('cust-F')!.autoCreditEnabled).toBe(true);

    const { request } = await createRequest(
      service,
      'cust-F',
      30_000,
      'ONLINE',
      'f-second',
    );
    const settlement = await prisma.$transaction((tx: any) =>
      service.settleAfterVerifiedPayment(tx, request.id),
    );
    expect(settlement.credited).toBe(true);
    expect(walletFor('cust-F')!.balancePaise).toBe(30_000);
  });

  // ── Cash never auto-credits on request ────────────────────────────

  it('CASH top-ups never auto-credit, even when the per-wallet flag is already true', async () => {
    const service = makeService();
    await completeFirstOnline(service, 'cust-G', 100_000);
    expect(walletFor('cust-G')!.autoCreditEnabled).toBe(true);

    // Even though G is auto-credit-eligible for ONLINE, a cash REQUEST does
    // not credit anything. Only an admin confirmation does.
    const { request } = await createRequest(
      service,
      'cust-G',
      50_000,
      'CASH',
      'g-cash',
    );
    expect(walletFor('cust-G')!.balancePaise).toBe(100_000);
    expect(db.creditRequests.find((r) => r.id === request.id)!.status).toBe(
      WalletCreditRequestStatus.PENDING,
    );

    await prisma.$transaction((tx: any) =>
      service.creditConfirmedCashRequest(tx, request.id, 'admin-7'),
    );
    expect(walletFor('cust-G')!.balancePaise).toBe(150_000);
  });

  // ── Scenario 5 from the brief ─────────────────────────────────────

  it('cash-first customer: cash confirmation enables auto-credit, next online auto-credits', async () => {
    const service = makeService();

    // First top-up for D is CASH.
    const { request: dCash } = await createRequest(
      service,
      'cust-D',
      100_000,
      'CASH',
      'd-cash',
    );
    expect(walletFor('cust-D')!.autoCreditEnabled).toBe(false);

    await prisma.$transaction((tx: any) =>
      service.creditConfirmedCashRequest(tx, dCash.id, 'admin-7'),
    );
    expect(walletFor('cust-D')!.autoCreditEnabled).toBe(true);
    expect(walletFor('cust-D')!.balancePaise).toBe(100_000);

    // D's next online top-up auto-credits.
    const { request: dOnline } = await createRequest(
      service,
      'cust-D',
      50_000,
      'ONLINE',
      'd-online',
    );
    const settlement = await prisma.$transaction((tx: any) =>
      service.settleAfterVerifiedPayment(tx, dOnline.id),
    );
    expect(settlement.credited).toBe(true);
    expect(walletFor('cust-D')!.balancePaise).toBe(150_000);
  });

  // ── Ledger integrity under auto-credit race ───────────────────────

  it('two concurrent settlements for an auto-credit-eligible wallet credit only once', async () => {
    const service = makeService();
    await completeFirstOnline(service, 'cust-A', 100_000);
    const { request } = await createRequest(
      service,
      'cust-A',
      25_000,
      'ONLINE',
      'a-second',
    );

    const results = await Promise.all([
      prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      ),
      prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      ),
    ]);

    expect(results.filter((r: any) => r.credited)).toHaveLength(1);
    expect(walletFor('cust-A')!.balancePaise).toBe(125_000);
    expect(
      db.transactions.filter((t) => t.type === WalletTransactionType.CREDIT),
    ).toHaveLength(2);
  });

  // ── Flag flip is atomic with the credit ───────────────────────────

  it('the flag flip only lands when the credit itself landed', async () => {
    const service = makeService();
    const { request } = await createRequest(
      service,
      'cust-A',
      100_000,
      'ONLINE',
      'k1',
    );

    await service.approveCreditRequest(request.id, 'admin-1');
    // Both must be true simultaneously: a ledger write and a flag flip.
    expect(walletFor('cust-A')!.balancePaise).toBe(100_000);
    expect(walletFor('cust-A')!.autoCreditEnabled).toBe(true);
    expect(
      db.transactions.filter((t) => t.type === WalletTransactionType.CREDIT),
    ).toHaveLength(1);
  });
});
