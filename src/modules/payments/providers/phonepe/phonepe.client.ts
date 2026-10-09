import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PhonePeAuthService } from './phonepe.auth.service';
import {
  PHONEPE_ORDER_STATUS_PATH,
  PHONEPE_PAY_PATH,
  PHONEPE_REFUND_PATH,
  PHONEPE_REFUND_STATUS_PATH,
  PHONEPE_REQUEST_TIMEOUT_MS,
  PHONEPE_TOKEN_TYPE,
} from './phonepe.constants';
import {
  PhonePeCreateOrderRequest,
  PhonePeCreateOrderResponse,
  PhonePeOrderStatusResponse,
  PhonePeRefundResponse,
  PhonePeRefundStatusResponse,
} from './phonepe.types';

/** One decoded PhonePe HTTP response plus the status code that carried it. */
interface PhonePeHttpResult<T> {
  httpStatus: number;
  body: T;
}

/**
 * Owns every outbound HTTP call to PhonePe.
 *
 * Mirrors {@link PayuClient}: native fetch with an AbortController timeout,
 * upstream problems surfaced as ServiceUnavailableException, and credentials
 * never logged. No business rules live here — this class only speaks PhonePe's
 * wire protocol. The OAuth token comes from {@link PhonePeAuthService}.
 *
 * On a 401 the token is invalidated and the call is retried exactly once, so a
 * token that PhonePe rotated or revoked early does not fail a customer payment.
 */
@Injectable()
export class PhonePeClient {
  private readonly logger = new Logger(PhonePeClient.name);

  constructor(private readonly auth: PhonePeAuthService) {}

  /**
   * Creates a Standard Checkout order.
   *
   * A `BAD_REQUEST` from PhonePe for an order id that already exists in a
   * non-CREATED state is translated into a ConflictException rather than a
   * 503: it means a payment attempt for this transaction is already underway,
   * which the caller must surface to the customer instead of retrying.
   */
  async createOrder(
    request: PhonePeCreateOrderRequest,
  ): Promise<PhonePeCreateOrderResponse> {
    const result = await this.request<PhonePeCreateOrderResponse>(
      'POST',
      PHONEPE_PAY_PATH,
      request,
    );

    if (result.httpStatus >= 400 || !result.body?.redirectUrl) {
      const code = result.body?.code ?? 'UNKNOWN';

      if (result.httpStatus === 400) {
        this.logger.error(
          `PhonePe rejected order creation merchantOrderId=${request.merchantOrderId} ` +
            `httpStatus=${result.httpStatus} code=${code}`,
        );
        throw new ConflictException({
          error: 'PAYMENT_ALREADY_IN_PROGRESS',
          message:
            'A payment attempt for this transaction is already in progress. Check its status before starting a new one.',
        });
      }

      this.logger.error(
        `PhonePe order creation failed merchantOrderId=${request.merchantOrderId} ` +
          `httpStatus=${result.httpStatus} code=${code}`,
      );
      throw new ServiceUnavailableException(
        'Payment provider is currently unavailable',
      );
    }

    return result.body;
  }

  /**
   * Server-to-server confirmation of an order's real state, independent of
   * anything the browser or a webhook claimed. This is the ONLY source of
   * truth for whether a PhonePe payment succeeded.
   *
   * Returns null when PhonePe has no record of the order (HTTP 404), which is
   * the equivalent of PayU returning no `transaction_details` entry: the
   * customer never started paying.
   */
  async getOrderStatus(
    merchantOrderId: string,
  ): Promise<PhonePeOrderStatusResponse | null> {
    const path = PHONEPE_ORDER_STATUS_PATH.replace(
      '{merchantOrderId}',
      encodeURIComponent(merchantOrderId),
    );

    const result = await this.request<PhonePeOrderStatusResponse>(
      'GET',
      `${path}?details=false`,
    );

    if (result.httpStatus === 404) {
      return null;
    }

    if (result.httpStatus >= 400 || !result.body?.state) {
      this.logger.error(
        `PhonePe order status failed merchantOrderId=${merchantOrderId} ` +
          `httpStatus=${result.httpStatus} code=${result.body?.code ?? 'UNKNOWN'}`,
      );
      throw new ServiceUnavailableException(
        'Payment provider is currently unavailable',
      );
    }

    return result.body;
  }

  /**
   * Requests a refund.
   *
   * A successful response means PhonePe ACCEPTED the request (`state:
   * PENDING`). The refund is only treated as complete once a verified refund
   * event or a refund-status check reports COMPLETED.
   *
   * Does not throw on a provider-side rejection: the caller maps
   * `accepted: false` onto its own retry/release logic, exactly as the PayU
   * client did.
   */
  async refund(input: {
    merchantRefundId: string;
    originalMerchantOrderId: string;
    amountPaise: number;
  }): Promise<{
    accepted: boolean;
    refundId: string | null;
    state: string | null;
    message: string | null;
  }> {
    const result = await this.request<PhonePeRefundResponse>(
      'POST',
      PHONEPE_REFUND_PATH,
      {
        merchantRefundId: input.merchantRefundId,
        originalMerchantOrderId: input.originalMerchantOrderId,
        amount: input.amountPaise,
      },
    );

    const accepted = result.httpStatus < 400 && !!result.body?.refundId;

    if (!accepted) {
      this.logger.error(
        `PhonePe refund not accepted merchantRefundId=${input.merchantRefundId} ` +
          `httpStatus=${result.httpStatus} code=${result.body?.code ?? 'UNKNOWN'}`,
      );
    }

    return {
      accepted,
      refundId: result.body?.refundId ?? null,
      state: result.body?.state ?? null,
      // PhonePe error messages describe the rejection reason and contain no
      // credential material, so they are safe to pass back to an admin.
      message:
        typeof result.body?.message === 'string' ? result.body.message : null,
    };
  }

  /**
   * Server-to-server confirmation of a refund's real state. Used to settle a
   * refund event rather than trusting the event's own `state` claim.
   *
   * Returns null when PhonePe has no record of the refund id.
   */
  async getRefundStatus(
    merchantRefundId: string,
  ): Promise<PhonePeRefundStatusResponse | null> {
    const path = PHONEPE_REFUND_STATUS_PATH.replace(
      '{merchantRefundId}',
      encodeURIComponent(merchantRefundId),
    );

    const result = await this.request<PhonePeRefundStatusResponse>('GET', path);

    if (result.httpStatus === 404) {
      return null;
    }

    if (result.httpStatus >= 400 || !result.body?.state) {
      this.logger.error(
        `PhonePe refund status failed merchantRefundId=${merchantRefundId} ` +
          `httpStatus=${result.httpStatus} code=${result.body?.code ?? 'UNKNOWN'}`,
      );
      throw new ServiceUnavailableException(
        'Payment provider is currently unavailable',
      );
    }

    return result.body;
  }

  /**
   * Performs one authenticated JSON call, retrying once after a 401 with a
   * freshly minted token.
   *
   * Returns the decoded body alongside the HTTP status instead of throwing on
   * 4xx, because PhonePe uses 4xx bodies to describe outcomes the callers
   * above need to distinguish (duplicate order, unknown order, rejected
   * refund). Transport-level failures still throw.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<PhonePeHttpResult<T>> {
    const first = await this.send<T>(method, path, body);

    if (first.httpStatus !== 401) {
      return first;
    }

    // The token was rejected. Discard it and try once with a new one; a second
    // 401 is returned to the caller as-is.
    this.auth.invalidateToken();
    this.logger.warn(
      `PhonePe returned 401 for ${method} ${this.redactPath(path)}; retrying with a fresh token`,
    );
    return this.send<T>(method, path, body);
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<PhonePeHttpResult<T>> {
    const token = await this.auth.getAccessToken();
    const url = `${this.auth.getPgBaseUrl()}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PHONEPE_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `${PHONEPE_TOKEN_TYPE} ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();

      let parsed: T;
      try {
        parsed = (text ? JSON.parse(text) : {}) as T;
      } catch {
        this.logger.error(
          `PhonePe returned a non-JSON body for ${method} ${this.redactPath(path)} ` +
            `httpStatus=${response.status}`,
        );
        throw new ServiceUnavailableException(
          'Payment provider returned an unreadable response',
        );
      }

      return { httpStatus: response.status, body: parsed };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      // Covers network failures and the AbortController timeout. Logged by
      // error class name only so no request material leaks into logs.
      this.logger.error(
        `PhonePe call failed for ${method} ${this.redactPath(path)}: ${
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

  /** Strips the query string so nothing path-embedded is logged verbatim. */
  private redactPath(path: string): string {
    return path.split('?')[0];
  }
}
