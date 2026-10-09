jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { createHash } from 'crypto';
import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PhonePeService } from './phonepe.service';
import { PhonePeClient } from './phonepe.client';
import { PaymentTransactionStatus } from '../../payments.constants';

const API_BASE = 'https://api.example.com';
const WEBHOOK_USER = 'pf-webhook-user';
const WEBHOOK_PASS = 'pf-webhook-pass';
const TXNID = 'PFABC123DEADBEEF01';

const env: Record<string, string> = {
  PUBLIC_API_BASE_URL: API_BASE,
  PHONEPE_WEBHOOK_USERNAME: WEBHOOK_USER,
  PHONEPE_WEBHOOK_PASSWORD: WEBHOOK_PASS,
  PAYMENT_EXPIRY_MINUTES: '30',
};

/** The digest PhonePe is documented to put in the Authorization header. */
const validDigest = createHash('sha256')
  .update(`${WEBHOOK_USER}:${WEBHOOK_PASS}`, 'utf8')
  .digest('hex');

describe('PhonePeService', () => {
  let client: jest.Mocked<Pick<PhonePeClient, 'createOrder' | 'getOrderStatus' | 'refund' | 'getRefundStatus'>>;
  let config: { get: jest.Mock };
  let service: PhonePeService;

  beforeEach(() => {
    client = {
      createOrder: jest.fn(),
      getOrderStatus: jest.fn(),
      refund: jest.fn(),
      getRefundStatus: jest.fn(),
    };
    config = { get: jest.fn((key: string) => env[key]) };
    service = new PhonePeService(config as any, client as any);
  });

  // ══════════════════════════════════════════════════════════════════
  //  CHECKOUT
  // ══════════════════════════════════════════════════════════════════

  describe('createPayment', () => {
    const input = {
      transactionId: TXNID,
      amountPaise: 50_000,
      productInfo: 'PuretyFarm Wallet Top-up',
      customerFirstName: 'Asha',
      customerEmail: 'asha@example.com',
      customerPhone: '9999999999',
    };

    beforeEach(() => {
      client.createOrder.mockResolvedValue({
        orderId: 'OMO2501011234567890',
        state: 'PENDING',
        expireAt: 1_767_000_000,
        redirectUrl: 'https://mercury.phonepe.com/transact/pg?token=abc',
      });
    });

    it('sends our own transaction id as merchantOrderId with the amount in paise', async () => {
      await service.createPayment(input);

      expect(client.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          merchantOrderId: TXNID,
          amount: 50_000,
        }),
      );
    });

    it('returns a REDIRECT instruction carrying PhonePe’s checkout URL', async () => {
      const checkout = await service.createPayment(input);

      expect(checkout.method).toBe('REDIRECT');
      expect(checkout.redirectUrl).toBe(
        'https://mercury.phonepe.com/transact/pg?token=abc',
      );
      // `endpoint` mirrors redirectUrl so a client can branch on either field.
      expect(checkout.endpoint).toBe(checkout.redirectUrl);
      expect(checkout.fields).toEqual({});
      expect(checkout.providerOrderId).toBe('OMO2501011234567890');
    });

    it('never leaks a credential into the checkout instruction', async () => {
      const checkout = await service.createPayment(input);
      const serialised = JSON.stringify(checkout);

      expect(serialised).not.toContain(WEBHOOK_PASS);
      expect(serialised).not.toContain(WEBHOOK_USER);
    });

    it('builds the return URL from PUBLIC_API_BASE_URL, not from the input', async () => {
      await service.createPayment(input);

      const redirectUrl =
        client.createOrder.mock.calls[0][0].paymentFlow.merchantUrls
          .redirectUrl;

      expect(redirectUrl).toBe(
        `${API_BASE}/api/v1/payments/phonepe/return?txnid=${TXNID}`,
      );
    });

    it('clamps expireAfter into PhonePe’s documented 300–3600s window', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'PAYMENT_EXPIRY_MINUTES' ? '240' : env[key],
      );

      await service.createPayment(input);

      expect(client.createOrder.mock.calls[0][0].expireAfter).toBe(3600);
    });

    it('rejects an amount below PhonePe’s ₹1 floor rather than calling the gateway', async () => {
      await expect(
        service.createPayment({ ...input, amountPaise: 99 }),
      ).rejects.toThrow(InternalServerErrorException);

      expect(client.createOrder).not.toHaveBeenCalled();
    });

    it('rejects a transaction id PhonePe would not accept as a merchantOrderId', async () => {
      await expect(
        service.createPayment({ ...input, transactionId: 'PF|BAD|ID' }),
      ).rejects.toThrow(InternalServerErrorException);

      expect(client.createOrder).not.toHaveBeenCalled();
    });

    it('propagates a duplicate-order conflict from the client untouched', async () => {
      client.createOrder.mockRejectedValue(new ConflictException());

      await expect(service.createPayment(input)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  AUTHORITATIVE STATUS
  // ══════════════════════════════════════════════════════════════════

  describe('fetchAuthoritativeStatus', () => {
    it('maps COMPLETED onto SUCCESS and reports the PhonePe order id', async () => {
      client.getOrderStatus.mockResolvedValue({
        orderId: 'OMO1',
        state: 'COMPLETED',
        amount: 50_000,
        paymentDetails: [{ state: 'COMPLETED', transactionId: 'T1' }],
      });

      await expect(service.fetchAuthoritativeStatus(TXNID)).resolves.toEqual({
        status: PaymentTransactionStatus.SUCCESS,
        rawStatus: 'COMPLETED',
        providerPaymentId: 'OMO1',
        amountPaise: 50_000,
      });
    });

    it('maps FAILED onto FAILED', async () => {
      client.getOrderStatus.mockResolvedValue({
        orderId: 'OMO1',
        state: 'FAILED',
        amount: 50_000,
        paymentDetails: [{ state: 'FAILED', errorCode: 'AUTHORIZATION_ERROR' }],
      });

      const result = await service.fetchAuthoritativeStatus(TXNID);
      expect(result.status).toBe(PaymentTransactionStatus.FAILED);
    });

    it('maps PENDING WITH an attempt onto PROCESSING', async () => {
      client.getOrderStatus.mockResolvedValue({
        orderId: 'OMO1',
        state: 'PENDING',
        amount: 50_000,
        paymentDetails: [{ state: 'PENDING', transactionId: 'T1' }],
      });

      const result = await service.fetchAuthoritativeStatus(TXNID);
      expect(result.status).toBe(PaymentTransactionStatus.PROCESSING);
    });

    it('treats PENDING with NO attempt as not actionable, so an abandoned top-up stays cancellable', async () => {
      client.getOrderStatus.mockResolvedValue({
        orderId: 'OMO1',
        state: 'PENDING',
        amount: 50_000,
        paymentDetails: [],
      });

      const result = await service.fetchAuthoritativeStatus(TXNID);
      expect(result.status).toBeNull();
      expect(result.rawStatus).toBe('PENDING');
    });

    it('returns all-nulls when PhonePe has no record of the order', async () => {
      client.getOrderStatus.mockResolvedValue(null);

      await expect(service.fetchAuthoritativeStatus(TXNID)).resolves.toEqual({
        status: null,
        rawStatus: null,
        providerPaymentId: null,
        amountPaise: null,
      });
    });

    it('never optimistically reads an unknown state as success', async () => {
      client.getOrderStatus.mockResolvedValue({
        orderId: 'OMO1',
        state: 'SOMETHING_NEW',
        amount: 50_000,
        paymentDetails: [{ state: 'SOMETHING_NEW' }],
      });

      const result = await service.fetchAuthoritativeStatus(TXNID);
      expect(result.status).toBeNull();
    });

    it('accepts an amount delivered as a numeric string', async () => {
      client.getOrderStatus.mockResolvedValue({
        orderId: 'OMO1',
        state: 'COMPLETED',
        amount: '50000',
        paymentDetails: [{ state: 'COMPLETED' }],
      });

      const result = await service.fetchAuthoritativeStatus(TXNID);
      expect(result.amountPaise).toBe(50_000);
    });

    it('returns a null amount for a malformed one rather than a rounded value', async () => {
      client.getOrderStatus.mockResolvedValue({
        orderId: 'OMO1',
        state: 'COMPLETED',
        amount: '500.49',
        paymentDetails: [{ state: 'COMPLETED' }],
      });

      const result = await service.fetchAuthoritativeStatus(TXNID);
      expect(result.amountPaise).toBeNull();
    });
  });

  describe('fetchVerifiedOutcome', () => {
    it('marks a server-to-server result as signature-valid and carries the failure codes', async () => {
      client.getOrderStatus.mockResolvedValue({
        orderId: 'OMO1',
        state: 'FAILED',
        amount: 50_000,
        paymentDetails: [
          {
            state: 'FAILED',
            errorCode: 'AUTHORIZATION_ERROR',
            detailedErrorCode: 'ZM',
          },
        ],
      });

      const verification = await service.fetchVerifiedOutcome(TXNID);

      expect(verification).toMatchObject({
        signatureValid: true,
        transactionId: TXNID,
        status: PaymentTransactionStatus.FAILED,
        failureCode: 'AUTHORIZATION_ERROR',
        failureMessage: 'ZM',
      });
    });

    it('returns null when PhonePe has no record of the order', async () => {
      client.getOrderStatus.mockResolvedValue(null);
      await expect(service.fetchVerifiedOutcome(TXNID)).resolves.toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  PAYLOAD "VERIFICATION" FAILS CLOSED
  // ══════════════════════════════════════════════════════════════════

  describe('verifyPayment', () => {
    it('always reports an invalid signature, because PhonePe payloads are not self-authenticating', async () => {
      const result = await service.verifyPayment({
        event: 'checkout.order.completed',
        payload: {
          merchantOrderId: TXNID,
          orderId: 'OMO1',
          state: 'COMPLETED',
          amount: 50_000,
        },
      });

      // Fails closed: applyVerifiedOutcome turns this into a 403 rather than
      // crediting a wallet off an unauthenticated payload.
      expect(result.signatureValid).toBe(false);
      expect(result.status).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  WEBHOOK AUTHENTICATION
  // ══════════════════════════════════════════════════════════════════

  describe('verifyWebhookAuthorization', () => {
    it('accepts the documented SHA256(username:password) hex digest', () => {
      expect(service.verifyWebhookAuthorization(validDigest)).toBe(true);
    });

    it('accepts the digest with a SHA256 scheme prefix', () => {
      expect(service.verifyWebhookAuthorization(`SHA256 ${validDigest}`)).toBe(
        true,
      );
    });

    it('accepts an upper-cased digest', () => {
      expect(
        service.verifyWebhookAuthorization(validDigest.toUpperCase()),
      ).toBe(true);
    });

    it('rejects a digest computed from the wrong password', () => {
      const wrong = createHash('sha256')
        .update(`${WEBHOOK_USER}:not-the-password`, 'utf8')
        .digest('hex');

      expect(service.verifyWebhookAuthorization(wrong)).toBe(false);
    });

    it('rejects the credentials sent in the clear instead of hashed', () => {
      expect(
        service.verifyWebhookAuthorization(`${WEBHOOK_USER}:${WEBHOOK_PASS}`),
      ).toBe(false);
    });

    it.each([
      ['a missing header', undefined],
      ['an empty header', ''],
      ['whitespace only', '   '],
      ['a Basic auth header', 'Basic dXNlcjpwYXNz'],
      ['a truncated digest', validDigest.slice(0, 32)],
    ])('rejects %s', (_label, header) => {
      expect(service.verifyWebhookAuthorization(header as any)).toBe(false);
    });

    it('fails closed when the webhook credentials are not configured', () => {
      config.get.mockImplementation((key: string) =>
        key === 'PHONEPE_WEBHOOK_PASSWORD' ? undefined : env[key],
      );

      expect(service.verifyWebhookAuthorization(validDigest)).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  WEBHOOK ENVELOPE READING
  // ══════════════════════════════════════════════════════════════════

  describe('interpretWebhookEvent', () => {
    it('reads an order-completed event', () => {
      expect(
        service.interpretWebhookEvent({
          event: 'checkout.order.completed',
          payload: { merchantOrderId: TXNID, state: 'COMPLETED' },
        }),
      ).toEqual({
        kind: 'ORDER',
        event: 'checkout.order.completed',
        transactionId: TXNID,
      });
    });

    it('reads an order-failed event', () => {
      const result = service.interpretWebhookEvent({
        event: 'checkout.order.failed',
        payload: { merchantOrderId: TXNID, state: 'FAILED' },
      });

      expect(result.kind).toBe('ORDER');
      expect(result.transactionId).toBe(TXNID);
    });

    it('reads a refund event from originalMerchantOrderId', () => {
      expect(
        service.interpretWebhookEvent({
          event: 'pg.refund.completed',
          payload: {
            merchantRefundId: `RFND-${TXNID}`,
            originalMerchantOrderId: TXNID,
            state: 'COMPLETED',
          },
        }),
      ).toEqual({
        kind: 'REFUND',
        event: 'pg.refund.completed',
        transactionId: TXNID,
      });
    });

    it('classifies an unrecognised event as UNKNOWN rather than guessing', () => {
      const result = service.interpretWebhookEvent({
        event: 'checkout.order.somethingelse',
        payload: { merchantOrderId: TXNID, state: 'COMPLETED' },
      });

      expect(result.kind).toBe('UNKNOWN');
    });

    it('survives an empty or malformed envelope', () => {
      expect(service.interpretWebhookEvent({})).toEqual({
        kind: 'UNKNOWN',
        event: null,
        transactionId: null,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  REFUNDS
  // ══════════════════════════════════════════════════════════════════

  describe('refundPayment', () => {
    it('derives merchantRefundId from the transaction id so a retry is the same refund', async () => {
      client.refund.mockResolvedValue({
        accepted: true,
        refundId: 'OMR1',
        state: 'PENDING',
        message: null,
      });

      await service.refundPayment({
        transactionId: TXNID,
        providerPaymentId: 'OMO1',
        amountPaise: 50_000,
        reason: 'admin rejected',
      });
      await service.refundPayment({
        transactionId: TXNID,
        providerPaymentId: 'OMO1',
        amountPaise: 50_000,
        reason: 'admin rejected again',
      });

      expect(client.refund).toHaveBeenNthCalledWith(1, {
        merchantRefundId: `RFND-${TXNID}`,
        originalMerchantOrderId: TXNID,
        amountPaise: 50_000,
      });
      // Identical request the second time: PhonePe treats it as the same
      // refund rather than a second one.
      expect(client.refund.mock.calls[1][0]).toEqual(
        client.refund.mock.calls[0][0],
      );
    });

    it('reports a provider rejection as accepted:false instead of throwing', async () => {
      client.refund.mockResolvedValue({
        accepted: false,
        refundId: null,
        state: null,
        message: 'Refund window closed',
      });

      await expect(
        service.refundPayment({
          transactionId: TXNID,
          providerPaymentId: 'OMO1',
          amountPaise: 50_000,
          reason: 'admin rejected',
        }),
      ).resolves.toEqual({
        accepted: false,
        providerRefundId: null,
        message: 'Refund window closed',
      });
    });
  });

  describe('fetchVerifiedRefundOutcome', () => {
    it('maps a COMPLETED refund onto REFUNDED and reports no amount to compare', async () => {
      client.getRefundStatus.mockResolvedValue({
        merchantRefundId: `RFND-${TXNID}`,
        refundId: 'OMR1',
        originalMerchantOrderId: TXNID,
        state: 'COMPLETED',
        amount: 50_000,
      });

      const verification = await service.fetchVerifiedRefundOutcome(TXNID);

      expect(verification).toMatchObject({
        signatureValid: true,
        transactionId: TXNID,
        status: PaymentTransactionStatus.REFUNDED,
        // Null so a PARTIAL refund's amount is never compared against the
        // payment amount and wrongly rejected as a mismatch.
        amountPaise: null,
      });
    });

    it('does not mark a still-pending refund as REFUNDED', async () => {
      client.getRefundStatus.mockResolvedValue({
        merchantRefundId: `RFND-${TXNID}`,
        state: 'PENDING',
      });

      const verification = await service.fetchVerifiedRefundOutcome(TXNID);
      expect(verification?.status).toBeNull();
    });

    it('queries the refund status by the id we derived, not one from the event', async () => {
      client.getRefundStatus.mockResolvedValue({ state: 'COMPLETED' });

      await service.fetchVerifiedRefundOutcome(TXNID);

      expect(client.getRefundStatus).toHaveBeenCalledWith(`RFND-${TXNID}`);
    });
  });
});
