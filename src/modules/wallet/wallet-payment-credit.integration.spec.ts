jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WalletService } from './wallet.service';
import {
  WalletCreditRequestStatus,
  WalletRefundStatus,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from './wallet.constants';

type Row = Record<string, any>;

/**
 * Exercises the payment-backed credit path against a STATEFUL wallet double,
 * including a working `$queryRaw` that applies the balance delta and enforces
 * the non-negative constraint the real migration adds.
 *
 * This is where the first-credit rule, the auto-credit rule and the
 * no-double-credit guarantee are actually verified — the ledger here is a real
 * append-only list with the same uniqueness rules as the database.
 */
describe('WalletService — payment-backed credits', () => {
  const USER_ID = 'user-1';
  const WALLET_ID = 'wallet-1';

  let db: {
    wallets: Row[];
    creditRequests: Row[];
    transactions: Row[];
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([field, condition]) =>
      condition && typeof condition === 'object' && 'in' in condition
        ? (condition.in as unknown[]).includes(row[field])
        : row[field] === condition,
    );

  /** Stateful Prisma double, used as both the client and the tx client. */
  const prisma: any = {
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
      updateMany: async ({ where, data }: any) => {
        // Flag flip from WalletService.approveCreditRequestWithin and the
        // auto-credit branch of settleAfterVerifiedPayment: conditional on
        // the current value so a replay is a no-op.
        const hits = db.wallets.filter((w) => {
          if (w.id !== where.id) return false;
          if (
            where.autoCreditEnabled !== undefined &&
            w.autoCreditEnabled !== where.autoCreditEnabled
          ) {
            return false;
          }
          return true;
        });
        hits.forEach((w) =>
          Object.assign(w, data, { updatedAt: new Date() }),
        );
        return { count: hits.length };
      },
      findUnique: async ({ where }: any) => {
        const row = db.wallets.find(
          (w) =>
            (where.userId !== undefined && w.userId === where.userId) ||
            (where.id !== undefined && w.id === where.id),
        );
        return row ? { ...row } : null;
      },
    },
    walletCreditRequest: {
      create: async ({ data }: any) => {
        // Mirrors the partial unique index: one PENDING request per wallet.
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
        const row = {
          id: randomUUID(),
          refundStatus: WalletRefundStatus.NOT_REQUIRED,
          reviewedByAdminId: null,
          adminNote: null,
          reviewedAt: null,
          completedAt: null,
          createdAt: new Date(),
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
        // Mirrors @@unique([type, referenceType, referenceId]).
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
      findFirst: async ({ where }: any) => {
        const row = db.transactions.find((t) => matches(t, where));
        return row ? { ...row } : null;
      },
    },
    // Implements the two raw statements WalletService issues.
    $queryRaw: async (strings: any, ...values: any[]) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);

      if (sql.includes('FOR UPDATE')) {
        return [{ ok: 1 }];
      }

      if (sql.includes('UPDATE "wallets"')) {
        const [delta, walletId] = values;
        const row = db.wallets.find((w) => w.id === walletId);
        if (!row) return [];
        const next = row.balancePaise + delta;
        // The CHECK constraint: balance can never go negative.
        if (next < 0) return [];
        row.balancePaise = next;
        row.updatedAt = new Date();
        return [{ balance_paise: next }];
      }

      return [];
    },
    $transaction: async (cb: any) => cb(prisma),
  };

  /**
   * Builds a WalletService over the stateful DB fake. There is no global
   * auto-credit toggle any more — the per-wallet `autoCreditEnabled` field on
   * the Wallet row is the source of truth. Each test either lets the wallet
   * stay at its default (false) or completes a first credit so the flag flips.
   */
  const makeService = () =>
    new WalletService(prisma, {
      get: (key: string) =>
        ({
          WALLET_CREDIT_MIN_PAISE: '100',
          WALLET_CREDIT_MAX_PAISE: '1000000',
        })[key],
    } as any);

  const balance = () => db.wallets[0]?.balancePaise ?? 0;
  const credits = () =>
    db.transactions.filter((t) => t.type === WalletTransactionType.CREDIT);

  beforeEach(() => {
    db = { wallets: [], creditRequests: [], transactions: [] };
  });

  /** Creates a payment-backed PENDING credit request. */
  async function createRequest(
    service: WalletService,
    amountPaise = 100_000,
    source: 'ONLINE' | 'CASH' = 'ONLINE',
    key = `idem-${randomUUID()}`,
  ) {
    return prisma.$transaction((tx: any) =>
      service.createPaymentBackedCreditRequest(tx, {
        userId: USER_ID,
        amountPaise,
        source,
        idempotencyKey: key,
      }),
    );
  }

  // ══════════════════════════════════════════════════════════════════
  //  CREATION
  // ══════════════════════════════════════════════════════════════════

  describe('createPaymentBackedCreditRequest', () => {
    it('always lands PENDING even with auto-credit enabled', async () => {
      const service = makeService();
      const { request } = await createRequest(service);
      expect(request.status).toBe(WalletCreditRequestStatus.PENDING);
    });

    it('never credits the wallet at creation time', async () => {
      const service = makeService();
      await createRequest(service);
      expect(balance()).toBe(0);
      expect(db.transactions).toHaveLength(0);
    });

    it('tags the funding source', async () => {
      const service = makeService();
      const { request } = await createRequest(service, 100_000, 'CASH');
      expect(request.source).toBe('CASH');
    });

    it('rejects an amount below the configured minimum', async () => {
      const service = makeService();
      await expect(createRequest(service, 50)).rejects.toThrow(
        /between 100 and 1000000/,
      );
    });

    it('rejects an amount above the configured maximum', async () => {
      const service = makeService();
      await expect(createRequest(service, 2_000_000)).rejects.toThrow(
        /between 100 and 1000000/,
      );
    });

    it('rejects a non-integer amount', async () => {
      const service = makeService();
      await expect(createRequest(service, 1000.5)).rejects.toThrow(
        /integer number of paise/,
      );
    });

    it('replays the original request for the same idempotency key', async () => {
      const service = makeService();
      const first = await createRequest(service, 100_000, 'ONLINE', 'k1');
      const second = await createRequest(service, 100_000, 'ONLINE', 'k1');

      expect(second.replayed).toBe(true);
      expect(second.request.id).toBe(first.request.id);
      expect(db.creditRequests).toHaveLength(1);
    });

    it('409s for the same key with a different amount', async () => {
      const service = makeService();
      await createRequest(service, 100_000, 'ONLINE', 'k1');
      await expect(
        createRequest(service, 50_000, 'ONLINE', 'k1'),
      ).rejects.toThrow(ConflictException);
    });

    it('409s a second concurrent top-up while one is pending', async () => {
      const service = makeService();
      await createRequest(service, 100_000, 'ONLINE', 'k1');
      await expect(
        createRequest(service, 50_000, 'ONLINE', 'k2'),
      ).rejects.toThrow(ConflictException);
    });

    it('takes the wallet lock before deciding', async () => {
      const service = makeService();
      const spy = jest.spyOn(prisma, '$queryRaw');
      await createRequest(service);
      const sql = spy.mock.calls.map((c) =>
        Array.isArray(c[0]) ? (c[0] as string[]).join('') : String(c[0]),
      );
      expect(sql.some((s) => s.includes('FOR UPDATE'))).toBe(true);
      spy.mockRestore();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  FIRST CREDIT — ALWAYS ADMIN-APPROVED
  // ══════════════════════════════════════════════════════════════════

  describe('first credit', () => {
    it('stays PENDING after a verified payment, even with auto-credit ON', async () => {
      const service = makeService();
      const { request } = await createRequest(service);

      const settlement = await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      );

      expect(settlement.credited).toBe(false);
      expect(settlement.requiresAdminApproval).toBe(true);
      expect(settlement.status).toBe(WalletCreditRequestStatus.PENDING);
    });

    it('leaves the wallet balance untouched after a verified payment', async () => {
      const service = makeService();
      const { request } = await createRequest(service);
      await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      );
      expect(balance()).toBe(0);
      expect(db.transactions).toHaveLength(0);
    });

    it('credits exactly once when the admin approves', async () => {
      const service = makeService();
      const { request } = await createRequest(service);
      await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      );

      await service.approveCreditRequest(request.id, 'admin-1');

      expect(balance()).toBe(100_000);
      expect(credits()).toHaveLength(1);
      expect(credits()[0].balanceAfterPaise).toBe(100_000);
      expect(credits()[0].referenceType).toBe(
        WalletTransactionReferenceType.CREDIT_REQUEST,
      );
    });

    it('rejects a second approval and does not double-credit', async () => {
      const service = makeService();
      const { request } = await createRequest(service);
      await service.approveCreditRequest(request.id, 'admin-1');

      await expect(
        service.approveCreditRequest(request.id, 'admin-2'),
      ).rejects.toThrow(ConflictException);

      expect(balance()).toBe(100_000);
      expect(credits()).toHaveLength(1);
    });

    it('concurrent approvals credit exactly once', async () => {
      const service = makeService();
      const { request } = await createRequest(service);

      const results = await Promise.allSettled([
        service.approveCreditRequest(request.id, 'admin-1'),
        service.approveCreditRequest(request.id, 'admin-2'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(balance()).toBe(100_000);
      expect(credits()).toHaveLength(1);
    });

    it('404s settling an unknown credit request', async () => {
      const service = makeService();
      await expect(
        prisma.$transaction((tx: any) =>
          service.settleAfterVerifiedPayment(tx, 'nope'),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  SUBSEQUENT CREDIT
  // ══════════════════════════════════════════════════════════════════

  describe('subsequent credit', () => {
    /** Completes a first credit so the customer is no longer a first-timer. */
    async function completeFirstCredit(service: WalletService) {
      const { request } = await createRequest(
        service,
        100_000,
        'ONLINE',
        'first',
      );
      await service.approveCreditRequest(request.id, 'admin-1');
      return request;
    }

    it('auto-credits after the per-wallet flag has been set by a first completed credit', async () => {
      const service = makeService();
      await completeFirstCredit(service);

      const { request } = await createRequest(
        service,
        50_000,
        'ONLINE',
        'second',
      );
      const settlement = await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      );

      expect(settlement.credited).toBe(true);
      expect(settlement.requiresAdminApproval).toBe(false);
      expect(settlement.status).toBe(WalletCreditRequestStatus.COMPLETED);
    });

    it('increases the balance and appends exactly one ledger row', async () => {
      const service = makeService();
      await completeFirstCredit(service);

      const { request } = await createRequest(
        service,
        50_000,
        'ONLINE',
        'second',
      );
      await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      );

      expect(balance()).toBe(150_000);
      expect(credits()).toHaveLength(2);
      expect(credits()[1].balanceAfterPaise).toBe(150_000);
    });

    it('marks the request as auto-approved', async () => {
      const service = makeService();
      await completeFirstCredit(service);
      const { request } = await createRequest(
        service,
        50_000,
        'ONLINE',
        'second',
      );
      await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      );
      const stored = db.creditRequests.find((r) => r.id === request.id)!;
      expect(stored.autoApproved).toBe(true);
    });

    it('still requires admin approval when the per-wallet flag is manually disabled', async () => {
      const service = makeService();
      await completeFirstCredit(service);

      // Simulate an admin (or future admin API) turning this specific
      // customer's auto-credit back off: subsequent credits must then route
      // through admin approval again.
      db.wallets[0].autoCreditEnabled = false;

      const { request } = await createRequest(
        service,
        50_000,
        'ONLINE',
        'second',
      );
      const settlement = await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      );

      expect(settlement.requiresAdminApproval).toBe(true);
      expect(balance()).toBe(100_000);
    });

    it('a duplicate settlement cannot double-credit', async () => {
      const service = makeService();
      await completeFirstCredit(service);
      const { request } = await createRequest(
        service,
        50_000,
        'ONLINE',
        'second',
      );

      const first = await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      );
      const second = await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      );

      expect(first.credited).toBe(true);
      expect(second.credited).toBe(false);
      expect(balance()).toBe(150_000);
      expect(credits()).toHaveLength(2);
    });

    it('stays correct across many repeated settlements', async () => {
      const service = makeService();
      await completeFirstCredit(service);
      const { request } = await createRequest(
        service,
        50_000,
        'ONLINE',
        'second',
      );

      for (let i = 0; i < 5; i += 1) {
        await prisma.$transaction((tx: any) =>
          service.settleAfterVerifiedPayment(tx, request.id),
        );
      }
      expect(balance()).toBe(150_000);
      expect(credits()).toHaveLength(2);
    });

    it('concurrent settlements credit exactly once', async () => {
      const service = makeService();
      await completeFirstCredit(service);
      const { request } = await createRequest(
        service,
        50_000,
        'ONLINE',
        'second',
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
      expect(balance()).toBe(150_000);
      expect(credits()).toHaveLength(2);
    });

    it('a zero balance does not make the customer a first-timer again', async () => {
      const service = makeService();
      await completeFirstCredit(service);
      // Spend everything.
      await service.debitWallet(
        USER_ID,
        100_000,
        WalletTransactionReferenceType.ORDER,
        'order-1',
      );
      expect(balance()).toBe(0);

      const { request } = await createRequest(
        service,
        50_000,
        'ONLINE',
        'second',
      );
      const settlement = await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, request.id),
      );

      expect(settlement.credited).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  CASH
  // ══════════════════════════════════════════════════════════════════

  describe('cash credits', () => {
    it('credits on admin confirmation', async () => {
      const service = makeService();
      const { request } = await createRequest(service, 100_000, 'CASH', 'cash');

      await prisma.$transaction((tx: any) =>
        service.creditConfirmedCashRequest(tx, request.id, 'admin-1'),
      );

      expect(balance()).toBe(100_000);
      expect(credits()).toHaveLength(1);
      expect(credits()[0].description).toContain('cash collection confirmed');
    });

    it('records the confirming admin as the reviewer', async () => {
      const service = makeService();
      const { request } = await createRequest(service, 100_000, 'CASH', 'cash');
      await prisma.$transaction((tx: any) =>
        service.creditConfirmedCashRequest(tx, request.id, 'admin-7'),
      );
      const stored = db.creditRequests.find((r) => r.id === request.id)!;
      expect(stored.reviewedByAdminId).toBe('admin-7');
    });

    it('is never auto-credited, even with auto-credit ON and a prior credit', async () => {
      const service = makeService();
      const first = await createRequest(service, 100_000, 'ONLINE', 'first');
      await service.approveCreditRequest(first.request.id, 'admin-1');

      const cash = await createRequest(service, 50_000, 'CASH', 'cash');
      // The cash path never calls settleAfterVerifiedPayment; nothing credits
      // until an admin confirms.
      expect(balance()).toBe(100_000);
      expect(
        db.creditRequests.find((r) => r.id === cash.request.id)!.status,
      ).toBe(WalletCreditRequestStatus.PENDING);
    });

    it('rejects a duplicate confirmation and credits only once', async () => {
      const service = makeService();
      const { request } = await createRequest(service, 100_000, 'CASH', 'cash');

      await prisma.$transaction((tx: any) =>
        service.creditConfirmedCashRequest(tx, request.id, 'admin-1'),
      );
      await expect(
        prisma.$transaction((tx: any) =>
          service.creditConfirmedCashRequest(tx, request.id, 'admin-2'),
        ),
      ).rejects.toThrow(ConflictException);

      expect(balance()).toBe(100_000);
      expect(credits()).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  CANCELLATION
  // ══════════════════════════════════════════════════════════════════

  describe('cancelCreditRequest', () => {
    it('moves a PENDING request to CANCELLED without crediting', async () => {
      const service = makeService();
      const { request } = await createRequest(service);

      const cancelled = await prisma.$transaction((tx: any) =>
        service.cancelCreditRequest(tx, request.id, 'payment failed'),
      );

      expect(cancelled).toBe(true);
      expect(db.creditRequests.find((r) => r.id === request.id)!.status).toBe(
        WalletCreditRequestStatus.CANCELLED,
      );
      expect(balance()).toBe(0);
      expect(db.transactions).toHaveLength(0);
    });

    it('releases the pending slot so the customer can retry', async () => {
      const service = makeService();
      const { request } = await createRequest(service, 100_000, 'ONLINE', 'k1');
      await prisma.$transaction((tx: any) =>
        service.cancelCreditRequest(tx, request.id, 'payment failed'),
      );

      await expect(
        createRequest(service, 100_000, 'ONLINE', 'k2'),
      ).resolves.toBeDefined();
    });

    it('carries no refund obligation (unlike REJECTED)', async () => {
      const service = makeService();
      const { request } = await createRequest(service);
      await prisma.$transaction((tx: any) =>
        service.cancelCreditRequest(tx, request.id, 'expired'),
      );
      expect(
        db.creditRequests.find((r) => r.id === request.id)!.refundStatus,
      ).toBe(WalletRefundStatus.NOT_REQUIRED);
    });

    it('cannot cancel an already COMPLETED request', async () => {
      const service = makeService();
      const { request } = await createRequest(service);
      await service.approveCreditRequest(request.id, 'admin-1');

      const cancelled = await prisma.$transaction((tx: any) =>
        service.cancelCreditRequest(tx, request.id, 'too late'),
      );

      expect(cancelled).toBe(false);
      expect(balance()).toBe(100_000);
    });

    it('is idempotent', async () => {
      const service = makeService();
      const { request } = await createRequest(service);
      const first = await prisma.$transaction((tx: any) =>
        service.cancelCreditRequest(tx, request.id, 'failed'),
      );
      const second = await prisma.$transaction((tx: any) =>
        service.cancelCreditRequest(tx, request.id, 'failed'),
      );
      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it('a cancelled request can never be settled afterwards', async () => {
      const service = makeService();
      const first = await createRequest(service, 100_000, 'ONLINE', 'first');
      await service.approveCreditRequest(first.request.id, 'admin-1');

      const second = await createRequest(service, 50_000, 'ONLINE', 'second');
      await prisma.$transaction((tx: any) =>
        service.cancelCreditRequest(tx, second.request.id, 'failed'),
      );

      const settlement = await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, second.request.id),
      );

      expect(settlement.credited).toBe(false);
      expect(balance()).toBe(100_000);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  REFUND STATE
  // ══════════════════════════════════════════════════════════════════

  describe('markRefundOutcome', () => {
    it('records a confirmed refund on the credit request', async () => {
      const service = makeService();
      const { request } = await createRequest(service);
      await service.rejectCreditRequest(request.id, 'admin-1', {
        note: 'suspicious',
      });

      expect(
        db.creditRequests.find((r) => r.id === request.id)!.refundStatus,
      ).toBe(WalletRefundStatus.REFUND_PENDING);

      await prisma.$transaction((tx: any) =>
        service.markRefundOutcome(tx, request.id, WalletRefundStatus.REFUNDED),
      );

      expect(
        db.creditRequests.find((r) => r.id === request.id)!.refundStatus,
      ).toBe(WalletRefundStatus.REFUNDED);
    });

    it('a rejection never credits the wallet', async () => {
      const service = makeService();
      const { request } = await createRequest(service);
      await service.rejectCreditRequest(request.id, 'admin-1', {
        note: 'suspicious',
      });
      expect(balance()).toBe(0);
      expect(db.transactions).toHaveLength(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  LEDGER INTEGRITY
  // ══════════════════════════════════════════════════════════════════

  describe('ledger integrity', () => {
    it('the unique (type, referenceType, referenceId) index blocks a replayed credit', async () => {
      const service = makeService();
      const { request } = await createRequest(service);
      await service.approveCreditRequest(request.id, 'admin-1');

      // Force a second ledger write for the same reference, as a buggy
      // caller bypassing the status guard would.
      await expect(
        prisma.walletTransaction.create({
          data: {
            walletId: WALLET_ID,
            type: WalletTransactionType.CREDIT,
            amountPaise: 100_000,
            balanceAfterPaise: 200_000,
            referenceType: WalletTransactionReferenceType.CREDIT_REQUEST,
            referenceId: request.id,
          },
        }),
      ).rejects.toThrow(/unique violation/);
    });

    it('every credit records a running balance consistent with the wallet', async () => {
      const service = makeService();
      const first = await createRequest(service, 100_000, 'ONLINE', 'first');
      await service.approveCreditRequest(first.request.id, 'admin-1');
      const second = await createRequest(service, 50_000, 'ONLINE', 'second');
      await prisma.$transaction((tx: any) =>
        service.settleAfterVerifiedPayment(tx, second.request.id),
      );

      const running = credits().map((t) => t.balanceAfterPaise);
      expect(running).toEqual([100_000, 150_000]);
      expect(running[running.length - 1]).toBe(balance());
    });

    it('all amounts stay integer paise', async () => {
      const service = makeService();
      const { request } = await createRequest(service, 100_001);
      await service.approveCreditRequest(request.id, 'admin-1');

      expect(Number.isInteger(balance())).toBe(true);
      for (const t of db.transactions) {
        expect(Number.isInteger(t.amountPaise)).toBe(true);
        expect(Number.isInteger(t.balanceAfterPaise)).toBe(true);
      }
      expect(balance()).toBe(100_001);
    });
  });
});
