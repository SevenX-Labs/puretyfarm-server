jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PayuWebhookService } from './payu-webhook.service';
import { PayuHashService } from '../providers/payu/payu.hash.service';
import { PayuService } from '../providers/payu/payu.service';
import { PaymentTransactionStatus } from '../payments.constants';

const KEY = 'testmerchantkey';
const SALT = 'testmerchantsalt';

const env: Record<string, string> = {
  PAYU_KEY: KEY,
  PAYU_SALT: SALT,
  PUBLIC_API_BASE_URL: 'https://api.example.com',
};

/**
 * The webhook is the only public, unauthenticated write path into the payment
 * system, so these tests drive the REAL PayU provider and the REAL hash
 * service. Only the payment state machine is stubbed, which keeps the focus on
 * what the webhook itself is responsible for: refusing anything PayU did not
 * actually sign.
 */
describe('PayuWebhookService', () => {
  let service: PayuWebhookService;
  let hashService: PayuHashService;
  let provider: PayuService;
  let payments: { applyVerifiedOutcome: jest.Mock };

  const config = { get: (name: string) => env[name] };

  const basePayload = {
    key: KEY,
    txnid: 'PFTEST0001',
    amount: '1000.00',
    productinfo: 'PuretyFarm Wallet Top-up',
    firstname: 'Asha',
    email: 'asha@example.com',
    status: 'success',
    mihpayid: 'PAYU123456',
  };

  /** Signs a payload the way PayU would. */
  const sign = (payload: Record<string, unknown>): Record<string, any> => ({
    ...payload,
    hash: hashService.generateReverseHash(payload),
  });

  beforeEach(() => {
    hashService = new PayuHashService(config as any);
    provider = new PayuService(config as any, hashService, {
      verifyPayment: jest.fn(),
      refund: jest.fn(),
    } as any);
    payments = {
      applyVerifiedOutcome: jest.fn(async (verification) => {
        if (!verification.signatureValid) {
          throw new ForbiddenException({ error: 'PAYMENT_SIGNATURE_INVALID' });
        }
        if (!verification.transactionId) {
          throw new BadRequestException({
            error: 'PAYMENT_TRANSACTION_ID_MISSING',
          });
        }
        if (verification.transactionId === 'PFUNKNOWN') {
          throw new NotFoundException({ error: 'PAYMENT_NOT_FOUND' });
        }
        return {
          outcome: 'APPLIED',
          paymentId: 'payment-1',
          transactionId: verification.transactionId,
          status: verification.status ?? PaymentTransactionStatus.PENDING,
          walletCredited: false,
          requiresAdminApproval: false,
          creditRequestStatus: null,
        };
      }),
    };
    service = new PayuWebhookService(provider, payments as any);
  });

  // ── Happy paths: one endpoint, three event kinds ──────────────────

  it('processes a successful webhook', async () => {
    const result = await service.handle(sign(basePayload));

    expect(result.received).toBe(true);
    expect(result.outcome).toBe('APPLIED');
    expect(result.transactionId).toBe('PFTEST0001');
    expect(payments.applyVerifiedOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        signatureValid: true,
        status: PaymentTransactionStatus.SUCCESS,
      }),
      'WEBHOOK',
    );
  });

  it('processes a failed webhook on the same endpoint', async () => {
    const result = await service.handle(
      sign({ ...basePayload, status: 'failure', error: 'E401' }),
    );
    expect(result.status).toBe(PaymentTransactionStatus.FAILED);
    expect(payments.applyVerifiedOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentTransactionStatus.FAILED }),
      'WEBHOOK',
    );
  });

  it('processes a refund webhook on the same endpoint', async () => {
    const result = await service.handle(
      sign({ ...basePayload, status: 'refunded' }),
    );
    expect(result.status).toBe(PaymentTransactionStatus.REFUNDED);
  });

  it('always reports the WEBHOOK source to the state machine', async () => {
    await service.handle(sign(basePayload));
    expect(payments.applyVerifiedOutcome.mock.calls[0][1]).toBe('WEBHOOK');
  });

  // ── Signature rejection ───────────────────────────────────────────

  it('rejects a payload with no hash', async () => {
    await expect(service.handle(basePayload)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a payload with a wrong hash', async () => {
    await expect(
      service.handle({ ...basePayload, hash: 'f'.repeat(128) }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a payload signed with the wrong salt', async () => {
    const attacker = new PayuHashService({ get: () => 'wrongsalt' } as any);
    await expect(
      service.handle({
        ...basePayload,
        hash: attacker.generateReverseHash(basePayload as any),
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a forged success whose status was swapped after signing', async () => {
    const payload = sign({ ...basePayload, status: 'failure' });
    payload.status = 'success';
    await expect(service.handle(payload)).rejects.toThrow(ForbiddenException);
  });

  it('rejects a payload whose amount was inflated after signing', async () => {
    const payload = sign(basePayload);
    payload.amount = '100000.00';
    await expect(service.handle(payload)).rejects.toThrow(ForbiddenException);
  });

  it('rejects a payload whose txnid was swapped after signing', async () => {
    const payload = sign(basePayload);
    payload.txnid = 'PFVICTIM0001';
    await expect(service.handle(payload)).rejects.toThrow(ForbiddenException);
  });

  it('rejects an empty body', async () => {
    await expect(service.handle({})).rejects.toThrow(ForbiddenException);
  });

  it('never reaches the state machine with an invalid signature applied', async () => {
    await service.handle({ ...basePayload, hash: 'bad' }).catch(() => {});
    // It IS called, but with signatureValid: false, and it throws there — the
    // single rejection point for every inbound channel.
    expect(payments.applyVerifiedOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ signatureValid: false }),
      'WEBHOOK',
    );
  });

  // ── Identity and amount ───────────────────────────────────────────

  it('surfaces a 404 for an unknown transaction', async () => {
    await expect(
      service.handle(sign({ ...basePayload, txnid: 'PFUNKNOWN' })),
    ).rejects.toThrow(NotFoundException);
  });

  it('surfaces a 400 when the signed payload carries no txnid', async () => {
    const { txnid, ...withoutTxnid } = basePayload;
    await expect(service.handle(sign(withoutTxnid))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('passes the parsed paise amount through for server-side amount checking', async () => {
    await service.handle(sign(basePayload));
    expect(payments.applyVerifiedOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 100_000 }),
      'WEBHOOK',
    );
  });

  // ── Idempotency ───────────────────────────────────────────────────

  it('reports DUPLICATE for a replayed webhook', async () => {
    payments.applyVerifiedOutcome.mockResolvedValue({
      outcome: 'DUPLICATE',
      paymentId: 'payment-1',
      transactionId: 'PFTEST0001',
      status: PaymentTransactionStatus.SUCCESS,
      walletCredited: false,
      requiresAdminApproval: false,
      creditRequestStatus: null,
    });

    const result = await service.handle(sign(basePayload));
    expect(result.outcome).toBe('DUPLICATE');
    expect(result.received).toBe(true);
  });

  it('delegates idempotency to the state machine rather than reimplementing it', async () => {
    const payload = sign(basePayload);
    await service.handle(payload);
    await service.handle(payload);
    // Both reach the state machine; the conditional transition there is what
    // makes the second one a no-op.
    expect(payments.applyVerifiedOutcome).toHaveBeenCalledTimes(2);
  });

  // ── Secret containment ────────────────────────────────────────────

  it('never passes the hash or the salt into the persistable payload', async () => {
    await service.handle(sign(basePayload));
    const verification = payments.applyVerifiedOutcome.mock.calls[0][0];
    expect(verification.sanitisedPayload.hash).toBeUndefined();
    expect(verification.sanitisedPayload.key).toBeUndefined();
    expect(JSON.stringify(verification.sanitisedPayload)).not.toContain(SALT);
  });

  it('strips card data an upstream might echo', async () => {
    await service.handle(
      sign({ ...basePayload, cardnum: '4111111111111111', ccvv: '123' }),
    );
    const verification = payments.applyVerifiedOutcome.mock.calls[0][0];
    expect(verification.sanitisedPayload.cardnum).toBeUndefined();
    expect(verification.sanitisedPayload.ccvv).toBeUndefined();
  });
});
