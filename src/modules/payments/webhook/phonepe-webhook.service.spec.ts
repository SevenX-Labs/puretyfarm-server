jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PhonePeWebhookService } from './phonepe-webhook.service';
import { PaymentTransactionStatus } from '../payments.constants';

const TXNID = 'PFABC123DEADBEEF01';

/**
 * Unit tests for the two gates the PhonePe webhook enforces:
 *
 *   1. the Authorization header must authenticate, and
 *   2. the event body is never accepted as proof of payment — the outcome is
 *      always re-read from PhonePe's own APIs.
 */
describe('PhonePeWebhookService', () => {
  let provider: {
    verifyWebhookAuthorization: jest.Mock;
    interpretWebhookEvent: jest.Mock;
    fetchVerifiedOutcome: jest.Mock;
    fetchVerifiedRefundOutcome: jest.Mock;
  };
  let paymentsService: { applyVerifiedOutcome: jest.Mock };
  let service: PhonePeWebhookService;

  const completedEvent = {
    event: 'checkout.order.completed',
    payload: {
      merchantOrderId: TXNID,
      orderId: 'OMO1',
      state: 'COMPLETED',
      amount: 50_000,
    },
  };

  const verifiedSuccess = {
    signatureValid: true,
    transactionId: TXNID,
    providerPaymentId: 'OMO1',
    amountPaise: 50_000,
    status: PaymentTransactionStatus.SUCCESS,
    rawStatus: 'COMPLETED',
    failureCode: null,
    failureMessage: null,
    sanitisedPayload: { source: 'phonepe_order_status' },
  };

  beforeEach(() => {
    provider = {
      verifyWebhookAuthorization: jest.fn().mockReturnValue(true),
      interpretWebhookEvent: jest.fn().mockReturnValue({
        kind: 'ORDER',
        event: 'checkout.order.completed',
        transactionId: TXNID,
      }),
      fetchVerifiedOutcome: jest.fn().mockResolvedValue(verifiedSuccess),
      fetchVerifiedRefundOutcome: jest.fn(),
    };
    paymentsService = {
      applyVerifiedOutcome: jest.fn().mockResolvedValue({
        outcome: 'APPLIED',
        paymentId: 'pay-1',
        transactionId: TXNID,
        status: PaymentTransactionStatus.SUCCESS,
        walletCredited: true,
        requiresAdminApproval: false,
        creditRequestStatus: 'COMPLETED',
      }),
    };
    service = new PhonePeWebhookService(
      provider as any,
      paymentsService as any,
    );
  });

  // ── Gate 1: authenticity ────────────────────────────────────────────

  it('rejects an event whose Authorization header does not authenticate', async () => {
    provider.verifyWebhookAuthorization.mockReturnValue(false);

    await expect(
      service.handle('bogus', completedEvent as any),
    ).rejects.toThrow(ForbiddenException);

    // Nothing is looked up and nothing is applied on a failed auth.
    expect(provider.fetchVerifiedOutcome).not.toHaveBeenCalled();
    expect(paymentsService.applyVerifiedOutcome).not.toHaveBeenCalled();
  });

  it('checks the header before it reads the payload at all', async () => {
    provider.verifyWebhookAuthorization.mockReturnValue(false);

    await expect(
      service.handle(undefined, completedEvent as any),
    ).rejects.toThrow(ForbiddenException);

    expect(provider.interpretWebhookEvent).not.toHaveBeenCalled();
  });

  // ── Gate 2: truth from PhonePe, not from the body ───────────────────

  it('settles from the Order Status API, not from the event body', async () => {
    await service.handle('valid-digest', completedEvent);

    expect(provider.fetchVerifiedOutcome).toHaveBeenCalledWith(TXNID);
    // The object handed to the state machine is the API's, not the event's.
    expect(paymentsService.applyVerifiedOutcome).toHaveBeenCalledWith(
      verifiedSuccess,
      'WEBHOOK',
    );
  });

  it('does not apply a success the event claims but PhonePe does not confirm', async () => {
    // An authentic-looking header and a COMPLETED body, but PhonePe reports
    // the order as still pending.
    provider.fetchVerifiedOutcome.mockResolvedValue({
      ...verifiedSuccess,
      status: null,
      rawStatus: 'PENDING',
    });

    const result = await service.handle('valid-digest', completedEvent);

    expect(result.outcome).toBe('IGNORED');
    expect(paymentsService.applyVerifiedOutcome).not.toHaveBeenCalled();
  });

  it('rejects an event naming an order PhonePe has no record of', async () => {
    provider.fetchVerifiedOutcome.mockResolvedValue(null);

    await expect(
      service.handle('valid-digest', completedEvent as any),
    ).rejects.toThrow(BadRequestException);

    expect(paymentsService.applyVerifiedOutcome).not.toHaveBeenCalled();
  });

  it('rejects an event with no merchant order id', async () => {
    provider.interpretWebhookEvent.mockReturnValue({
      kind: 'ORDER',
      event: 'checkout.order.completed',
      transactionId: null,
    });

    await expect(
      service.handle('valid-digest', { event: 'checkout.order.completed' }),
    ).rejects.toThrow(BadRequestException);
  });

  // ── Event routing ───────────────────────────────────────────────────

  it('acknowledges an unhandled event without changing anything', async () => {
    provider.interpretWebhookEvent.mockReturnValue({
      kind: 'UNKNOWN',
      event: 'checkout.order.something',
      transactionId: TXNID,
    });

    const result = await service.handle('valid-digest', completedEvent);

    expect(result).toEqual({
      received: true,
      outcome: 'IGNORED',
      status: 'UNCHANGED',
      transactionId: TXNID,
    });
    expect(provider.fetchVerifiedOutcome).not.toHaveBeenCalled();
    expect(paymentsService.applyVerifiedOutcome).not.toHaveBeenCalled();
  });

  it('routes a refund event through the refund status API', async () => {
    provider.interpretWebhookEvent.mockReturnValue({
      kind: 'REFUND',
      event: 'pg.refund.completed',
      transactionId: TXNID,
    });
    provider.fetchVerifiedRefundOutcome.mockResolvedValue({
      ...verifiedSuccess,
      amountPaise: null,
      status: PaymentTransactionStatus.REFUNDED,
      rawStatus: 'COMPLETED',
    });

    await service.handle('valid-digest', {
      event: 'pg.refund.completed',
      payload: { originalMerchantOrderId: TXNID },
    });

    expect(provider.fetchVerifiedRefundOutcome).toHaveBeenCalledWith(TXNID);
    expect(provider.fetchVerifiedOutcome).not.toHaveBeenCalled();
  });

  // ── Idempotency and retry semantics ─────────────────────────────────

  it('passes a replayed event straight through and reports DUPLICATE', async () => {
    paymentsService.applyVerifiedOutcome.mockResolvedValue({
      outcome: 'DUPLICATE',
      paymentId: 'pay-1',
      transactionId: TXNID,
      status: PaymentTransactionStatus.SUCCESS,
      // A replay credits nothing: the state machine matched zero rows.
      walletCredited: false,
      requiresAdminApproval: false,
      creditRequestStatus: null,
    });

    const result = await service.handle('valid-digest', completedEvent);

    expect(result.outcome).toBe('DUPLICATE');
  });

  it('surfaces a provider outage as 503 so PhonePe retries the event', async () => {
    provider.fetchVerifiedOutcome.mockRejectedValue(
      new ServiceUnavailableException(),
    );

    await expect(
      service.handleWithRetrySemantics('valid-digest', completedEvent as any),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(paymentsService.applyVerifiedOutcome).not.toHaveBeenCalled();
  });

  it('does not convert an auth failure into a retryable error', async () => {
    provider.verifyWebhookAuthorization.mockReturnValue(false);

    await expect(
      service.handleWithRetrySemantics('bogus', completedEvent as any),
    ).rejects.toThrow(ForbiddenException);
  });
});
