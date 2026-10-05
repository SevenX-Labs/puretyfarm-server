jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PaymentsService } from './payments.service';
import {
  CashCollectionStatus,
  PaymentMethod,
  PaymentTransactionStatus,
} from './payments.constants';
import { WalletCreditRequestStatus } from '../wallet/wallet.constants';
import type { ProviderVerificationResult } from './providers/payment-provider.interface';

type Row = Record<string, any>;

const USER_ID = 'user-1';

/**
 * Builds an in-memory Prisma double that honours the semantics the service
 * actually depends on — in particular `updateMany` returning an affected-row
 * COUNT under a conditional `where`, which is the mechanism behind every
 * duplicate-webhook and race guard in this module.
 */
function makeDb() {
  const db = {
    payments: [] as Row[],
    cashCollections: [] as Row[],
    creditRequests: [] as Row[],
    users: [
      {
        id: USER_ID,
        mobile: '9876543210',
        email: 'asha@example.com',
        customerProfile: { firstName: 'Asha', lastName: 'K' },
      },
      {
        id: 'someone-else',
        mobile: '9000000000',
        email: 'other@example.com',
        customerProfile: { firstName: 'Ravi', lastName: 'S' },
      },
    ] as Row[],
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([field, condition]) => {
      if (condition && typeof condition === 'object') {
        if ('in' in condition) {
          return (condition.in as unknown[]).includes(row[field]);
        }
        if ('not' in condition) {
          return row[field] !== condition.not;
        }
        // Range operators, as used by the expiry sweep and date filters.
        const value = row[field];
        return Object.entries(condition as Record<string, any>).every(
          ([op, operand]) => {
            switch (op) {
              case 'lt':
                return value < operand;
              case 'lte':
                return value <= operand;
              case 'gt':
                return value > operand;
              case 'gte':
                return value >= operand;
              default:
                return true;
            }
          },
        );
      }
      return row[field] === condition;
    });

  const client: any = {
    payment: {
      create: async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: randomUUID(),
          orderId: null,
          providerPaymentId: null,
          failureCode: null,
          failureMessage: null,
          providerResponse: null,
          completedAt: null,
          refundedAt: null,
          providerRefundId: null,
          expiresAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        if (db.payments.some((p) => p.transactionId === row.transactionId)) {
          throw new Error('unique constraint: transactionId');
        }
        if (
          db.payments.some(
            (p) =>
              p.userId === row.userId &&
              p.idempotencyKey === row.idempotencyKey,
          )
        ) {
          throw new Error('unique constraint: userId_idempotencyKey');
        }
        db.payments.push(row);
        return { ...row };
      },
      findUnique: async ({ where, include }: any) => {
        const row = db.payments.find(
          (p) =>
            (where.id !== undefined && p.id === where.id) ||
            (where.transactionId !== undefined &&
              p.transactionId === where.transactionId) ||
            (where.userId_idempotencyKey !== undefined &&
              p.userId === where.userId_idempotencyKey.userId &&
              p.idempotencyKey === where.userId_idempotencyKey.idempotencyKey),
        );
        if (!row) return null;
        return hydrate(row, include);
      },
      findUniqueOrThrow: async (args: any) => {
        const row = await client.payment.findUnique(args);
        if (!row) throw new Error('payment not found');
        return row;
      },
      findFirst: async ({ where }: any) => {
        const row = db.payments.find((p) => matches(p, where));
        return row ? { ...row } : null;
      },
      findMany: async ({ where = {}, include }: any) =>
        db.payments
          .filter((p) => matches(p, where))
          .map((p) => hydrate(p, include)),
      count: async ({ where = {} }: any) =>
        db.payments.filter((p) => matches(p, where)).length,
      updateMany: async ({ where, data }: any) => {
        const hits = db.payments.filter((p) => matches(p, where));
        hits.forEach((p) => Object.assign(p, data, { updatedAt: new Date() }));
        return { count: hits.length };
      },
      update: async ({ where, data }: any) => {
        const row = db.payments.find((p) => p.id === where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
    },
    cashCollection: {
      create: async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: randomUUID(),
          collectedAt: null,
          confirmedAt: null,
          confirmedByAdminId: null,
          adminNote: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        db.cashCollections.push(row);
        return { ...row };
      },
      findUnique: async ({ where, include }: any) => {
        const row = db.cashCollections.find(
          (c) =>
            (where.id !== undefined && c.id === where.id) ||
            (where.walletCreditRequestId !== undefined &&
              c.walletCreditRequestId === where.walletCreditRequestId),
        );
        if (!row) return null;
        return hydrateCash(row, include);
      },
      findUniqueOrThrow: async (args: any) => {
        const row = await client.cashCollection.findUnique(args);
        if (!row) throw new Error('cash collection not found');
        return row;
      },
      findMany: async ({ where = {}, include }: any) =>
        db.cashCollections
          .filter((c) => matches(c, where))
          .map((c) => hydrateCash(c, include)),
      count: async ({ where = {} }: any) =>
        db.cashCollections.filter((c) => matches(c, where)).length,
      updateMany: async ({ where, data }: any) => {
        const hits = db.cashCollections.filter((c) => matches(c, where));
        hits.forEach((c) => Object.assign(c, data, { updatedAt: new Date() }));
        return { count: hits.length };
      },
    },
    walletCreditRequest: {
      findUnique: async ({ where }: any) => {
        const row = db.creditRequests.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }: any) => {
        const hits = db.creditRequests.filter((r) => matches(r, where));
        hits.forEach((r) => Object.assign(r, data));
        return { count: hits.length };
      },
    },
    user: {
      findUnique: async ({ where }: any) => {
        const row = db.users.find((u) => u.id === where.id);
        return row ? { ...row } : null;
      },
    },
    // Single-connection fake: the callback receives this same client, so
    // conditional updates inside a transaction behave as they do in Postgres
    // for the sequential cases under test.
    $transaction: async (cb: any) => cb(client),
  };

  function hydrate(row: Row, include?: Row) {
    const out: Row = { ...row };
    if (include?.walletCreditRequest) {
      const cr = db.creditRequests.find(
        (r) => r.id === row.walletCreditRequestId,
      );
      out.walletCreditRequest = cr ? { ...cr, transaction: null } : null;
    }
    if (include?.user) {
      out.user = db.users.find((u) => u.id === row.userId);
    }
    return out;
  }

  function hydrateCash(row: Row, include?: Row) {
    const out: Row = { ...row };
    if (include?.walletCreditRequest) {
      const cr = db.creditRequests.find(
        (r) => r.id === row.walletCreditRequestId,
      );
      out.walletCreditRequest = cr ? { ...cr, transaction: null } : null;
    }
    if (include?.user) {
      out.user = db.users.find((u) => u.id === row.userId);
    }
    return out;
  }

  return { db, client };
}

describe('PaymentsService', () => {
  let service: PaymentsService;
  let db: ReturnType<typeof makeDb>['db'];
  let prisma: any;
  let wallet: {
    validateCreditAmount: jest.Mock;
    createPaymentBackedCreditRequest: jest.Mock;
    settleAfterVerifiedPayment: jest.Mock;
    creditConfirmedCashRequest: jest.Mock;
    cancelCreditRequest: jest.Mock;
    markRefundOutcome: jest.Mock;
  };
  let provider: {
    createPayment: jest.Mock;
    verifyPayment: jest.Mock;
    refundPayment: jest.Mock;
    fetchAuthoritativeStatus: jest.Mock;
  };

  /** Seeds a PENDING credit request and returns it. */
  function seedCreditRequest(overrides: Row = {}) {
    const row = {
      id: randomUUID(),
      walletId: 'wallet-1',
      amountPaise: 100_000,
      status: WalletCreditRequestStatus.PENDING,
      refundStatus: 'NOT_REQUIRED',
      autoApproved: false,
      source: PaymentMethod.ONLINE,
      idempotencyKey: 'key-seed',
      requestHash: 'topup:100000:ONLINE',
      adminNote: null,
      completedAt: null,
      transaction: null,
      ...overrides,
    };
    db.creditRequests.push(row);
    return row;
  }

  /** Seeds a payment row directly. */
  function seedPayment(overrides: Row = {}) {
    const now = new Date();
    const row = {
      id: randomUUID(),
      userId: USER_ID,
      orderId: null,
      walletCreditRequestId: null,
      provider: 'PAYU',
      purpose: 'WALLET_TOPUP',
      paymentMethod: PaymentMethod.ONLINE,
      transactionId: `PFTEST${db.payments.length}`,
      providerPaymentId: null,
      amountPaise: 100_000,
      currency: 'INR',
      status: PaymentTransactionStatus.PENDING,
      failureCode: null,
      failureMessage: null,
      providerResponse: null,
      idempotencyKey: `key-${db.payments.length}`,
      requestHash: 'topup:100000:ONLINE',
      expiresAt: new Date(Date.now() + 1_800_000),
      completedAt: null,
      providerRefundId: null,
      refundedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    db.payments.push(row);
    return row;
  }

  const verification = (
    overrides: Partial<ProviderVerificationResult> = {},
  ): ProviderVerificationResult => ({
    signatureValid: true,
    transactionId: 'PFTEST0',
    providerPaymentId: 'PAYU1',
    amountPaise: 100_000,
    status: PaymentTransactionStatus.SUCCESS,
    rawStatus: 'success',
    failureCode: null,
    failureMessage: null,
    sanitisedPayload: { txnid: 'PFTEST0', status: 'success' },
    ...overrides,
  });

  /**
   * `createWalletTopUp` returns a different shape per payment method, so the
   * online tests go through this helper rather than narrowing the union at
   * every call site.
   */
  const createOnline = (
    dto: { amount: number; paymentMethod: PaymentMethod },
    key: string,
    userId = USER_ID,
  ): Promise<any> => service.createWalletTopUp(userId, dto, key) as any;

  /** Same, for the CASH branch. */
  const createCash = (
    dto: { amount: number; paymentMethod: PaymentMethod },
    key: string,
    userId = USER_ID,
  ): Promise<any> => service.createWalletTopUp(userId, dto, key) as any;

  beforeEach(() => {
    const made = makeDb();
    db = made.db;
    prisma = made.client;

    wallet = {
      validateCreditAmount: jest.fn(),
      createPaymentBackedCreditRequest: jest.fn(async (_tx, params) => {
        const request = seedCreditRequest({
          amountPaise: params.amountPaise,
          source: params.source,
          idempotencyKey: params.idempotencyKey,
          requestHash: `topup:${params.amountPaise}:${params.source}`,
        });
        return { request, walletId: 'wallet-1', replayed: false };
      }),
      settleAfterVerifiedPayment: jest.fn(async () => ({
        credited: true,
        requiresAdminApproval: false,
        status: WalletCreditRequestStatus.COMPLETED,
        balanceAfterPaise: 100_000,
        transactionId: 'txn-1',
      })),
      creditConfirmedCashRequest: jest.fn(async () => ({
        success: true,
        message: 'ok',
        request: { id: 'cr', status: 'COMPLETED', amountPaise: 100_000 },
      })),
      cancelCreditRequest: jest.fn(async () => true),
      markRefundOutcome: jest.fn(async () => undefined),
    };

    provider = {
      createPayment: jest.fn(async ({ transactionId }) => ({
        endpoint: 'https://secure.payu.in/_payment',
        method: 'POST' as const,
        fields: { txnid: transactionId, hash: 'abc' },
      })),
      verifyPayment: jest.fn(),
      refundPayment: jest.fn(),
      fetchAuthoritativeStatus: jest.fn(),
    };

    service = new PaymentsService(
      prisma,
      { get: () => undefined } as any,
      wallet as any,
      provider,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  //  PAYMENT CREATION
  // ══════════════════════════════════════════════════════════════════

  describe('createWalletTopUp — online', () => {
    const dto = { amount: 100_000, paymentMethod: PaymentMethod.ONLINE };

    it('creates a PENDING credit request and a PENDING payment', async () => {
      const result = await createOnline(dto, 'idem-1');

      expect(db.creditRequests).toHaveLength(1);
      expect(db.creditRequests[0].status).toBe(
        WalletCreditRequestStatus.PENDING,
      );
      expect(db.payments).toHaveLength(1);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
      expect(result.payment.status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('does NOT credit the wallet at creation time', async () => {
      await service.createWalletTopUp(USER_ID, dto, 'idem-1');
      expect(wallet.settleAfterVerifiedPayment).not.toHaveBeenCalled();
      expect(wallet.creditConfirmedCashRequest).not.toHaveBeenCalled();
    });

    it("delegates amount validation to the wallet's configured bounds", async () => {
      await service.createWalletTopUp(USER_ID, dto, 'idem-1');
      expect(wallet.validateCreditAmount).toHaveBeenCalledWith(100_000);
    });

    it('rejects an amount the wallet refuses', async () => {
      wallet.validateCreditAmount.mockImplementation(() => {
        throw new BadRequestException({ error: 'INVALID_CREDIT_AMOUNT' });
      });
      await expect(
        service.createWalletTopUp(USER_ID, { ...dto, amount: 1 }, 'idem-1'),
      ).rejects.toThrow(BadRequestException);
      expect(db.payments).toHaveLength(0);
    });

    it('generates the transaction id server-side with the PF prefix', async () => {
      const result = await createOnline(dto, 'idem-1');
      expect(result.payment.transactionId).toMatch(/^PF[0-9A-Z]+$/);
      expect(result.payment.transactionId.length).toBeLessThanOrEqual(25);
    });

    it('generates a distinct transaction id per payment', async () => {
      await service.createWalletTopUp(USER_ID, dto, 'idem-1');
      await service.createWalletTopUp(USER_ID, dto, 'idem-2').catch(() => {});
      const ids = new Set(db.payments.map((p) => p.transactionId));
      expect(ids.size).toBe(db.payments.length);
    });

    it('returns checkout fields from the provider, never a salt', async () => {
      const result = await createOnline(dto, 'idem-1');
      expect(result.checkout.endpoint).toBe('https://secure.payu.in/_payment');
      expect(provider.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          amountPaise: 100_000,
          productInfo: 'PuretyFarm Wallet Top-up',
          customerEmail: 'asha@example.com',
          customerPhone: '9876543210',
          customerFirstName: 'Asha',
        }),
      );
    });

    it('never passes a client-supplied amount to the provider', async () => {
      // The DTO amount is validated then used; there is no path by which a
      // separate "payable" value could be injected.
      await service.createWalletTopUp(USER_ID, dto, 'idem-1');
      const call = provider.createPayment.mock.calls[0][0];
      expect(call.amountPaise).toBe(db.payments[0].amountPaise);
    });

    it('replays the original payment for the same idempotency key', async () => {
      const first = await createOnline(dto, 'idem-1');
      const second = await createOnline(dto, 'idem-1');

      expect(second.payment.id).toBe(first.payment.id);
      expect(second.replayed).toBe(true);
      expect(db.payments).toHaveLength(1);
      expect(db.creditRequests).toHaveLength(1);
    });

    it('409s for the same idempotency key with a different amount', async () => {
      await service.createWalletTopUp(USER_ID, dto, 'idem-1');
      await expect(
        service.createWalletTopUp(
          USER_ID,
          { ...dto, amount: 50_000 },
          'idem-1',
        ),
      ).rejects.toThrow(ConflictException);
      expect(db.payments).toHaveLength(1);
    });

    it('409s for the same key with a different payment method', async () => {
      await service.createWalletTopUp(USER_ID, dto, 'idem-1');
      await expect(
        service.createWalletTopUp(
          USER_ID,
          { amount: 100_000, paymentMethod: PaymentMethod.CASH },
          'idem-1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('requires an email before sending the customer to checkout', async () => {
      db.users[0].email = null;
      await expect(
        service.createWalletTopUp(USER_ID, dto, 'idem-1'),
      ).rejects.toThrow(BadRequestException);
      expect(db.payments).toHaveLength(0);
    });

    it('404s for an unknown customer', async () => {
      await expect(
        service.createWalletTopUp('nobody', dto, 'idem-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it("propagates the wallet's pending-request conflict", async () => {
      wallet.createPaymentBackedCreditRequest.mockRejectedValue(
        new ConflictException({ error: 'WALLET_PENDING_REQUEST_EXISTS' }),
      );
      await expect(
        service.createWalletTopUp(USER_ID, dto, 'idem-9'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('createWalletTopUp — cash', () => {
    const dto = { amount: 100_000, paymentMethod: PaymentMethod.CASH };

    it('creates a PENDING credit request and a PENDING cash collection', async () => {
      const result = await createCash(dto, 'cash-1');

      expect(db.creditRequests[0].status).toBe(
        WalletCreditRequestStatus.PENDING,
      );
      expect(db.cashCollections).toHaveLength(1);
      expect(db.cashCollections[0].status).toBe(CashCollectionStatus.PENDING);
      expect(result.cashCollection.status).toBe(CashCollectionStatus.PENDING);
    });

    it('creates NO Payment record for cash', async () => {
      await service.createWalletTopUp(USER_ID, dto, 'cash-1');
      expect(db.payments).toHaveLength(0);
    });

    it('never calls the payment provider for cash', async () => {
      await service.createWalletTopUp(USER_ID, dto, 'cash-1');
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    it('does NOT credit the wallet when the cash request is created', async () => {
      await service.createWalletTopUp(USER_ID, dto, 'cash-1');
      expect(wallet.creditConfirmedCashRequest).not.toHaveBeenCalled();
      expect(wallet.settleAfterVerifiedPayment).not.toHaveBeenCalled();
    });

    it('tags the credit request as CASH-sourced', async () => {
      await service.createWalletTopUp(USER_ID, dto, 'cash-1');
      expect(wallet.createPaymentBackedCreditRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ source: 'CASH' }),
      );
    });

    it('does not require an email for cash', async () => {
      db.users[0].email = null;
      await expect(
        service.createWalletTopUp(USER_ID, dto, 'cash-1'),
      ).resolves.toBeDefined();
    });

    it('replays an existing cash collection for a repeated key', async () => {
      const first = await createCash(dto, 'cash-1');
      const existing = db.creditRequests[0];
      wallet.createPaymentBackedCreditRequest.mockResolvedValueOnce({
        request: existing,
        walletId: 'wallet-1',
        replayed: true,
      });
      const second = await createCash(dto, 'cash-1');
      expect(second.cashCollection.id).toBe(first.cashCollection.id);
      expect(db.cashCollections).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  VERIFIED OUTCOME — SIGNATURE, IDENTITY, AMOUNT
  // ══════════════════════════════════════════════════════════════════

  describe('applyVerifiedOutcome — gatekeeping', () => {
    it('rejects an invalid signature with 403 before any lookup', async () => {
      const payment = seedPayment();
      await expect(
        service.applyVerifiedOutcome(
          verification({
            signatureValid: false,
            transactionId: payment.transactionId,
          }),
          'WEBHOOK',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('does not credit the wallet on an invalid signature', async () => {
      const payment = seedPayment({
        walletCreditRequestId: seedCreditRequest().id,
      });
      await service
        .applyVerifiedOutcome(
          verification({
            signatureValid: false,
            transactionId: payment.transactionId,
          }),
          'WEBHOOK',
        )
        .catch(() => {});
      expect(wallet.settleAfterVerifiedPayment).not.toHaveBeenCalled();
    });

    it('400s when the transaction id is missing', async () => {
      await expect(
        service.applyVerifiedOutcome(
          verification({ transactionId: null }),
          'WEBHOOK',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s for an unknown transaction id', async () => {
      await expect(
        service.applyVerifiedOutcome(
          verification({ transactionId: 'PFDOESNOTEXIST' }),
          'WEBHOOK',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('400s when the reported amount differs from the recorded amount', async () => {
      const payment = seedPayment({ amountPaise: 100_000 });
      await expect(
        service.applyVerifiedOutcome(
          verification({
            transactionId: payment.transactionId,
            amountPaise: 100,
          }),
          'WEBHOOK',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('does not credit the wallet on an amount mismatch', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      await service
        .applyVerifiedOutcome(
          verification({
            transactionId: payment.transactionId,
            amountPaise: 1,
          }),
          'WEBHOOK',
        )
        .catch(() => {});
      expect(wallet.settleAfterVerifiedPayment).not.toHaveBeenCalled();
      expect(db.creditRequests[0].status).toBe(
        WalletCreditRequestStatus.PENDING,
      );
    });

    it('tolerates a provider that omits the amount', async () => {
      const payment = seedPayment();
      const result = await service.applyVerifiedOutcome(
        verification({
          transactionId: payment.transactionId,
          amountPaise: null,
        }),
        'WEBHOOK',
      );
      expect(result.outcome).toBe('APPLIED');
    });

    it('ignores an unmapped provider status without changing state', async () => {
      const payment = seedPayment();
      const result = await service.applyVerifiedOutcome(
        verification({
          transactionId: payment.transactionId,
          status: null,
          rawStatus: 'something-new',
        }),
        'WEBHOOK',
      );
      expect(result.outcome).toBe('IGNORED');
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  SUCCESS + DUPLICATE PROTECTION
  // ══════════════════════════════════════════════════════════════════

  describe('applyVerifiedOutcome — success', () => {
    it('transitions PENDING -> SUCCESS and records provider details', async () => {
      const payment = seedPayment();
      const result = await service.applyVerifiedOutcome(
        verification({ transactionId: payment.transactionId }),
        'CALLBACK_SUCCESS',
      );

      expect(result.outcome).toBe('APPLIED');
      expect(result.status).toBe(PaymentTransactionStatus.SUCCESS);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.SUCCESS);
      expect(db.payments[0].providerPaymentId).toBe('PAYU1');
      expect(db.payments[0].completedAt).toBeInstanceOf(Date);
    });

    it('transitions PROCESSING -> SUCCESS', async () => {
      const payment = seedPayment({
        status: PaymentTransactionStatus.PROCESSING,
      });
      const result = await service.applyVerifiedOutcome(
        verification({ transactionId: payment.transactionId }),
        'WEBHOOK',
      );
      expect(result.outcome).toBe('APPLIED');
    });

    it('settles the wallet credit request exactly once', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      await service.applyVerifiedOutcome(
        verification({ transactionId: payment.transactionId }),
        'WEBHOOK',
      );
      expect(wallet.settleAfterVerifiedPayment).toHaveBeenCalledTimes(1);
      expect(wallet.settleAfterVerifiedPayment).toHaveBeenCalledWith(
        expect.anything(),
        cr.id,
      );
    });

    it('reports requiresAdminApproval for a first credit', async () => {
      wallet.settleAfterVerifiedPayment.mockResolvedValue({
        credited: false,
        requiresAdminApproval: true,
        status: WalletCreditRequestStatus.PENDING,
        balanceAfterPaise: null,
        transactionId: null,
      });
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });

      const result = await service.applyVerifiedOutcome(
        verification({ transactionId: payment.transactionId }),
        'WEBHOOK',
      );

      // Payment succeeded, wallet did not move: two distinct events.
      expect(result.status).toBe(PaymentTransactionStatus.SUCCESS);
      expect(result.walletCredited).toBe(false);
      expect(result.requiresAdminApproval).toBe(true);
      expect(result.creditRequestStatus).toBe(
        WalletCreditRequestStatus.PENDING,
      );
    });

    it('reports walletCredited for a subsequent auto-credited top-up', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      const result = await service.applyVerifiedOutcome(
        verification({ transactionId: payment.transactionId }),
        'WEBHOOK',
      );
      expect(result.walletCredited).toBe(true);
      expect(result.creditRequestStatus).toBe(
        WalletCreditRequestStatus.COMPLETED,
      );
    });

    it('treats a duplicate success as DUPLICATE and credits nothing', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      const v = verification({ transactionId: payment.transactionId });

      const first = await service.applyVerifiedOutcome(v, 'CALLBACK_SUCCESS');
      const second = await service.applyVerifiedOutcome(v, 'WEBHOOK');

      expect(first.outcome).toBe('APPLIED');
      expect(second.outcome).toBe('DUPLICATE');
      expect(second.walletCredited).toBe(false);
      // The single most important assertion in this module.
      expect(wallet.settleAfterVerifiedPayment).toHaveBeenCalledTimes(1);
    });

    it('stays idempotent across many replays', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      const v = verification({ transactionId: payment.transactionId });

      for (let i = 0; i < 5; i += 1) {
        await service.applyVerifiedOutcome(v, 'WEBHOOK');
      }
      expect(wallet.settleAfterVerifiedPayment).toHaveBeenCalledTimes(1);
    });

    it('does not re-settle an already SUCCESS payment', async () => {
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.COMPLETED,
      });
      const payment = seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
      });
      const result = await service.applyVerifiedOutcome(
        verification({ transactionId: payment.transactionId }),
        'WEBHOOK',
      );
      expect(result.outcome).toBe('DUPLICATE');
      expect(wallet.settleAfterVerifiedPayment).not.toHaveBeenCalled();
    });

    it('does not resurrect a FAILED payment into SUCCESS', async () => {
      const payment = seedPayment({ status: PaymentTransactionStatus.FAILED });
      const result = await service.applyVerifiedOutcome(
        verification({ transactionId: payment.transactionId }),
        'WEBHOOK',
      );
      expect(result.outcome).toBe('DUPLICATE');
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.FAILED);
    });

    it('records a success with no credit request without touching the wallet', async () => {
      const payment = seedPayment({ walletCreditRequestId: null });
      const result = await service.applyVerifiedOutcome(
        verification({ transactionId: payment.transactionId }),
        'WEBHOOK',
      );
      expect(result.outcome).toBe('APPLIED');
      expect(wallet.settleAfterVerifiedPayment).not.toHaveBeenCalled();
    });

    it('concurrent successes produce exactly one settlement', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      const v = verification({ transactionId: payment.transactionId });

      const results = await Promise.all([
        service.applyVerifiedOutcome(v, 'CALLBACK_SUCCESS'),
        service.applyVerifiedOutcome(v, 'WEBHOOK'),
      ]);

      expect(results.filter((r) => r.outcome === 'APPLIED')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'DUPLICATE')).toHaveLength(1);
      expect(wallet.settleAfterVerifiedPayment).toHaveBeenCalledTimes(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  FAILURE
  // ══════════════════════════════════════════════════════════════════

  describe('applyVerifiedOutcome — failure', () => {
    const failed = (transactionId: string) =>
      verification({
        transactionId,
        status: PaymentTransactionStatus.FAILED,
        rawStatus: 'failure',
        failureCode: 'E401',
        failureMessage: 'Card declined',
      });

    it('transitions PENDING -> FAILED and stores the failure detail', async () => {
      const payment = seedPayment();
      const result = await service.applyVerifiedOutcome(
        failed(payment.transactionId),
        'CALLBACK_FAILURE',
      );
      expect(result.status).toBe(PaymentTransactionStatus.FAILED);
      expect(db.payments[0].failureCode).toBe('E401');
      expect(db.payments[0].failureMessage).toBe('Card declined');
    });

    it('credits nothing on failure', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      await service.applyVerifiedOutcome(
        failed(payment.transactionId),
        'CALLBACK_FAILURE',
      );
      expect(wallet.settleAfterVerifiedPayment).not.toHaveBeenCalled();
      expect(wallet.creditConfirmedCashRequest).not.toHaveBeenCalled();
    });

    it('cancels the credit request so the pending slot is released', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      await service.applyVerifiedOutcome(
        failed(payment.transactionId),
        'CALLBACK_FAILURE',
      );
      expect(wallet.cancelCreditRequest).toHaveBeenCalledWith(
        expect.anything(),
        cr.id,
        'Online payment failed',
      );
    });

    it('treats a duplicate failure as DUPLICATE', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      await service.applyVerifiedOutcome(
        failed(payment.transactionId),
        'CALLBACK_FAILURE',
      );
      const second = await service.applyVerifiedOutcome(
        failed(payment.transactionId),
        'WEBHOOK',
      );
      expect(second.outcome).toBe('DUPLICATE');
      expect(wallet.cancelCreditRequest).toHaveBeenCalledTimes(1);
    });

    it('cannot downgrade a SUCCESS payment to FAILED', async () => {
      const payment = seedPayment({
        status: PaymentTransactionStatus.SUCCESS,
      });
      const result = await service.applyVerifiedOutcome(
        failed(payment.transactionId),
        'WEBHOOK',
      );
      expect(result.outcome).toBe('DUPLICATE');
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.SUCCESS);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  REFUND
  // ══════════════════════════════════════════════════════════════════

  describe('initiateRefundIfApplicable (admin-reject orchestration)', () => {
    it('returns refundInitiated=true when there is a settled ONLINE payment', async () => {
      provider.refundPayment.mockResolvedValue({
        accepted: true,
        providerRefundId: 'r-1',
        message: null,
      });
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
        providerPaymentId: 'PAYU1',
      });

      const result = await service.initiateRefundIfApplicable(cr.id);

      expect(result.refundInitiated).toBe(true);
      expect(provider.refundPayment).toHaveBeenCalledTimes(1);
      expect(db.payments[0].status).toBe(
        PaymentTransactionStatus.REFUND_PENDING,
      );
    });

    it('returns refundInitiated=false for a cash credit request (no PayU payment)', async () => {
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
        source: PaymentMethod.CASH,
      });

      const result = await service.initiateRefundIfApplicable(cr.id);

      expect(result.refundInitiated).toBe(false);
      expect(result.reason).toBe('NO_REFUNDABLE_PAYMENT');
      expect(provider.refundPayment).not.toHaveBeenCalled();
    });

    it('returns refundInitiated=false (not throw) when a refund is already in progress', async () => {
      provider.refundPayment.mockResolvedValue({
        accepted: true,
        providerRefundId: 'r-1',
        message: null,
      });
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
        providerPaymentId: 'PAYU1',
      });

      const first = await service.initiateRefundIfApplicable(cr.id);
      const second = await service.initiateRefundIfApplicable(cr.id);

      expect(first.refundInitiated).toBe(true);
      expect(second.refundInitiated).toBe(false);
      // On the second call the payment is already REFUND_PENDING, so the
      // "no refundable SUCCESS payment" branch wins — same outcome: the
      // provider is NOT called a second time.
      expect([
        'REFUND_ALREADY_IN_PROGRESS',
        'NO_REFUNDABLE_PAYMENT',
      ]).toContain(second.reason);
      expect(provider.refundPayment).toHaveBeenCalledTimes(1);
    });

    it('rethrows a genuine provider failure (does not swallow silently)', async () => {
      provider.refundPayment.mockRejectedValue(new Error('network down'));
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
        providerPaymentId: 'PAYU1',
      });

      await expect(service.initiateRefundIfApplicable(cr.id)).rejects.toThrow(
        'network down',
      );
    });
  });

  describe('refund', () => {
    const refunded = (transactionId: string) =>
      verification({
        transactionId,
        status: PaymentTransactionStatus.REFUNDED,
        rawStatus: 'refunded',
      });

    it('requires the credit request to be REJECTED', async () => {
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.PENDING,
      });
      await expect(
        service.initiateRefundForRejectedCreditRequest(cr.id),
      ).rejects.toThrow(ConflictException);
    });

    it('404s for an unknown credit request', async () => {
      await expect(
        service.initiateRefundForRejectedCreditRequest('nope'),
      ).rejects.toThrow(NotFoundException);
    });

    it('409s when there is no settled payment to refund', async () => {
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      await expect(
        service.initiateRefundForRejectedCreditRequest(cr.id),
      ).rejects.toThrow(ConflictException);
    });

    it('moves the payment to REFUND_PENDING and calls the provider', async () => {
      provider.refundPayment.mockResolvedValue({
        accepted: true,
        providerRefundId: '9988',
        message: 'queued',
      });
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      const payment = seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
        providerPaymentId: 'PAYU1',
      });

      const result = await service.initiateRefundForRejectedCreditRequest(
        cr.id,
      );

      expect(result.payment.status).toBe(
        PaymentTransactionStatus.REFUND_PENDING,
      );
      expect(db.payments[0].status).toBe(
        PaymentTransactionStatus.REFUND_PENDING,
      );
      expect(provider.refundPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          providerPaymentId: 'PAYU1',
          amountPaise: payment.amountPaise,
        }),
      );
    });

    it('does NOT mark the refund complete when it is merely requested', async () => {
      provider.refundPayment.mockResolvedValue({
        accepted: true,
        providerRefundId: '9988',
        message: null,
      });
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
        providerPaymentId: 'PAYU1',
      });

      await service.initiateRefundForRejectedCreditRequest(cr.id);

      expect(db.payments[0].status).not.toBe(PaymentTransactionStatus.REFUNDED);
      expect(wallet.markRefundOutcome).not.toHaveBeenCalled();
    });

    it('blocks a second concurrent refund attempt', async () => {
      provider.refundPayment.mockResolvedValue({
        accepted: true,
        providerRefundId: '1',
        message: null,
      });
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
        providerPaymentId: 'PAYU1',
      });

      await service.initiateRefundForRejectedCreditRequest(cr.id);
      await expect(
        service.initiateRefundForRejectedCreditRequest(cr.id),
      ).rejects.toThrow(ConflictException);
      expect(provider.refundPayment).toHaveBeenCalledTimes(1);
    });

    it('releases the claim when the provider rejects the refund', async () => {
      provider.refundPayment.mockResolvedValue({
        accepted: false,
        providerRefundId: null,
        message: 'Refund not allowed',
      });
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
        providerPaymentId: 'PAYU1',
      });

      await expect(
        service.initiateRefundForRejectedCreditRequest(cr.id),
      ).rejects.toThrow(ConflictException);
      // Retryable again, not stuck in REFUND_PENDING.
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.SUCCESS);
      expect(db.creditRequests[0].refundStatus).toBe('REFUND_FAILED');
    });

    it('releases the claim when the provider call throws', async () => {
      provider.refundPayment.mockRejectedValue(new Error('network down'));
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
        providerPaymentId: 'PAYU1',
      });

      await expect(
        service.initiateRefundForRejectedCreditRequest(cr.id),
      ).rejects.toThrow('network down');
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.SUCCESS);
    });

    it('409s when the provider payment reference is missing', async () => {
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
        providerPaymentId: null,
      });
      await expect(
        service.initiateRefundForRejectedCreditRequest(cr.id),
      ).rejects.toThrow(ConflictException);
    });

    it('marks REFUNDED only on a verified refund webhook', async () => {
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      const payment = seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.REFUND_PENDING,
      });

      const result = await service.applyVerifiedOutcome(
        refunded(payment.transactionId),
        'WEBHOOK',
      );

      expect(result.status).toBe(PaymentTransactionStatus.REFUNDED);
      expect(db.payments[0].refundedAt).toBeInstanceOf(Date);
      expect(wallet.markRefundOutcome).toHaveBeenCalledWith(
        expect.anything(),
        cr.id,
        'REFUNDED',
      );
    });

    it('accepts a refund webhook straight from SUCCESS', async () => {
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      const payment = seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
      });
      const result = await service.applyVerifiedOutcome(
        refunded(payment.transactionId),
        'WEBHOOK',
      );
      expect(result.outcome).toBe('APPLIED');
    });

    it('treats a duplicate refund webhook as DUPLICATE', async () => {
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.REJECTED,
      });
      const payment = seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.REFUND_PENDING,
      });

      await service.applyVerifiedOutcome(
        refunded(payment.transactionId),
        'WEBHOOK',
      );
      const second = await service.applyVerifiedOutcome(
        refunded(payment.transactionId),
        'WEBHOOK',
      );

      expect(second.outcome).toBe('DUPLICATE');
      expect(wallet.markRefundOutcome).toHaveBeenCalledTimes(1);
    });

    it('rejects a refund webhook with an invalid signature', async () => {
      const payment = seedPayment({
        status: PaymentTransactionStatus.REFUND_PENDING,
      });
      await expect(
        service.applyVerifiedOutcome(
          { ...refunded(payment.transactionId), signatureValid: false },
          'WEBHOOK',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  PROCESSING
  // ══════════════════════════════════════════════════════════════════

  describe('applyVerifiedOutcome — processing', () => {
    it('moves PENDING -> PROCESSING and credits nothing', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      const result = await service.applyVerifiedOutcome(
        verification({
          transactionId: payment.transactionId,
          status: PaymentTransactionStatus.PROCESSING,
          rawStatus: 'pending',
        }),
        'WEBHOOK',
      );
      expect(result.outcome).toBe('APPLIED');
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PROCESSING);
      expect(wallet.settleAfterVerifiedPayment).not.toHaveBeenCalled();
    });

    it('does not downgrade SUCCESS back to PROCESSING', async () => {
      const payment = seedPayment({
        status: PaymentTransactionStatus.SUCCESS,
      });
      const result = await service.applyVerifiedOutcome(
        verification({
          transactionId: payment.transactionId,
          status: PaymentTransactionStatus.PROCESSING,
        }),
        'WEBHOOK',
      );
      expect(result.outcome).toBe('DUPLICATE');
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.SUCCESS);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  RETRY
  // ══════════════════════════════════════════════════════════════════

  describe('retryPayment', () => {
    it('creates a new payment with a new transaction id', async () => {
      const cr = seedCreditRequest();
      const old = seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.FAILED,
      });

      const result = await service.retryPayment(
        USER_ID,
        { transactionId: old.transactionId },
        'retry-1',
      );

      expect(result.payment.transactionId).not.toBe(old.transactionId);
      expect(db.payments).toHaveLength(2);
      expect(result.payment.status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('takes the amount from the credit request, not the client', async () => {
      const cr = seedCreditRequest({ amountPaise: 55_000 });
      const old = seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.FAILED,
        amountPaise: 100_000,
      });

      const result = await service.retryPayment(
        USER_ID,
        { transactionId: old.transactionId },
        'retry-1',
      );
      expect(result.payment.amountPaise).toBe(55_000);
    });

    it('refuses to retry a SUCCESS payment', async () => {
      const cr = seedCreditRequest();
      const old = seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.SUCCESS,
      });
      await expect(
        service.retryPayment(
          USER_ID,
          { transactionId: old.transactionId },
          'retry-1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('refuses to retry a PENDING payment', async () => {
      const cr = seedCreditRequest();
      const old = seedPayment({ walletCreditRequestId: cr.id });
      await expect(
        service.retryPayment(
          USER_ID,
          { transactionId: old.transactionId },
          'retry-1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('refuses when the credit request is no longer PENDING', async () => {
      const cr = seedCreditRequest({
        status: WalletCreditRequestStatus.CANCELLED,
      });
      const old = seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.FAILED,
      });
      await expect(
        service.retryPayment(
          USER_ID,
          { transactionId: old.transactionId },
          'retry-1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it("cannot retry another customer's payment", async () => {
      const cr = seedCreditRequest();
      const old = seedPayment({
        userId: 'someone-else',
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.FAILED,
      });
      await expect(
        service.retryPayment(
          USER_ID,
          { transactionId: old.transactionId },
          'retry-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('is idempotent on the retry idempotency key', async () => {
      const cr = seedCreditRequest();
      const old = seedPayment({
        walletCreditRequestId: cr.id,
        status: PaymentTransactionStatus.FAILED,
      });
      const first = await service.retryPayment(
        USER_ID,
        { transactionId: old.transactionId },
        'retry-1',
      );
      const second = await service.retryPayment(
        USER_ID,
        { transactionId: old.transactionId },
        'retry-1',
      );
      expect(second.payment.id).toBe(first.payment.id);
      expect(db.payments).toHaveLength(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  VERIFY ENDPOINT
  // ══════════════════════════════════════════════════════════════════

  describe('verifyPayment', () => {
    it("404s for another customer's transaction", async () => {
      const payment = seedPayment({ userId: 'someone-else' });
      await expect(
        service.verifyPayment(USER_ID, {
          transactionId: payment.transactionId,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s for an unknown transaction', async () => {
      await expect(
        service.verifyPayment(USER_ID, { transactionId: 'PFNOPE' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('applies an authoritative success fetched from the provider', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      provider.fetchAuthoritativeStatus.mockResolvedValue({
        status: PaymentTransactionStatus.SUCCESS,
        rawStatus: 'success',
        providerPaymentId: 'PAYU1',
        amountPaise: payment.amountPaise,
      });

      const result = await service.verifyPayment(USER_ID, {
        transactionId: payment.transactionId,
      });

      expect(result.payment.status).toBe(PaymentTransactionStatus.SUCCESS);
      expect(result.walletCredited).toBe(true);
    });

    it('ignores a client-claimed status entirely', async () => {
      const payment = seedPayment();
      provider.fetchAuthoritativeStatus.mockResolvedValue({
        status: PaymentTransactionStatus.FAILED,
        rawStatus: 'failure',
        providerPaymentId: null,
        amountPaise: payment.amountPaise,
      });

      // The DTO has no status field; the provider says FAILED and that wins.
      const result = await service.verifyPayment(USER_ID, {
        transactionId: payment.transactionId,
      });
      expect(result.payment.status).toBe(PaymentTransactionStatus.FAILED);
    });

    it('leaves state untouched when the provider has nothing actionable', async () => {
      const payment = seedPayment();
      provider.fetchAuthoritativeStatus.mockResolvedValue({
        status: null,
        rawStatus: null,
        providerPaymentId: null,
        amountPaise: null,
      });
      const result = await service.verifyPayment(USER_ID, {
        transactionId: payment.transactionId,
      });
      expect(result.payment.status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('rejects an authoritative response whose amount disagrees', async () => {
      const payment = seedPayment({ amountPaise: 100_000 });
      provider.fetchAuthoritativeStatus.mockResolvedValue({
        status: PaymentTransactionStatus.SUCCESS,
        rawStatus: 'success',
        providerPaymentId: 'PAYU1',
        amountPaise: 1,
      });
      await expect(
        service.verifyPayment(USER_ID, {
          transactionId: payment.transactionId,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  CASH CONFIRMATION / CANCELLATION
  // ══════════════════════════════════════════════════════════════════

  describe('confirmCashCollection', () => {
    function seedCash(status = CashCollectionStatus.PENDING) {
      const cr = seedCreditRequest({ source: PaymentMethod.CASH });
      const row = {
        id: randomUUID(),
        userId: USER_ID,
        walletCreditRequestId: cr.id,
        amountPaise: 100_000,
        status,
        collectedAt: null,
        confirmedAt: null,
        confirmedByAdminId: null,
        adminNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      db.cashCollections.push(row);
      return { cash: row, creditRequest: cr };
    }

    it('confirms a PENDING collection and credits the wallet', async () => {
      const { cash, creditRequest } = seedCash();
      const result = await service.confirmCashCollection(
        cash.id,
        'admin-1',
        {},
      );

      expect(result.cashCollection.status).toBe(CashCollectionStatus.CONFIRMED);
      expect(db.cashCollections[0].confirmedByAdminId).toBe('admin-1');
      expect(wallet.creditConfirmedCashRequest).toHaveBeenCalledWith(
        expect.anything(),
        creditRequest.id,
        'admin-1',
      );
    });

    it('confirms a COLLECTED collection', async () => {
      const { cash } = seedCash(CashCollectionStatus.COLLECTED);
      await expect(
        service.confirmCashCollection(cash.id, 'admin-1', {}),
      ).resolves.toBeDefined();
    });

    it('records the confirming admin from the argument, never the body', async () => {
      const { cash } = seedCash();
      // The DTO type has no adminId; an extra field has no effect.
      await service.confirmCashCollection(cash.id, 'admin-1', {
        note: 'counted',
        adminId: 'attacker',
      } as any);
      expect(db.cashCollections[0].confirmedByAdminId).toBe('admin-1');
    });

    it('rejects a duplicate confirmation and credits only once', async () => {
      const { cash } = seedCash();
      await service.confirmCashCollection(cash.id, 'admin-1', {});
      await expect(
        service.confirmCashCollection(cash.id, 'admin-2', {}),
      ).rejects.toThrow(ConflictException);
      expect(wallet.creditConfirmedCashRequest).toHaveBeenCalledTimes(1);
    });

    it('concurrent confirmations credit exactly once', async () => {
      const { cash } = seedCash();
      const results = await Promise.allSettled([
        service.confirmCashCollection(cash.id, 'admin-1', {}),
        service.confirmCashCollection(cash.id, 'admin-2', {}),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(wallet.creditConfirmedCashRequest).toHaveBeenCalledTimes(1);
    });

    it('404s for an unknown collection', async () => {
      await expect(
        service.confirmCashCollection('nope', 'admin-1', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('cannot confirm a CANCELLED collection', async () => {
      const { cash } = seedCash(CashCollectionStatus.CANCELLED);
      await expect(
        service.confirmCashCollection(cash.id, 'admin-1', {}),
      ).rejects.toThrow(ConflictException);
      expect(wallet.creditConfirmedCashRequest).not.toHaveBeenCalled();
    });

    it('cancellation credits nothing and cancels the credit request', async () => {
      const { cash, creditRequest } = seedCash();
      const result = await service.cancelCashCollection(cash.id, 'admin-1', {
        note: 'customer not home',
      });

      expect(result.cashCollection.status).toBe(CashCollectionStatus.CANCELLED);
      expect(wallet.creditConfirmedCashRequest).not.toHaveBeenCalled();
      expect(wallet.cancelCreditRequest).toHaveBeenCalledWith(
        expect.anything(),
        creditRequest.id,
        'customer not home',
      );
    });

    it('cannot cancel an already CONFIRMED collection', async () => {
      const { cash } = seedCash(CashCollectionStatus.CONFIRMED);
      await expect(
        service.cancelCashCollection(cash.id, 'admin-1', { note: 'too late' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  EXPIRY SWEEP
  // ══════════════════════════════════════════════════════════════════

  describe('expireStalePayments', () => {
    it('expires an overdue PENDING payment and releases its credit request', async () => {
      const cr = seedCreditRequest();
      seedPayment({
        walletCreditRequestId: cr.id,
        expiresAt: new Date(Date.now() - 1000),
      });

      const result = await service.expireStalePayments();

      expect(result.expired).toBe(1);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.EXPIRED);
      expect(wallet.cancelCreditRequest).toHaveBeenCalledWith(
        expect.anything(),
        cr.id,
        'Online payment expired before completion',
      );
    });

    it('leaves a payment that has not expired alone', async () => {
      seedPayment({ expiresAt: new Date(Date.now() + 600_000) });
      const result = await service.expireStalePayments();
      expect(result.expired).toBe(0);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('never expires a SUCCESS payment', async () => {
      seedPayment({
        status: PaymentTransactionStatus.SUCCESS,
        expiresAt: new Date(Date.now() - 1000),
      });
      const result = await service.expireStalePayments();
      expect(result.expired).toBe(0);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.SUCCESS);
    });

    it('is idempotent across repeated sweeps', async () => {
      const cr = seedCreditRequest();
      seedPayment({
        walletCreditRequestId: cr.id,
        expiresAt: new Date(Date.now() - 1000),
      });
      await service.expireStalePayments();
      const second = await service.expireStalePayments();
      expect(second.expired).toBe(0);
      expect(wallet.cancelCreditRequest).toHaveBeenCalledTimes(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  READ SCOPING
  // ══════════════════════════════════════════════════════════════════

  describe('customer reads', () => {
    it("lists only the authenticated customer's payments", async () => {
      seedPayment();
      seedPayment({ userId: 'someone-else' });

      const result = await service.getCustomerPayments(USER_ID, {});
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });

    it('never exposes the idempotency key or request hash', async () => {
      seedPayment();
      const result = await service.getCustomerPayments(USER_ID, {});
      expect(result.data[0]).not.toHaveProperty('idempotencyKey');
      expect(result.data[0]).not.toHaveProperty('requestHash');
      expect(result.data[0]).not.toHaveProperty('providerResponse');
    });

    it("404s when fetching another customer's payment by id", async () => {
      const other = seedPayment({ userId: 'someone-else' });
      await expect(
        service.getCustomerPayment(USER_ID, other.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('surfaces the wallet credit state alongside the payment', async () => {
      const cr = seedCreditRequest();
      const payment = seedPayment({ walletCreditRequestId: cr.id });
      const result = await service.getCustomerPayment(USER_ID, payment.id);
      expect(result.walletCredit?.status).toBe(
        WalletCreditRequestStatus.PENDING,
      );
    });
  });

  describe('admin reads', () => {
    it('404s for an unknown payment', async () => {
      await expect(service.getAdminPayment('nope')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s for an unknown cash collection', async () => {
      await expect(service.getAdminCashCollection('nope')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lists payments across all customers', async () => {
      seedPayment();
      seedPayment({ userId: 'someone-else' });
      const result = await service.getAdminPayments({});
      expect(result.data).toHaveLength(2);
    });

    it('exposes no endpoint to set a payment status', () => {
      // Structural guarantee: nothing on the service marks a payment
      // successful outside the verified-provider state machine.
      const methods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(service),
      );
      expect(methods).not.toContain('markPaymentSuccess');
      expect(methods).not.toContain('updatePaymentStatus');
      expect(
        methods.filter((m) => /markSuccess|forceSuccess/i.test(m)),
      ).toEqual([]);
    });
  });
});
