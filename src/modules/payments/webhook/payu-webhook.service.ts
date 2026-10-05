import { Inject, Injectable, Logger } from '@nestjs/common';
import { PAYMENT_PROVIDER } from '../providers/payment-provider.interface';
import type { IPaymentProvider } from '../providers/payment-provider.interface';
import { PaymentsService } from '../payments.service';
import type { AppliedOutcome } from '../payments.service';

/** What the webhook endpoint reports back to PayU. */
export interface WebhookProcessingResult {
  received: true;
  outcome: AppliedOutcome['outcome'];
  status: string;
  transactionId: string;
}

/**
 * Processes the single PayU webhook endpoint that handles successful, failed
 * and refund events.
 *
 * The payload is treated as entirely untrusted: this class's only trust
 * anchor is the reverse-hash verification performed by the provider. There is
 * no JWT on this route, so hash verification IS the authentication.
 *
 * Idempotency is not implemented here — it is inherited from
 * `PaymentsService.applyVerifiedOutcome`, whose conditional state transitions
 * mean a replayed webhook changes nothing and credits nothing.
 */
@Injectable()
export class PayuWebhookService {
  private readonly logger = new Logger(PayuWebhookService.name);

  constructor(
    @Inject(PAYMENT_PROVIDER)
    private readonly provider: IPaymentProvider,
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * 1. Verify the PayU hash over the payload's own values.
   * 2. Normalise the event into our status vocabulary.
   * 3. Hand it to the shared state machine, which identifies the payment,
   *    validates the amount, checks the current state and applies only a legal
   *    transition.
   *
   * Nothing is logged that could contain signing material: the raw payload is
   * never logged, only identifiers and the resulting status.
   */
  async handle(
    payload: Record<string, unknown>,
  ): Promise<WebhookProcessingResult> {
    const verification = await this.provider.verifyPayment(payload);

    this.logger.log(
      `PayU webhook received transactionId=${verification.transactionId ?? 'unknown'} ` +
        `rawStatus=${verification.rawStatus ?? 'none'} ` +
        `signatureValid=${verification.signatureValid}`,
    );

    // Throws ForbiddenException on an invalid signature, so a forged webhook
    // gets a 403 and is never acknowledged as processed.
    const applied = await this.paymentsService.applyVerifiedOutcome(
      verification,
      'WEBHOOK',
    );

    this.logger.log(
      `PayU webhook processed paymentId=${applied.paymentId} ` +
        `transactionId=${applied.transactionId} outcome=${applied.outcome} ` +
        `status=${applied.status} walletCredited=${applied.walletCredited}`,
    );

    return {
      received: true,
      outcome: applied.outcome,
      status: applied.status,
      transactionId: applied.transactionId,
    };
  }
}
