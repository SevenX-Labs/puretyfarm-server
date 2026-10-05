import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { PayuWebhookService } from './payu-webhook.service';

/**
 * The single public PayU webhook endpoint.
 *
 * POST /api/v1/payments/webhooks/payu
 *
 * Handles the Successful, Failed and Refund events configured in the PayU
 * dashboard. There is deliberately no `/success`, `/failure` or `/refund`
 * sub-route: one endpoint handles all three, distinguished by the verified
 * `status` field in the payload.
 *
 * PUBLIC BY DESIGN — no JwtAuthGuard. PayU cannot present a customer JWT.
 * Security comes entirely from the SHA-512 reverse-hash check over the
 * payload, which only the holder of PAYU_SALT can produce. An invalid hash
 * yields 403 and no state change.
 *
 * The body is accepted as a loose record because PayU posts
 * `application/x-www-form-urlencoded` with a field set that varies by event;
 * no DTO validation is applied, because validating a forged payload would be
 * meaningless. The hash check is the gate.
 */
@Controller(['api/v1/payments/webhooks', 'payments/webhooks'])
export class PayuWebhookController {
  constructor(private readonly webhookService: PayuWebhookService) {}

  @Post('payu')
  @HttpCode(HttpStatus.OK)
  async handlePayuWebhook(@Body() payload: Record<string, unknown>) {
    return this.webhookService.handle(payload ?? {});
  }
}
