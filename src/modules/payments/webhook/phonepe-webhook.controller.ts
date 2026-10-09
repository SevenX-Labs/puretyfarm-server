import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { PhonePeWebhookService } from './phonepe-webhook.service';

/**
 * The single public PhonePe webhook endpoint.
 *
 * POST /api/v1/payments/webhooks/phonepe
 *
 * This is the exact URL registered in the PhonePe dashboard:
 * https://api-puretyfarm.onrender.com/api/v1/payments/webhooks/phonepe
 *
 * Handles the `checkout.order.completed` and `checkout.order.failed` events
 * selected in the dashboard. There is deliberately no `/completed` or
 * `/failed` sub-route: one endpoint handles every event, distinguished by the
 * `event` field, and the outcome is then read from PhonePe's Order Status API
 * rather than from the event body.
 *
 * PUBLIC BY DESIGN — no JwtAuthGuard. PhonePe cannot present a customer JWT.
 * Security comes from the `Authorization` header, which PhonePe sets to
 * SHA256(username:password) using the webhook credentials configured in the
 * dashboard; only the holder of PHONEPE_WEBHOOK_PASSWORD can produce it. An
 * invalid header yields 403 and no state change.
 *
 * The body is accepted as a loose record and no DTO validation is applied,
 * because validating a forged payload would be meaningless — and because the
 * body is not what settles the payment. The header check is the gate; the
 * status API is the truth.
 */
@Controller(['api/v1/payments/webhooks', 'payments/webhooks'])
export class PhonePeWebhookController {
  constructor(private readonly webhookService: PhonePeWebhookService) {}

  @Post('phonepe')
  @HttpCode(HttpStatus.OK)
  async handlePhonePeWebhook(
    @Headers('authorization') authorization: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    return this.webhookService.handleWithRetrySemantics(
      authorization,
      payload ?? {},
    );
  }
}
