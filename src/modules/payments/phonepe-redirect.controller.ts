import { Controller, Get, Logger, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PhonePeService } from './providers/phonepe/phonepe.service';
import { PaymentsService } from './payments.service';
import { PHONEPE_REDIRECT_TXN_PARAM } from './providers/phonepe/phonepe.constants';
import { PaymentTransactionStatus } from './payments.constants';

/**
 * PhonePe browser return handler (`paymentFlow.merchantUrls.redirectUrl`).
 *
 * GET  /api/v1/payments/phonepe/return?txnid=…
 * POST /api/v1/payments/phonepe/return?txnid=…
 *
 * Replaces the PayU `surl` / `furl` pair. PhonePe uses ONE return URL for both
 * outcomes rather than two, so there is no `/success` and `/failure` split —
 * which removes a trap rather than creating one, since under PayU the chosen
 * route carried no authority either.
 *
 * PUBLIC BY DESIGN — no JwtAuthGuard. PhonePe returns the customer's BROWSER
 * here, so there is no Authorization header to present.
 *
 * This route carries NO authority whatsoever. PhonePe sends no trustworthy
 * payload with the return, so the handler ignores everything except the
 * `txnid` it put in the URL itself, and then asks PhonePe's Order Status API
 * what actually happened. Hitting this URL by hand cannot make a payment
 * successful; the worst a forged request achieves is an extra server-to-server
 * status check on an unguessable transaction id.
 *
 * The browser is then redirected to the SAME frontend result page, with the
 * SAME `txnid` / `result` / `status` query parameters, that the PayU callbacks
 * produced — so the existing result page needs no change.
 *
 * A POST variant exists because some providers post rather than redirect; it
 * is handled identically.
 */
@Controller(['api/v1/payments/phonepe', 'payments/phonepe'])
export class PhonePeRedirectController {
  private readonly logger = new Logger(PhonePeRedirectController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
    private readonly provider: PhonePeService,
  ) {}

  @Get('return')
  async returnRedirect(
    @Query(PHONEPE_REDIRECT_TXN_PARAM) transactionId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    return this.handle(transactionId, res);
  }

  @Post('return')
  async returnPost(
    @Query(PHONEPE_REDIRECT_TXN_PARAM) transactionId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    return this.handle(transactionId, res);
  }

  /**
   * Verifies with PhonePe, applies the outcome, then redirects the browser to
   * the frontend result page.
   *
   * The redirect carries only a transaction id and a coarse outcome. No
   * amount, no credential material and no provider payload goes into the query
   * string, because a URL ends up in browser history, referrer headers and
   * server logs.
   *
   * Errors are swallowed into a `result=error` redirect rather than surfacing
   * a JSON exception, because the audience here is a browser mid-payment. The
   * authoritative state is always available from the verify endpoint, and the
   * webhook independently settles the payment regardless of what the browser
   * does.
   */
  private async handle(
    transactionId: string | undefined,
    res: Response,
  ): Promise<void> {
    const txnid = typeof transactionId === 'string' ? transactionId.trim() : '';
    let result = 'error';
    let status = '';

    try {
      if (!txnid) {
        throw new Error('MissingTransactionId');
      }

      const verification = await this.provider.fetchVerifiedOutcome(txnid);

      if (!verification || !verification.status) {
        // PhonePe has no record, or reports a state we do not act on. Report
        // the return as pending rather than inventing an outcome.
        result = 'pending';
        status = verification?.rawStatus ?? '';
        this.logger.log(
          `PhonePe return not actionable transactionId=${txnid} ` +
            `rawStatus=${status || 'none'}`,
        );
      } else {
        const applied = await this.paymentsService.applyVerifiedOutcome(
          verification,
          verification.status === PaymentTransactionStatus.FAILED
            ? 'CALLBACK_FAILURE'
            : 'CALLBACK_SUCCESS',
        );

        status = applied.status;
        result = applied.walletCredited
          ? 'wallet_credited'
          : applied.requiresAdminApproval
            ? 'awaiting_approval'
            : 'recorded';

        this.logger.log(
          `PhonePe return processed paymentId=${applied.paymentId} ` +
            `transactionId=${applied.transactionId} status=${applied.status} ` +
            `outcome=${applied.outcome}`,
        );
      }
    } catch (error) {
      // Log the failure reason by class name only.
      this.logger.warn(
        `PhonePe return rejected transactionId=${txnid || 'unknown'} ` +
          `reason=${error instanceof Error ? error.name : 'UnknownError'}`,
      );
    }

    res.redirect(this.buildRedirectUrl({ transactionId: txnid, result, status }));
  }

  /**
   * Builds the frontend redirect from configuration only. The target is never
   * taken from the request, so a forged return cannot turn this endpoint into
   * an open redirect. Identical to the PayU callback's construction, including
   * the parameter names.
   */
  private buildRedirectUrl(params: {
    transactionId: string;
    result: string;
    status: string;
  }): string {
    const base =
      this.configService.get<string>('PAYMENT_RESULT_REDIRECT_URL') || '/';
    try {
      const url = new URL(base);
      if (params.transactionId) {
        url.searchParams.set('txnid', params.transactionId);
      }
      url.searchParams.set('result', params.result);
      if (params.status) {
        url.searchParams.set('status', params.status);
      }
      return url.toString();
    } catch {
      // Startup validation asserts an absolute URL; this is belt-and-braces.
      return base;
    }
  }
}
