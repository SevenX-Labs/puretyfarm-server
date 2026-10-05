import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayuHashService } from './payu.hash.service';
import {
  PAYU_COMMAND_CANCEL_REFUND,
  PAYU_COMMAND_VERIFY_PAYMENT,
  PAYU_POST_SERVICE_URL,
  PAYU_REQUEST_TIMEOUT_MS,
} from './payu.constants';
import { PayuPostServiceResponse, PayuRefundResponse } from './payu.types';

/**
 * Owns every outbound HTTP call to PayU.
 *
 * Follows the `GeoapifyService` convention: native fetch with an
 * AbortController timeout, upstream problems surfaced as
 * ServiceUnavailableException, and credentials never logged. No business rules
 * live here — this class only speaks PayU's wire protocol.
 */
@Injectable()
export class PayuClient {
  private readonly logger = new Logger(PayuClient.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly hashService: PayuHashService,
  ) {}

  private getMerchantKey(): string {
    const key = this.configService.get<string>('PAYU_KEY');
    if (!key) {
      this.logger.error('PayU is not configured');
      throw new ServiceUnavailableException(
        'Payment provider is not configured',
      );
    }
    return key;
  }

  /**
   * Server-to-server confirmation of a transaction's real state, independent
   * of anything the browser or a webhook claimed. Used by the customer-facing
   * verify endpoint so a payment is never settled on client assertion alone.
   */
  async verifyPayment(transactionId: string): Promise<PayuPostServiceResponse> {
    return this.postCommand(PAYU_COMMAND_VERIFY_PAYMENT, [transactionId]);
  }

  /**
   * Requests a refund. PayU's `cancel_refund_transaction` takes the PayU
   * payment id, a merchant-side refund token and the amount in rupees.
   *
   * A successful response means PayU ACCEPTED the request. The refund is only
   * treated as complete when a verified webhook confirms it.
   */
  async refund(input: {
    providerPaymentId: string;
    refundToken: string;
    amountRupees: string;
  }): Promise<PayuRefundResponse> {
    const response = await this.postCommand(PAYU_COMMAND_CANCEL_REFUND, [
      input.providerPaymentId,
      input.refundToken,
      input.amountRupees,
    ]);

    // PayU signals acceptance with status === 1 (as number or string).
    const accepted =
      response.status === 1 ||
      response.status === '1' ||
      String(response.status ?? '').toLowerCase() === 'success';

    const requestId =
      response.request_id !== undefined && response.request_id !== null
        ? String(response.request_id)
        : null;

    return {
      accepted,
      requestId,
      message: typeof response.msg === 'string' ? response.msg : null,
    };
  }

  /**
   * Posts a merchant post-service command.
   *
   * The command hash covers only `var1` (PayU's documented formula:
   * key|command|var1|salt), so the hash is always computed from the first
   * variable even when more are sent.
   */
  private async postCommand(
    command: string,
    vars: string[],
  ): Promise<PayuPostServiceResponse> {
    const key = this.getMerchantKey();
    const var1 = vars[0] ?? '';
    const hash = this.hashService.generateCommandHash(key, command, var1);

    const body = new URLSearchParams();
    body.set('key', key);
    body.set('command', command);
    body.set('hash', hash);
    vars.forEach((value, index) => body.set(`var${index + 1}`, value));

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PAYU_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(PAYU_POST_SERVICE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Status code only — the response body may echo request parameters.
        this.logger.error(
          `PayU post-service returned HTTP ${response.status} for command=${command}`,
        );
        throw new ServiceUnavailableException(
          'Payment provider is currently unavailable',
        );
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as PayuPostServiceResponse;
      } catch {
        this.logger.error(
          `PayU post-service returned a non-JSON body for command=${command}`,
        );
        throw new ServiceUnavailableException(
          'Payment provider returned an unreadable response',
        );
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      // Covers network failures and the AbortController timeout. The error is
      // logged by name only so no request parameters leak into logs.
      this.logger.error(
        `PayU post-service call failed for command=${command}: ${
          error instanceof Error ? error.name : 'UnknownError'
        }`,
      );
      throw new ServiceUnavailableException(
        'Payment provider is currently unavailable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
