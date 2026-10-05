// @nestjs/config and @nestjs/jwt ship ESM-only; mock them so the CommonJS test
// runner can load the JwtAuthGuard. Behaviour is supplied per-test below.
jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock('@nestjs/jwt', () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PaymentsController } from './payments.controller';
import { AdminPaymentsController } from './admin-payments.controller';
import { PayuCallbackController } from './payu-callback.controller';
import { PayuWebhookController } from './webhook/payu-webhook.controller';
import { PayuWebhookService } from './webhook/payu-webhook.service';
import { PaymentsService } from './payments.service';
import { PayuService } from './providers/payu/payu.service';
import { PayuHashService } from './providers/payu/payu.hash.service';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletCreditRequestStatus } from '../wallet/wallet.constants';
import {
  CashCollectionStatus,
  PaymentMethod,
  PaymentTransactionStatus,
} from './payments.constants';

type Row = Record<string, any>;

const KEY = 'testmerchantkey';
const SALT = 'testmerchantsalt';
const API_BASE = 'https://api.example.com';
const REDIRECT = 'https://app.example.com/payment/result';

/**
 * HTTP-level integration for the payment module.
 *
 * Runs the REAL JwtAuthGuard (so RBAC is genuinely exercised), the REAL global
 * ValidationPipe as configured in main.ts, all four REAL controllers, the REAL
 * PaymentsService and the REAL PayU provider and hash service over an
 * in-memory Prisma double. Only the wallet (whose own suite covers it), the
 * PayU network client and token verification are stubbed.
 */
describe('Payments HTTP integration', () => {
  let app: INestApplication;
  let hashService: PayuHashService;

  const CUST1 = 'cust-1';
  const CUST2 = 'cust-2';
  const ADMIN_ID = 'admin-1';

  const db = {
    payments: [] as Row[],
    cashCollections: [] as Row[],
    creditRequests: [] as Row[],
  };

  const users: Row[] = [
    {
      id: CUST1,
      mobile: '9876543210',
      email: 'asha@example.com',
      customerProfile: { firstName: 'Asha', lastName: 'K' },
    },
    {
      id: CUST2,
      mobile: '9000000000',
      email: 'ravi@example.com',
      customerProfile: { firstName: 'Ravi', lastName: 'S' },
    },
  ];

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([field, condition]) => {
      if (condition && typeof condition === 'object') {
        if ('in' in condition) {
          return (condition.in as unknown[]).includes(row[field]);
        }
        const value = row[field];
        return Object.entries(condition as Record<string, any>).every(
          ([op, operand]) =>
            op === 'lt'
              ? value < operand
              : op === 'gte'
                ? value >= operand
                : true,
        );
      }
      return row[field] === condition;
    });

  const hydrate = (row: Row, include?: Row) => {
    const out: Row = { ...row };
    if (include?.user) out.user = users.find((u) => u.id === row.userId);
    if (include?.walletCreditRequest) {
      const cr = db.creditRequests.find(
        (r) => r.id === row.walletCreditRequestId,
      );
      out.walletCreditRequest = cr ? { ...cr, transaction: null } : null;
    }
    return out;
  };

  const sessions: Record<string, Row> = {
    'sess-admin': { id: 'sess-admin', adminId: ADMIN_ID, userId: null },
    'sess-c1': { id: 'sess-c1', userId: CUST1, adminId: null },
    'sess-c2': { id: 'sess-c2', userId: CUST2, adminId: null },
  };
  for (const s of Object.values(sessions)) {
    Object.assign(s, {
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  }

  const tokens: Record<string, Row> = {
    'admin-token': {
      sub: ADMIN_ID,
      role: 'ADMIN',
      sessionId: 'sess-admin',
      type: 'access',
    },
    'cust1-token': {
      sub: CUST1,
      role: 'CUSTOMER',
      sessionId: 'sess-c1',
      type: 'access',
    },
    'cust2-token': {
      sub: CUST2,
      role: 'CUSTOMER',
      sessionId: 'sess-c2',
      type: 'access',
    },
  };

  const ADMIN = { Authorization: 'Bearer admin-token' };
  const AS_CUST1 = { Authorization: 'Bearer cust1-token' };
  const AS_CUST2 = { Authorization: 'Bearer cust2-token' };

  const prisma: any = {
    session: {
      findUnique: async ({ where }: any) => sessions[where.id] ?? null,
    },
    user: {
      findUnique: async ({ where }: any) =>
        users.find((u) => u.id === where.id) ?? null,
    },
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
          createdAt: now,
          updatedAt: now,
          ...data,
        };
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
        return row ? hydrate(row, include) : null;
      },
      findUniqueOrThrow: async (args: any) => {
        const row = await prisma.payment.findUnique(args);
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
        Object.assign(row, data);
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
        return row ? hydrate(row, include) : null;
      },
      findUniqueOrThrow: async (args: any) => {
        const row = await prisma.cashCollection.findUnique(args);
        if (!row) throw new Error('cash collection not found');
        return row;
      },
      findMany: async ({ where = {}, include }: any) =>
        db.cashCollections
          .filter((c) => matches(c, where))
          .map((c) => hydrate(c, include)),
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
    $transaction: async (cb: any) => cb(prisma),
  };

  /** Minimal wallet double; the real wallet has its own suite. */
  const walletCalls = {
    settle: 0,
    cashCredit: 0,
    cancel: 0,
  };
  let settleResult = {
    credited: true,
    requiresAdminApproval: false,
    status: WalletCreditRequestStatus.COMPLETED,
    balanceAfterPaise: 100_000,
    transactionId: 'txn-1',
  };

  const wallet: Partial<WalletService> = {
    validateCreditAmount: (amountPaise: number) => {
      if (amountPaise < 100) {
        const { BadRequestException } = require('@nestjs/common');
        throw new BadRequestException({ error: 'INVALID_CREDIT_AMOUNT' });
      }
    },
    createPaymentBackedCreditRequest: (async (_tx: any, params: any) => {
      const existing = db.creditRequests.find(
        (r) => r.idempotencyKey === params.idempotencyKey,
      );
      if (existing) {
        return { request: existing, walletId: 'wallet-1', replayed: true };
      }
      const row = {
        id: randomUUID(),
        walletId: 'wallet-1',
        amountPaise: params.amountPaise,
        status: WalletCreditRequestStatus.PENDING,
        refundStatus: 'NOT_REQUIRED',
        autoApproved: false,
        source: params.source,
        idempotencyKey: params.idempotencyKey,
        requestHash: `amount:${params.amountPaise}`,
        adminNote: null,
        completedAt: null,
      };
      db.creditRequests.push(row);
      return { request: row, walletId: 'wallet-1', replayed: false };
    }) as any,
    settleAfterVerifiedPayment: async () => {
      walletCalls.settle += 1;
      return settleResult;
    },
    creditConfirmedCashRequest: (async (_tx: any, id: string) => {
      walletCalls.cashCredit += 1;
      const cr = db.creditRequests.find((r) => r.id === id)!;
      cr.status = WalletCreditRequestStatus.COMPLETED;
      return {
        success: true,
        message: 'ok',
        request: { id, status: 'COMPLETED', amountPaise: cr.amountPaise },
      };
    }) as any,
    cancelCreditRequest: (async (_tx: any, id: string) => {
      walletCalls.cancel += 1;
      const cr = db.creditRequests.find((r) => r.id === id);
      if (cr && cr.status === WalletCreditRequestStatus.PENDING) {
        cr.status = WalletCreditRequestStatus.CANCELLED;
        return true;
      }
      return false;
    }) as any,
    markRefundOutcome: async () => undefined,
  };

  const payuClient = {
    verifyPayment: jest.fn(),
    refund: jest.fn(),
  };

  const env: Record<string, string> = {
    PAYU_KEY: KEY,
    PAYU_SALT: SALT,
    PUBLIC_API_BASE_URL: API_BASE,
    PAYMENT_RESULT_REDIRECT_URL: REDIRECT,
    JWT_ACCESS_SECRET: 'test-secret',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        PaymentsController,
        AdminPaymentsController,
        PayuCallbackController,
        PayuWebhookController,
      ],
      providers: [
        PaymentsService,
        PayuWebhookService,
        PayuHashService,
        PayuService,
        { provide: 'PayuClient', useValue: payuClient },
        { provide: PAYMENT_PROVIDER, useExisting: PayuService },
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: wallet },
        {
          provide: JwtService,
          useValue: {
            verifyAsync: async (token: string) => {
              if (!tokens[token]) throw new Error('invalid signature');
              return tokens[token];
            },
          },
        },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    })
      // PayuService takes PayuClient by class; supply the stub in its place.
      .overrideProvider(PayuService)
      .useFactory({
        factory: (config: any, hash: PayuHashService) =>
          new PayuService(config, hash, payuClient as any),
        inject: [ConfigService, PayuHashService],
      })
      .compile();

    app = moduleRef.createNestApplication();
    // Exactly the pipe configured in main.ts.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    hashService = moduleRef.get(PayuHashService);
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    db.payments = [];
    db.cashCollections = [];
    db.creditRequests = [];
    walletCalls.settle = 0;
    walletCalls.cashCredit = 0;
    walletCalls.cancel = 0;
    settleResult = {
      credited: true,
      requiresAdminApproval: false,
      status: WalletCreditRequestStatus.COMPLETED,
      balanceAfterPaise: 100_000,
      transactionId: 'txn-1',
    };
    payuClient.verifyPayment.mockReset();
    payuClient.refund.mockReset();
  });

  const http = () => request(app.getHttpServer());

  const createOnline = (headers: Row, body: Row = {}, key = 'idem-1') =>
    http()
      .post('/api/v1/customer/payments/create')
      .set(headers)
      .set('Idempotency-Key', key)
      .send({ amount: 100_000, paymentMethod: 'ONLINE', ...body });

  /** Signs a PayU callback payload the way PayU would. */
  const signed = (payload: Row) => ({
    ...payload,
    hash: hashService.generateReverseHash(payload),
  });

  const callbackPayload = (txnid: string, status = 'success') => ({
    key: KEY,
    txnid,
    amount: '1000.00',
    productinfo: 'PuretyFarm Wallet Top-up',
    firstname: 'Asha',
    email: 'asha@example.com',
    status,
    mihpayid: 'PAYU123456',
  });

  // ══════════════════════════════════════════════════════════════════
  //  AUTHENTICATION
  // ══════════════════════════════════════════════════════════════════

  describe('authentication', () => {
    it('401s payment creation without a token', async () => {
      await http()
        .post('/api/v1/customer/payments/create')
        .set('Idempotency-Key', 'k')
        .send({ amount: 100_000, paymentMethod: 'ONLINE' })
        .expect(401);
    });

    it('401s with a malformed Authorization header', async () => {
      await createOnline({ Authorization: 'cust1-token' }).expect(401);
    });

    it('401s with an unknown token', async () => {
      await createOnline({ Authorization: 'Bearer nope' }).expect(401);
    });

    it('401s listing payments without a token', async () => {
      await http().get('/api/v1/customer/payments').expect(401);
    });

    it('401s the admin payment list without a token', async () => {
      await http().get('/api/v1/admin/payments').expect(401);
    });

    it('401s a revoked session', async () => {
      sessions['sess-c2'].revokedAt = new Date();
      await createOnline(AS_CUST2).expect(401);
      sessions['sess-c2'].revokedAt = null;
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  RBAC
  // ══════════════════════════════════════════════════════════════════

  describe('RBAC', () => {
    it('blocks a customer from the admin payment list', async () => {
      await http().get('/api/v1/admin/payments').set(AS_CUST1).expect(403);
    });

    it('blocks a customer from the admin cash-collection list', async () => {
      await http()
        .get('/api/v1/admin/payments/cash-collections')
        .set(AS_CUST1)
        .expect(403);
    });

    it('blocks a customer from confirming a cash collection', async () => {
      await http()
        .post('/api/v1/admin/payments/cash-collections/some-id/confirm')
        .set(AS_CUST1)
        .send({})
        .expect(403);
    });

    it('blocks a customer from triggering a refund', async () => {
      await http()
        .post('/api/v1/admin/payments/credit-requests/some-id/refund')
        .set(AS_CUST1)
        .expect(403);
    });

    it('blocks an admin from the customer payment-creation route', async () => {
      await createOnline(ADMIN).expect(403);
    });

    it('blocks an admin from the customer payment list', async () => {
      await http().get('/api/v1/customer/payments').set(ADMIN).expect(403);
    });

    it('allows an admin on admin routes', async () => {
      await http().get('/api/v1/admin/payments').set(ADMIN).expect(200);
    });

    it('allows a customer on customer routes', async () => {
      await createOnline(AS_CUST1).expect(201);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  PAYMENT CREATION OVER HTTP
  // ══════════════════════════════════════════════════════════════════

  describe('POST /customer/payments/create', () => {
    it('creates a payment and returns checkout fields', async () => {
      const res = await createOnline(AS_CUST1).expect(201);

      expect(res.body.payment.status).toBe(PaymentTransactionStatus.PENDING);
      expect(res.body.checkout.endpoint).toBe(
        'https://secure.payu.in/_payment',
      );
      expect(res.body.checkout.fields.hash).toMatch(/^[0-9a-f]{128}$/);
      expect(res.body.checkout.fields.amount).toBe('1000.00');
    });

    it('never returns the salt in the response', async () => {
      const res = await createOnline(AS_CUST1).expect(201);
      expect(JSON.stringify(res.body)).not.toContain(SALT);
    });

    it('never returns the idempotency key or request hash', async () => {
      const res = await createOnline(AS_CUST1).expect(201);
      expect(res.body.payment.idempotencyKey).toBeUndefined();
      expect(res.body.payment.requestHash).toBeUndefined();
    });

    it('builds surl and furl from server configuration', async () => {
      const res = await createOnline(AS_CUST1).expect(201);
      expect(res.body.checkout.fields.surl).toBe(
        `${API_BASE}/api/v1/payments/payu/success`,
      );
    });

    it('400s without an Idempotency-Key header', async () => {
      await http()
        .post('/api/v1/customer/payments/create')
        .set(AS_CUST1)
        .send({ amount: 100_000, paymentMethod: 'ONLINE' })
        .expect(400);
    });

    it('400s on a non-integer amount', async () => {
      await createOnline(AS_CUST1, { amount: 10.5 }).expect(400);
    });

    it('400s on a zero or negative amount', async () => {
      await createOnline(AS_CUST1, { amount: 0 }).expect(400);
      await createOnline(AS_CUST1, { amount: -5000 }, 'idem-2').expect(400);
    });

    it('400s on a missing amount', async () => {
      await http()
        .post('/api/v1/customer/payments/create')
        .set(AS_CUST1)
        .set('Idempotency-Key', 'k')
        .send({ paymentMethod: 'ONLINE' })
        .expect(400);
    });

    it('400s on an unknown payment method', async () => {
      await createOnline(AS_CUST1, { paymentMethod: 'CRYPTO' }).expect(400);
    });

    it('400s on an amount below the wallet minimum', async () => {
      await createOnline(AS_CUST1, { amount: 50 }).expect(400);
    });

    it('ignores an injected userId and uses JWT.sub', async () => {
      // whitelist: true strips the unknown field; the payment must belong to
      // the authenticated customer regardless.
      const res = await createOnline(AS_CUST1, { userId: CUST2 }).expect(201);
      const stored = db.payments.find((p) => p.id === res.body.payment.id);
      expect(stored?.userId).toBe(CUST1);
    });

    it('ignores an injected status', async () => {
      const res = await createOnline(AS_CUST1, {
        status: 'SUCCESS',
      }).expect(201);
      expect(res.body.payment.status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('ignores an injected transactionId and generates one server-side', async () => {
      const res = await createOnline(AS_CUST1, {
        transactionId: 'ATTACKER-TXN',
      }).expect(201);
      expect(res.body.payment.transactionId).not.toBe('ATTACKER-TXN');
      expect(res.body.payment.transactionId).toMatch(/^PF/);
    });

    it('replays the same payment for a repeated idempotency key', async () => {
      const first = await createOnline(AS_CUST1, {}, 'same-key').expect(201);
      const second = await createOnline(AS_CUST1, {}, 'same-key').expect(201);
      expect(second.body.payment.id).toBe(first.body.payment.id);
      expect(db.payments).toHaveLength(1);
    });

    it('409s on the same key with a different amount', async () => {
      await createOnline(AS_CUST1, {}, 'same-key').expect(201);
      await createOnline(AS_CUST1, { amount: 50_000 }, 'same-key').expect(409);
    });

    it('creates a cash collection and NO payment for CASH', async () => {
      const res = await http()
        .post('/api/v1/customer/payments/create')
        .set(AS_CUST1)
        .set('Idempotency-Key', 'cash-1')
        .send({ amount: 100_000, paymentMethod: 'CASH' })
        .expect(201);

      expect(res.body.cashCollection.status).toBe(CashCollectionStatus.PENDING);
      expect(res.body.checkout).toBeUndefined();
      expect(db.payments).toHaveLength(0);
      expect(db.cashCollections).toHaveLength(1);
      expect(walletCalls.cashCredit).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER ISOLATION
  // ══════════════════════════════════════════════════════════════════

  describe('customer isolation', () => {
    it("lists only the caller's own payments", async () => {
      await createOnline(AS_CUST1, {}, 'c1').expect(201);
      await createOnline(AS_CUST2, {}, 'c2').expect(201);

      const res = await http()
        .get('/api/v1/customer/payments')
        .set(AS_CUST1)
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.pagination.total).toBe(1);
    });

    it("404s when reading another customer's payment by id", async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      await http()
        .get(`/api/v1/customer/payments/${created.body.payment.id}`)
        .set(AS_CUST2)
        .expect(404);
    });

    it("404s when verifying another customer's transaction", async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      await http()
        .post('/api/v1/customer/payments/verify')
        .set(AS_CUST2)
        .send({ transactionId: created.body.payment.transactionId })
        .expect(404);
    });

    it("404s when retrying another customer's payment", async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      db.payments[0].status = PaymentTransactionStatus.FAILED;
      await http()
        .post('/api/v1/customer/payments/retry')
        .set(AS_CUST2)
        .set('Idempotency-Key', 'r1')
        .send({ transactionId: created.body.payment.transactionId })
        .expect(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  PAYU CALLBACKS (PUBLIC)
  // ══════════════════════════════════════════════════════════════════

  describe('PayU callbacks', () => {
    it('the success callback needs no JWT', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;

      const res = await http()
        .post('/api/v1/payments/payu/success')
        .send(signed(callbackPayload(txnid)))
        .expect(302);

      expect(res.headers.location).toContain(REDIRECT);
    });

    it('a verified success settles the payment', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;

      await http()
        .post('/api/v1/payments/payu/success')
        .send(signed(callbackPayload(txnid)))
        .expect(302);

      expect(db.payments[0].status).toBe(PaymentTransactionStatus.SUCCESS);
      expect(walletCalls.settle).toBe(1);
    });

    it('hitting /success with an UNSIGNED payload changes nothing', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;

      // The route name carries no authority: only the hash does.
      const res = await http()
        .post('/api/v1/payments/payu/success')
        .send(callbackPayload(txnid))
        .expect(302);

      expect(res.headers.location).toContain('result=error');
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
      expect(walletCalls.settle).toBe(0);
    });

    it('a signed FAILURE posted to /success is recorded as a failure, not a success', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;

      await http()
        .post('/api/v1/payments/payu/success')
        .send(signed(callbackPayload(txnid, 'failure')))
        .expect(302);

      expect(db.payments[0].status).toBe(PaymentTransactionStatus.FAILED);
      expect(walletCalls.settle).toBe(0);
    });

    it('the failure callback marks the payment FAILED and credits nothing', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;

      await http()
        .post('/api/v1/payments/payu/failure')
        .send(signed(callbackPayload(txnid, 'failure')))
        .expect(302);

      expect(db.payments[0].status).toBe(PaymentTransactionStatus.FAILED);
      expect(walletCalls.settle).toBe(0);
      expect(db.creditRequests[0].status).toBe(
        WalletCreditRequestStatus.CANCELLED,
      );
    });

    it('an invalid-hash failure callback changes nothing', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;

      await http()
        .post('/api/v1/payments/payu/failure')
        .send({ ...callbackPayload(txnid, 'failure'), hash: 'bad' })
        .expect(302);

      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('never leaks the salt or the hash into the redirect URL', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;

      const res = await http()
        .post('/api/v1/payments/payu/success')
        .send(signed(callbackPayload(txnid)))
        .expect(302);

      expect(res.headers.location).not.toContain(SALT);
      expect(res.headers.location).not.toMatch(/hash=/);
      expect(res.headers.location).not.toMatch(/amount=/);
    });

    it('redirects only to the configured URL, never one from the payload', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;

      const res = await http()
        .post('/api/v1/payments/payu/success')
        .send({
          ...signed(callbackPayload(txnid)),
          surl: 'https://evil.example.com/steal',
        })
        .expect(302);

      expect(res.headers.location.startsWith(REDIRECT)).toBe(true);
      expect(res.headers.location).not.toContain('evil.example.com');
    });

    it('signals awaiting_approval when the wallet withholds the credit', async () => {
      settleResult = {
        credited: false,
        requiresAdminApproval: true,
        status: WalletCreditRequestStatus.PENDING,
        balanceAfterPaise: null as any,
        transactionId: null as any,
      };
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;

      const res = await http()
        .post('/api/v1/payments/payu/success')
        .send(signed(callbackPayload(txnid)))
        .expect(302);

      expect(res.headers.location).toContain('result=awaiting_approval');
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.SUCCESS);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  PAYU WEBHOOK (PUBLIC)
  // ══════════════════════════════════════════════════════════════════

  describe('POST /api/v1/payments/webhooks/payu', () => {
    const post = (payload: Row) =>
      http().post('/api/v1/payments/webhooks/payu').send(payload);

    it('needs no JWT', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      await post(
        signed(callbackPayload(created.body.payment.transactionId)),
      ).expect(200);
    });

    it('settles a verified success', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const res = await post(
        signed(callbackPayload(created.body.payment.transactionId)),
      ).expect(200);

      expect(res.body.received).toBe(true);
      expect(res.body.outcome).toBe('APPLIED');
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.SUCCESS);
      expect(walletCalls.settle).toBe(1);
    });

    it('403s an invalid signature', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      await post({
        ...callbackPayload(created.body.payment.transactionId),
        hash: 'bad',
      }).expect(403);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('403s a completely forged webhook for a real transaction', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      await post(callbackPayload(created.body.payment.transactionId)).expect(
        403,
      );
      expect(walletCalls.settle).toBe(0);
    });

    it('404s an unknown transaction', async () => {
      await post(signed(callbackPayload('PFNOSUCHTXN'))).expect(404);
    });

    it('400s a signed payload with a tampered amount', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;
      // Signed consistently at a DIFFERENT amount than the stored payment.
      const payload = signed({
        ...callbackPayload(txnid),
        amount: '1.00',
      });
      await post(payload).expect(400);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
      expect(walletCalls.settle).toBe(0);
    });

    it('a duplicate webhook cannot double-credit the wallet', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const payload = signed(
        callbackPayload(created.body.payment.transactionId),
      );

      const first = await post(payload).expect(200);
      const second = await post(payload).expect(200);
      const third = await post(payload).expect(200);

      expect(first.body.outcome).toBe('APPLIED');
      expect(second.body.outcome).toBe('DUPLICATE');
      expect(third.body.outcome).toBe('DUPLICATE');
      // The assertion this whole module exists to guarantee.
      expect(walletCalls.settle).toBe(1);
    });

    it('a callback followed by a webhook credits only once', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const payload = signed(
        callbackPayload(created.body.payment.transactionId),
      );

      await http()
        .post('/api/v1/payments/payu/success')
        .send(payload)
        .expect(302);
      const webhook = await post(payload).expect(200);

      expect(webhook.body.outcome).toBe('DUPLICATE');
      expect(walletCalls.settle).toBe(1);
    });

    it('concurrent webhooks credit only once', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const payload = signed(
        callbackPayload(created.body.payment.transactionId),
      );

      const results = await Promise.all([
        post(payload),
        post(payload),
        post(payload),
      ]);

      const outcomes = results.map((r) => r.body.outcome);
      expect(outcomes.filter((o) => o === 'APPLIED')).toHaveLength(1);
      expect(walletCalls.settle).toBe(1);
    });

    it('processes a failed webhook on the same endpoint', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      await post(
        signed(callbackPayload(created.body.payment.transactionId, 'failure')),
      ).expect(200);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.FAILED);
    });

    it('processes a refund webhook on the same endpoint', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      db.payments[0].status = PaymentTransactionStatus.REFUND_PENDING;
      await post(
        signed(callbackPayload(created.body.payment.transactionId, 'refunded')),
      ).expect(200);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.REFUNDED);
    });

    it('a duplicate refund webhook is a no-op', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      db.payments[0].status = PaymentTransactionStatus.REFUND_PENDING;
      const payload = signed(
        callbackPayload(created.body.payment.transactionId, 'refunded'),
      );
      await post(payload).expect(200);
      const second = await post(payload).expect(200);
      expect(second.body.outcome).toBe('DUPLICATE');
    });

    it('exposes no per-event webhook sub-routes', async () => {
      await http().post('/api/v1/payments/webhooks/payu/success').expect(404);
      await http().post('/api/v1/payments/webhooks/payu/failure').expect(404);
      await http().post('/api/v1/payments/webhooks/payu/refund').expect(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN CASH FLOW
  // ══════════════════════════════════════════════════════════════════

  describe('admin cash collections', () => {
    const createCash = (key = 'cash-1') =>
      http()
        .post('/api/v1/customer/payments/create')
        .set(AS_CUST1)
        .set('Idempotency-Key', key)
        .send({ amount: 100_000, paymentMethod: 'CASH' });

    it('lists pending cash collections for an admin', async () => {
      await createCash().expect(201);
      const res = await http()
        .get('/api/v1/admin/payments/cash-collections')
        .set(ADMIN)
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe(CashCollectionStatus.PENDING);
    });

    it('does not credit the wallet before confirmation', async () => {
      await createCash().expect(201);
      expect(walletCalls.cashCredit).toBe(0);
      expect(db.creditRequests[0].status).toBe(
        WalletCreditRequestStatus.PENDING,
      );
    });

    it('credits the wallet on admin confirmation', async () => {
      const created = await createCash().expect(201);
      const id = created.body.cashCollection.id;

      const res = await http()
        .post(`/api/v1/admin/payments/cash-collections/${id}/confirm`)
        .set(ADMIN)
        .send({ note: 'counted at depot' })
        .expect(200);

      expect(res.body.cashCollection.status).toBe(
        CashCollectionStatus.CONFIRMED,
      );
      expect(walletCalls.cashCredit).toBe(1);
      expect(db.creditRequests[0].status).toBe(
        WalletCreditRequestStatus.COMPLETED,
      );
    });

    it('records the confirming admin from the JWT, ignoring any body adminId', async () => {
      const created = await createCash().expect(201);
      const id = created.body.cashCollection.id;

      await http()
        .post(`/api/v1/admin/payments/cash-collections/${id}/confirm`)
        .set(ADMIN)
        .send({ adminId: 'attacker-admin', note: 'ok' })
        .expect(200);

      expect(db.cashCollections[0].confirmedByAdminId).toBe(ADMIN_ID);
    });

    it('409s a duplicate confirmation and credits only once', async () => {
      const created = await createCash().expect(201);
      const id = created.body.cashCollection.id;
      const url = `/api/v1/admin/payments/cash-collections/${id}/confirm`;

      await http().post(url).set(ADMIN).send({}).expect(200);
      await http().post(url).set(ADMIN).send({}).expect(409);
      expect(walletCalls.cashCredit).toBe(1);
    });

    it('cancels a cash collection without crediting', async () => {
      const created = await createCash().expect(201);
      const id = created.body.cashCollection.id;

      await http()
        .post(`/api/v1/admin/payments/cash-collections/${id}/cancel`)
        .set(ADMIN)
        .send({ note: 'customer unavailable' })
        .expect(200);

      expect(walletCalls.cashCredit).toBe(0);
      expect(db.creditRequests[0].status).toBe(
        WalletCreditRequestStatus.CANCELLED,
      );
    });

    it('400s a cancellation with no reason', async () => {
      const created = await createCash().expect(201);
      const id = created.body.cashCollection.id;
      await http()
        .post(`/api/v1/admin/payments/cash-collections/${id}/cancel`)
        .set(ADMIN)
        .send({})
        .expect(400);
    });

    it('404s confirming an unknown collection', async () => {
      await http()
        .post('/api/v1/admin/payments/cash-collections/nope/confirm')
        .set(ADMIN)
        .send({})
        .expect(404);
    });

    it('resolves cash-collections before the :id payment route', async () => {
      // Guards against "cash-collections" being swallowed as a payment id.
      await http()
        .get('/api/v1/admin/payments/cash-collections')
        .set(ADMIN)
        .expect(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  NO MANUAL SUCCESS
  // ══════════════════════════════════════════════════════════════════

  describe('admin cannot manually settle an online payment', () => {
    it('has no mark-success route', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const id = created.body.payment.id;

      for (const path of [
        `/api/v1/admin/payments/${id}/mark-success`,
        `/api/v1/admin/payments/${id}/success`,
        `/api/v1/admin/payments/${id}/approve`,
      ]) {
        await http().post(path).set(ADMIN).send({}).expect(404);
      }
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('has no status-mutating PATCH on a payment', async () => {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      await http()
        .patch(`/api/v1/admin/payments/${created.body.payment.id}`)
        .set(ADMIN)
        .send({ status: 'SUCCESS' })
        .expect(404);
      expect(db.payments[0].status).toBe(PaymentTransactionStatus.PENDING);
    });

    it('does not duplicate the wallet approval endpoint', async () => {
      await http()
        .post('/api/v1/admin/payments/credit-requests/some-id/approve')
        .set(ADMIN)
        .send({})
        .expect(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  REFUND OVER HTTP
  // ══════════════════════════════════════════════════════════════════

  describe('admin refund', () => {
    async function settledPayment() {
      const created = await createOnline(AS_CUST1, {}, 'c1').expect(201);
      const txnid = created.body.payment.transactionId;
      await http()
        .post('/api/v1/payments/webhooks/payu')
        .send(signed(callbackPayload(txnid)))
        .expect(200);
      // The admin rejected the credit through the existing wallet endpoint.
      db.creditRequests[0].status = WalletCreditRequestStatus.REJECTED;
      db.creditRequests[0].refundStatus = 'REFUND_PENDING';
      return { creditRequestId: db.creditRequests[0].id, txnid };
    }

    it('moves the payment to REFUND_PENDING, not REFUNDED', async () => {
      payuClient.refund.mockResolvedValue({
        accepted: true,
        requestId: '9988',
        message: 'queued',
      });
      const { creditRequestId } = await settledPayment();

      const res = await http()
        .post(
          `/api/v1/admin/payments/credit-requests/${creditRequestId}/refund`,
        )
        .set(ADMIN)
        .expect(200);

      expect(res.body.payment.status).toBe(
        PaymentTransactionStatus.REFUND_PENDING,
      );
      expect(db.payments[0].status).not.toBe(PaymentTransactionStatus.REFUNDED);
    });

    it('becomes REFUNDED only after a verified refund webhook', async () => {
      payuClient.refund.mockResolvedValue({
        accepted: true,
        requestId: '9988',
        message: null,
      });
      const { creditRequestId, txnid } = await settledPayment();

      await http()
        .post(
          `/api/v1/admin/payments/credit-requests/${creditRequestId}/refund`,
        )
        .set(ADMIN)
        .expect(200);

      await http()
        .post('/api/v1/payments/webhooks/payu')
        .send(signed(callbackPayload(txnid, 'refunded')))
        .expect(200);

      expect(db.payments[0].status).toBe(PaymentTransactionStatus.REFUNDED);
    });

    it('409s a second refund attempt', async () => {
      payuClient.refund.mockResolvedValue({
        accepted: true,
        requestId: '1',
        message: null,
      });
      const { creditRequestId } = await settledPayment();
      const url = `/api/v1/admin/payments/credit-requests/${creditRequestId}/refund`;

      await http().post(url).set(ADMIN).expect(200);
      await http().post(url).set(ADMIN).expect(409);
      expect(payuClient.refund).toHaveBeenCalledTimes(1);
    });

    it('409s refunding a credit request that was not rejected', async () => {
      await createOnline(AS_CUST1, {}, 'c1').expect(201);
      await http()
        .post(
          `/api/v1/admin/payments/credit-requests/${db.creditRequests[0].id}/refund`,
        )
        .set(ADMIN)
        .expect(409);
    });
  });
});
