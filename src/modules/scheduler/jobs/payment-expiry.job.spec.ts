jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

// `@nestjs/schedule` is ESM-only; stub it the same way the project stubs
// `@nestjs/jwt` and `@nestjs/config` elsewhere. The decorator is a no-op so
// the class can still be instantiated, and the enum values are kept so the
// production code can reference them without a runtime failure.
jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_10_MINUTES: '*/10 * * * *' },
  ScheduleModule: { forRoot: () => ({ module: class {} }) },
  SchedulerRegistry: class {
    getCronJobs() {
      return new Map();
    }
  },
}));

import { PaymentExpiryJob } from './payment-expiry.job';
import type { PaymentsService } from '../../payments/payments.service';

/**
 * The job's one job: call `PaymentsService.expireStalePayments()` on a timer
 * and never crash the process. These tests pin that contract and the
 * negative-space guarantees — the scheduler must not touch wallet balance,
 * approval rules, PayU, or cash flow.
 */
describe('PaymentExpiryJob', () => {
  let job: PaymentExpiryJob;
  let payments: {
    expireStalePayments: jest.Mock;
    settleAfterVerifiedPayment?: jest.Mock;
    creditConfirmedCashRequest?: jest.Mock;
    initiateRefundForRejectedCreditRequest?: jest.Mock;
    createWalletTopUp?: jest.Mock;
  };

  beforeEach(() => {
    payments = {
      expireStalePayments: jest.fn().mockResolvedValue({ expired: 0 }),
      // These are present so the test can prove the job never calls them.
      settleAfterVerifiedPayment: jest.fn(),
      creditConfirmedCashRequest: jest.fn(),
      initiateRefundForRejectedCreditRequest: jest.fn(),
      createWalletTopUp: jest.fn(),
    };
    job = new PaymentExpiryJob(payments as unknown as PaymentsService);
  });

  // ── Contract ──────────────────────────────────────────────────────

  it('invokes PaymentsService.expireStalePayments exactly once per tick', async () => {
    await job.handleExpiry();
    expect(payments.expireStalePayments).toHaveBeenCalledTimes(1);
    expect(payments.expireStalePayments).toHaveBeenCalledWith();
  });

  it('resolves when the service reports some rows were expired', async () => {
    payments.expireStalePayments.mockResolvedValue({ expired: 3 });
    await expect(job.handleExpiry()).resolves.toBeUndefined();
    expect(payments.expireStalePayments).toHaveBeenCalledTimes(1);
  });

  it('resolves cleanly when there is nothing to expire', async () => {
    payments.expireStalePayments.mockResolvedValue({ expired: 0 });
    await expect(job.handleExpiry()).resolves.toBeUndefined();
  });

  // ── Fault tolerance ───────────────────────────────────────────────

  it('swallows a service failure so the Nest process does not crash', async () => {
    payments.expireStalePayments.mockRejectedValue(new Error('db down'));
    await expect(job.handleExpiry()).resolves.toBeUndefined();
  });

  it('logs the error class name only, not the error message or any payload', async () => {
    const logError = jest
      .spyOn((job as any).logger, 'error')
      .mockImplementation(() => undefined);
    payments.expireStalePayments.mockRejectedValue(
      new TypeError('contains PAYU_SALT=supersecret'),
    );

    await job.handleExpiry();

    expect(logError).toHaveBeenCalledTimes(1);
    const message = String(logError.mock.calls[0][0]);
    expect(message).toContain('reason=TypeError');
    expect(message).not.toContain('PAYU_SALT');
    expect(message).not.toContain('supersecret');
    logError.mockRestore();
  });

  // ── Idempotency ───────────────────────────────────────────────────

  it('is safe to run many times back-to-back', async () => {
    for (let i = 0; i < 5; i += 1) {
      await job.handleExpiry();
    }
    expect(payments.expireStalePayments).toHaveBeenCalledTimes(5);
  });

  it('tolerates overlapping ticks (previous run still in flight)', async () => {
    // The method is already idempotent via conditional updateMany; the job
    // simply delegates. Both "concurrent" calls must succeed.
    let resolveFirst!: (value: { expired: number }) => void;
    payments.expireStalePayments.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    payments.expireStalePayments.mockImplementationOnce(async () => ({
      expired: 0,
    }));

    const first = job.handleExpiry();
    const second = job.handleExpiry();
    resolveFirst({ expired: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(payments.expireStalePayments).toHaveBeenCalledTimes(2);
  });

  // ── Negative space: scheduler must own NONE of these ──────────────

  it('does not settle any payment', async () => {
    await job.handleExpiry();
    expect(payments.settleAfterVerifiedPayment).not.toHaveBeenCalled();
  });

  it('does not confirm or credit any cash collection', async () => {
    await job.handleExpiry();
    expect(payments.creditConfirmedCashRequest).not.toHaveBeenCalled();
  });

  it('does not initiate any refund', async () => {
    await job.handleExpiry();
    expect(payments.initiateRefundForRejectedCreditRequest).not.toHaveBeenCalled();
  });

  it('does not create new wallet top-ups', async () => {
    await job.handleExpiry();
    expect(payments.createWalletTopUp).not.toHaveBeenCalled();
  });

  it('exposes no method that could credit the wallet or approve a payment', () => {
    // Structural check against future drift: the job's public surface must be
    // the single handler, nothing else that could be mistaken for a business
    // operation.
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(job),
    ).filter((m) => m !== 'constructor');
    expect(methods).toEqual(['handleExpiry']);
    expect(methods).not.toContain('approvePayment');
    expect(methods).not.toContain('creditWallet');
    expect(methods).not.toContain('markSuccess');
    expect(methods).not.toContain('settlePayment');
  });
});
