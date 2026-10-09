import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PhonePeService } from '../providers/phonepe/phonepe.service';
import { PaymentsService } from '../payments.service';
import type { AppliedOutcome } from '../payments.service';

/** What the webhook endpoint reports back to PhonePe. */
export interface WebhookProcessingResult {
  received: true;
  outcome: AppliedOutcome['outcome'];
  status: string;
  transactionId: string;
}

/**
 * Processes the single PhonePe webhook endpoint.
 *
 * Handles the `checkout.order.completed` and `checkout.order.failed` events
 * configured in the PhonePe dashboard, plus `pg.refund.completed` /
 * `pg.refund.failed` defensively so enabling those events later needs no code
 * change.
 *
 * TWO INDEPENDENT GATES, because PhonePe's security model is not PayU's:
 *
 *   1. AUTHENTICITY — the `Authorization` header must equal
 *      SHA256(username:password) for the dashboard-configured webhook
 *      credentials. There is no JWT on this route, so this check IS the
 *      authentication. A failure is a 403 and no state change.
 *
 *   2. TRUTH — the event body is NEVER accepted as proof of payment, not even
 *      after gate 1 passes. An authentic event only tells us WHICH order to
 *      re-check; the outcome is then read from PhonePe's Order Status API over
 *      a server-to-server call. A compromised or replayed body therefore
 *      cannot assert a payment that PhonePe does not actually hold.
 *
 * Idempotency is not implemented here — it is inherited from
 * `PaymentsService.applyVerifiedOutcome`, whose conditional state transitions
 * mean a replayed webhook changes nothing and credits nothing.
 */
@Injectable()
export class PhonePeWebhookService {
  private readonly logger = new Logger(PhonePeWebhookService.name);

  constructor(
    private readonly provider: PhonePeService,
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * 1. Authenticate the request from its Authorization header.
   * 2. Read the envelope to learn the event kind and the merchant order id.
   * 3. Ask PhonePe for the authoritative state of that order (or refund).
   * 4. Hand it to the shared state machine, which identifies the payment,
   *    validates the amount, checks the current state and applies only a legal
   *    transition.
   *
   * Nothing is logged that could contain credential material: neither the
   * Authorization header nor the raw payload is ever logged, only identifiers
   * and the resulting status.
   */
  async handle(
    authorizationHeader: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<WebhookProcessingResult> {
    // ─── Gate 1: authenticity ──────────────────────────────────────────
    if (!this.provider.verifyWebhookAuthorization(authorizationHeader)) {
      this.logger.warn(
        'Rejected PhonePe webhook with an invalid Authorization header',
      );
      throw new ForbiddenException({
        error: 'PAYMENT_SIGNATURE_INVALID',
        message: 'Payment signature verification failed',
      });
    }

    const { kind, event, transactionId } =
      this.provider.interpretWebhookEvent(payload);

    this.logger.log(
      `PhonePe webhook received event=${event ?? 'unknown'} kind=${kind} ` +
        `transactionId=${transactionId ?? 'unknown'}`,
    );

    if (!transactionId) {
      throw new BadRequestException({
        error: 'PAYMENT_TRANSACTION_ID_MISSING',
        message: 'Transaction id missing from provider message',
      });
    }

    if (kind === 'UNKNOWN') {
      // An event type we do not handle. Acknowledged so PhonePe stops
      // retrying, but nothing is changed.
      this.logger.log(
        `PhonePe webhook ignored: unhandled event=${event ?? 'unknown'} ` +
          `transactionId=${transactionId}`,
      );
      return {
        received: true,
        outcome: 'IGNORED',
        status: 'UNCHANGED',
        transactionId,
      };
    }

    // ─── Gate 2: truth, from PhonePe's own APIs ────────────────────────
    const verification =
      kind === 'REFUND'
        ? await this.provider.fetchVerifiedRefundOutcome(transactionId)
        : await this.provider.fetchVerifiedOutcome(transactionId);

    if (!verification) {
      // The event named an order PhonePe itself has no record of. Either the
      // event is forged despite a valid header, or PhonePe is inconsistent.
      // Either way nothing is applied.
      this.logger.error(
        `PhonePe webhook named an order PhonePe has no record of ` +
          `event=${event ?? 'unknown'} transactionId=${transactionId}`,
      );
      throw new BadRequestException({
        error: 'PAYMENT_NOT_FOUND_AT_PROVIDER',
        message: 'The payment provider has no record of this transaction',
      });
    }

    if (!verification.status) {
      // PhonePe reports a state we do not act on (e.g. a still-pending order,
      // or a refund that has not completed). Acknowledge without changing
      // anything; the expiry sweep and the verify endpoint remain the
      // backstops.
      this.logger.log(
        `PhonePe webhook not actionable event=${event ?? 'unknown'} ` +
          `transactionId=${transactionId} rawStatus=${verification.rawStatus ?? 'none'}`,
      );
      return {
        received: true,
        outcome: 'IGNORED',
        status: verification.rawStatus ?? 'UNCHANGED',
        transactionId,
      };
    }

    const applied = await this.paymentsService.applyVerifiedOutcome(
      verification,
      'WEBHOOK',
    );

    this.logger.log(
      `PhonePe webhook processed event=${event ?? 'unknown'} ` +
        `paymentId=${applied.paymentId} transactionId=${applied.transactionId} ` +
        `outcome=${applied.outcome} status=${applied.status} ` +
        `walletCredited=${applied.walletCredited}`,
    );

    return {
      received: true,
      outcome: applied.outcome,
      status: applied.status,
      transactionId: applied.transactionId,
    };
  }

  /**
   * Wraps {@link handle} for the HTTP layer, converting an upstream PhonePe
   * outage into a 503 so PhonePe RETRIES the event rather than treating it as
   * delivered. Authentication and payload failures are left as-is — those must
   * not be retried.
   */
  async handleWithRetrySemantics(
    authorizationHeader: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<WebhookProcessingResult> {
    try {
      return await this.handle(authorizationHeader, payload);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        this.logger.error(
          'PhonePe webhook could not be verified against the provider; ' +
            'responding 503 so PhonePe retries the event',
        );
      }
      throw error;
    }
  }
}
