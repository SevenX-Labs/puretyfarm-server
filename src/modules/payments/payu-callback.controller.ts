import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import type { IPaymentProvider } from './providers/payment-provider.interface';
import { PaymentsService } from './payments.service';
import type { VerifiedMessageSource } from './payments.service';

/**
 * PayU browser callbacks (`surl` / `furl`).
 *
 * POST /api/v1/payments/payu/success
 * POST /api/v1/payments/payu/failure
 *
 * PUBLIC BY DESIGN — no JwtAuthGuard. PayU redirects the customer's BROWSER
 * here with a form POST, so there is no Authorization header to present. The
 * payload is untrusted and is only acted on after the SHA-512 reverse hash
 * verifies, exactly like the webhook.
 *
 * Which route PayU chose carries NO authority: hitting the success URL does
 * not make a payment successful. The verified `status` field decides the
 * outcome, so a customer who manually POSTs to `/success` changes nothing.
 *
 * GET variants exist because some PayU configurations redirect rather than
 * post; they are handled identically.
 */
@Controller(['api/v1/payments/payu', 'payments/payu'])
export class PayuCallbackController {
  private readonly logger = new Logger(PayuCallbackController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
    @Inject(PAYMENT_PROVIDER)
    private readonly provider: IPaymentProvider,
  ) {}

  @Post('success')
  async successCallback(
    @Body() payload: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.handle(payload ?? {}, 'CALLBACK_SUCCESS', res);
  }

  @Get('success')
  async successRedirect(
    @Query() payload: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.handle(payload ?? {}, 'CALLBACK_SUCCESS', res);
  }

  @Post('failure')
  async failureCallback(
    @Body() payload: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.handle(payload ?? {}, 'CALLBACK_FAILURE', res);
  }

  @Get('failure')
  async failureRedirect(
    @Query() payload: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.handle(payload ?? {}, 'CALLBACK_FAILURE', res);
  }

  /**
   * Verifies, applies, then redirects the browser to the frontend result page.
   *
   * The redirect carries only a transaction id and a coarse outcome. No
   * amount, no hash, no provider payload and nothing derived from PAYU_SALT
   * goes into the query string, because a URL ends up in browser history,
   * referrer headers and server logs.
   *
   * Errors are swallowed into a `result=error` redirect rather than surfacing
   * a JSON exception, because the audience here is a browser mid-payment. The
   * authoritative state is always available from the verify endpoint, and the
   * webhook independently settles the payment regardless of what the browser
   * does.
   */
  private async handle(
    payload: Record<string, unknown>,
    source: VerifiedMessageSource,
    res: Response,
  ): Promise<void> {
    let transactionId = '';
    let result = 'error';
    let status = '';

    try {
      const verification = await this.provider.verifyPayment(payload);
      transactionId = verification.transactionId ?? '';

      const applied = await this.paymentsService.applyVerifiedOutcome(
        verification,
        source,
      );

      transactionId = applied.transactionId;
      status = applied.status;
      result = applied.walletCredited
        ? 'wallet_credited'
        : applied.requiresAdminApproval
          ? 'awaiting_approval'
          : 'recorded';

      this.logger.log(
        `PayU callback processed source=${source} paymentId=${applied.paymentId} ` +
          `transactionId=${applied.transactionId} status=${applied.status} ` +
          `outcome=${applied.outcome}`,
      );
    } catch (error) {
      // Log the failure reason by class name only; the payload may contain a
      // hash and must never be logged.
      this.logger.warn(
        `PayU callback rejected source=${source} ` +
          `transactionId=${transactionId || 'unknown'} ` +
          `reason=${error instanceof Error ? error.name : 'UnknownError'}`,
      );
    }

    res.redirect(this.buildRedirectUrl({ transactionId, result, status }));
  }

  /**
   * Builds the frontend redirect from configuration only. The target is never
   * taken from the payload, so a forged callback cannot turn this endpoint
   * into an open redirect.
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
