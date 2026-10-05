import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentsService } from '../../payments/payments.service';

/**
 * Expires PayU payments the customer never completed.
 *
 * Why this job exists:
 *   A customer who starts PayU Hosted Checkout and then closes the tab leaves
 *   a `Payment` row stuck in PENDING and its `WalletCreditRequest` stuck in
 *   PENDING. The one-PENDING-per-wallet database index would then block every
 *   future top-up for that customer. The browser callback and the webhook
 *   never fire for an abandoned checkout, so nothing else closes the row.
 *
 * What the job does:
 *   Delegates to the existing, already-tested `PaymentsService.expireStalePayments()`.
 *   That method is the ONLY place that performs the PENDING/PROCESSING ->
 *   EXPIRED transition and the subsequent `cancelCreditRequest(..., "...expired...")`
 *   call that releases the pending slot. The scheduler intentionally contains
 *   no business logic of its own.
 *
 * What the job explicitly does NOT do:
 *   - Approve any payment or wallet credit request.
 *   - Credit any wallet.
 *   - Settle a successful payment (the webhook does that).
 *   - Confirm cash (an admin does that).
 *   - Trigger a refund.
 *   - Touch the WalletService auto-credit decision.
 *
 * Idempotency:
 *   `expireStalePayments()` uses conditional `updateMany` guarded on the set
 *   of expirable statuses, so running the job twice (overlapping deploys, a
 *   previous run that lagged, a manual re-trigger) is safe: the second pass
 *   matches zero rows and credits nothing.
 */
@Injectable()
export class PaymentExpiryJob {
  private readonly logger = new Logger(PaymentExpiryJob.name);

  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Every ten minutes. Matches the typical PayU session timeout window
   * (`PAYMENT_EXPIRY_MINUTES_DEFAULT` = 30 min), so a stuck top-up is cleaned
   * up within one expiry interval of becoming stale.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'payment-expiry' })
  async handleExpiry(): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.paymentsService.expireStalePayments();
      // Only log when something actually happened so a quiet system does not
      // produce a continuous stream of "expired=0" lines in production.
      if (result.expired > 0) {
        this.logger.log(
          `payment-expiry job=complete expired=${result.expired} ` +
            `durationMs=${Date.now() - startedAt}`,
        );
      }
    } catch (error) {
      // Must never throw out of the handler: an uncaught rejection from a
      // scheduled task would crash the Nest process. Log the error class only
      // so no payment payload or provider secret leaks into logs.
      this.logger.error(
        `payment-expiry job=failed durationMs=${Date.now() - startedAt} ` +
          `reason=${error instanceof Error ? error.name : 'UnknownError'}`,
      );
    }
  }
}
