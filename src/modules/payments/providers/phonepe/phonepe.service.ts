import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { PhonePeClient } from './phonepe.client';
import {
  PHONEPE_EVENT_ORDER_COMPLETED,
  PHONEPE_EVENT_ORDER_FAILED,
  PHONEPE_EVENT_REFUND_COMPLETED,
  PHONEPE_EVENT_REFUND_FAILED,
  PHONEPE_EXPIRE_AFTER_MAX_SECONDS,
  PHONEPE_EXPIRE_AFTER_MIN_SECONDS,
  PHONEPE_MERCHANT_ORDER_ID_MAX_LENGTH,
  PHONEPE_MERCHANT_ORDER_ID_PATTERN,
  PHONEPE_MIN_AMOUNT_PAISE,
  PHONEPE_PAYMENT_FLOW_CHECKOUT,
  PHONEPE_REDIRECT_CALLBACK_PATH,
  PHONEPE_REDIRECT_TXN_PARAM,
  PHONEPE_REFUND_ID_PREFIX,
  PHONEPE_STATE_COMPLETED,
  PHONEPE_STATE_FAILED,
  PHONEPE_STATE_PENDING,
} from './phonepe.constants';
import {
  PhonePeAuthoritativeOrder,
  PhonePeOrderStatusResponse,
  PhonePeWebhookEvent,
} from './phonepe.types';
import {
  CreateProviderPaymentInput,
  IPaymentProvider,
  ProviderCheckoutInstruction,
  ProviderRefundResult,
  ProviderVerificationResult,
} from '../payment-provider.interface';
import {
  PAYMENT_EXPIRY_MINUTES_DEFAULT,
  PaymentTransactionStatus,
} from '../../payments.constants';

/** What a PhonePe webhook event is about, once its envelope is read. */
export type PhonePeWebhookEventKind = 'ORDER' | 'REFUND' | 'UNKNOWN';

/**
 * PhonePe Standard Checkout v2 implementation of {@link IPaymentProvider}.
 *
 * Owns PhonePe-specific field names, state vocabulary and the webhook
 * authentication scheme. All network I/O is delegated to
 * {@link PhonePeClient} and all credential handling to
 * {@link PhonePeAuthService}. `PaymentsService` never sees anything in this
 * file except through the interface.
 *
 * Amounts need no conversion: PhonePe speaks integer paise, which is also this
 * project's internal unit, so the rupee-string round-trip PayU required is
 * gone and with it the class of rounding bugs it guarded against.
 */
@Injectable()
export class PhonePeService implements IPaymentProvider {
  private readonly logger = new Logger(PhonePeService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly client: PhonePeClient,
  ) {}

  // ══════════════════════════════════════════════════════════════════
  //  CHECKOUT
  // ══════════════════════════════════════════════════════════════════

  /**
   * Creates a PhonePe Standard Checkout order and returns the one-time
   * checkout URL.
   *
   * Unlike PayU Hosted Checkout, this IS a network call: PhonePe mints the
   * order server-side and returns `redirectUrl`. Callers invoke it only after
   * their database transaction has committed, so a slow provider never holds a
   * DB lock.
   *
   * `merchantOrderId` is our own server-generated transaction id, which keeps
   * every id, database relationship and reconciliation query unchanged from
   * the PayU integration.
   */
  async createPayment(
    input: CreateProviderPaymentInput,
  ): Promise<ProviderCheckoutInstruction> {
    this.assertMerchantOrderId(input.transactionId);

    if (
      !Number.isInteger(input.amountPaise) ||
      input.amountPaise < PHONEPE_MIN_AMOUNT_PAISE
    ) {
      // Amount bounds are enforced by WalletService before we get here; this
      // is the provider-specific floor (PhonePe rejects anything under ₹1).
      throw new InternalServerErrorException('Invalid payment amount');
    }

    const response = await this.client.createOrder({
      merchantOrderId: input.transactionId,
      amount: input.amountPaise,
      expireAfter: this.resolveExpireAfterSeconds(),
      // udf1 carries the same non-customer-supplied description PayU received
      // as `productinfo`, so support and reconciliation read the same text.
      // No customer PII is placed in metaInfo.
      metaInfo: { udf1: this.truncate(input.productInfo, 256) },
      paymentFlow: {
        type: PHONEPE_PAYMENT_FLOW_CHECKOUT,
        merchantUrls: {
          redirectUrl: this.buildReturnUrl(input.transactionId),
        },
      },
    });

    // The client guarantees redirectUrl is present on a success path.
    const redirectUrl = response.redirectUrl!;

    return {
      endpoint: redirectUrl,
      method: 'REDIRECT',
      fields: {},
      redirectUrl,
      providerOrderId: response.orderId ?? undefined,
      expiresAt:
        typeof response.expireAt === 'number'
          ? response.expireAt * 1000
          : undefined,
    };
  }

  /**
   * PhonePe payloads carry NO per-message signature, so this fails closed.
   *
   * PayU authenticated each message with a reverse hash over the payload, and
   * `verifyPayment` was that check. PhonePe's model is different: the webhook
   * is authenticated at the TRANSPORT level by the Authorization header (see
   * {@link verifyWebhookAuthorization}), and the payment outcome itself is
   * only ever taken from the server-to-server Order Status API (see
   * {@link fetchAuthoritativeStatus}).
   *
   * Returning `signatureValid: false` means that if any future caller routes a
   * raw PhonePe payload through this method, `applyVerifiedOutcome` rejects it
   * with 403 rather than acting on an unauthenticated claim.
   */
  async verifyPayment(
    payload: Record<string, unknown>,
  ): Promise<ProviderVerificationResult> {
    const event = payload as PhonePeWebhookEvent;
    const inner = event.payload ?? {};

    this.logger.warn(
      'PhonePe payload verification attempted; PhonePe payloads are not ' +
        'self-authenticating and are never trusted as proof of payment',
    );

    return {
      signatureValid: false,
      transactionId:
        typeof inner.merchantOrderId === 'string'
          ? inner.merchantOrderId
          : null,
      providerPaymentId:
        typeof inner.orderId === 'string' ? inner.orderId : null,
      amountPaise: this.toPaise(inner.amount),
      status: null,
      rawStatus: typeof inner.state === 'string' ? inner.state : null,
      failureCode: null,
      failureMessage: null,
      sanitisedPayload: {},
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  AUTHORITATIVE STATUS
  // ══════════════════════════════════════════════════════════════════

  /**
   * Server-to-server state check, used by the customer verify endpoint, the
   * cancel path and the webhook handler so the authoritative status always
   * comes from PhonePe rather than from a browser or an event body.
   *
   * Returns an all-null result in two cases, which callers treat identically
   * to PayU having no `transaction_details` entry:
   *   - PhonePe has no record of the order at all, and
   *   - the order exists but has no payment attempt yet (state PENDING with an
   *     empty `paymentDetails`), i.e. the customer never started paying.
   *
   * The second case matters: without it a freshly created, untouched PhonePe
   * order would read as PROCESSING and the customer could no longer cancel an
   * abandoned top-up, which is a behaviour PayU provided and this migration
   * must preserve.
   */
  async fetchAuthoritativeStatus(transactionId: string): Promise<{
    status: PaymentTransactionStatus | null;
    rawStatus: string | null;
    providerPaymentId: string | null;
    amountPaise: number | null;
  }> {
    const order = await this.fetchOrder(transactionId);

    if (!order) {
      return {
        status: null,
        rawStatus: null,
        providerPaymentId: null,
        amountPaise: null,
      };
    }

    return {
      status: this.mapOrderState(order.rawState, order.hasAttempt),
      rawStatus: order.rawState,
      providerPaymentId: order.orderId,
      amountPaise: order.amountPaise,
    };
  }

  /**
   * Full authoritative order view, including the failure codes and the
   * sanitised snapshot that gets persisted in `Payment.providerResponse`.
   *
   * Used by the webhook handler, which needs the error detail that the plain
   * {@link fetchAuthoritativeStatus} shape does not carry.
   */
  async fetchVerifiedOutcome(
    transactionId: string,
  ): Promise<ProviderVerificationResult | null> {
    const order = await this.fetchOrder(transactionId);
    if (!order) return null;

    return {
      // Authenticated by the credentials used to make the server-to-server
      // call, exactly as the PayU verify path was.
      signatureValid: true,
      transactionId,
      providerPaymentId: order.orderId,
      amountPaise: order.amountPaise,
      status: this.mapOrderState(order.rawState, order.hasAttempt),
      rawStatus: order.rawState,
      failureCode: order.errorCode,
      failureMessage: order.errorMessage,
      sanitisedPayload: {
        source: 'phonepe_order_status',
        state: order.rawState,
        orderId: order.orderId,
        amountPaise: order.amountPaise,
        errorCode: order.errorCode,
        detailedErrorCode: order.errorMessage,
      },
    };
  }

  /**
   * Authoritative refund state for a payment, derived from the refund status
   * API keyed on the merchant refund id we generate deterministically.
   *
   * Returns null when PhonePe has no record of the refund. A COMPLETED refund
   * maps onto REFUNDED, which is the only status that marks a refund done.
   */
  async fetchVerifiedRefundOutcome(
    transactionId: string,
  ): Promise<ProviderVerificationResult | null> {
    const refund = await this.client.getRefundStatus(
      this.buildMerchantRefundId(transactionId),
    );
    if (!refund) return null;

    const rawState =
      typeof refund.state === 'string' ? refund.state.trim() : null;

    return {
      signatureValid: true,
      transactionId,
      // A refund never changes which PhonePe order id the payment belongs to,
      // so this stays null and the stored value is left untouched.
      providerPaymentId: null,
      // Deliberately null: a partial refund's amount is NOT the payment
      // amount, and applyVerifiedOutcome rejects a mismatch. Refund amounts
      // are reconciled from providerResponse instead.
      amountPaise: null,
      status:
        rawState?.toUpperCase() === PHONEPE_STATE_COMPLETED
          ? PaymentTransactionStatus.REFUNDED
          : null,
      rawStatus: rawState,
      failureCode: refund.errorCode ?? null,
      failureMessage: refund.detailedErrorCode ?? null,
      sanitisedPayload: {
        source: 'phonepe_refund_status',
        state: rawState,
        refundId: refund.refundId ?? null,
        amountPaise: this.toPaise(refund.amount),
        errorCode: refund.errorCode ?? null,
        detailedErrorCode: refund.detailedErrorCode ?? null,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  REFUNDS
  // ══════════════════════════════════════════════════════════════════

  /**
   * Asks PhonePe to refund a settled payment.
   *
   * `merchantRefundId` is derived from the merchant order id, so repeated
   * refund attempts for the same payment are the same request to PhonePe
   * rather than two separate refunds — the guarantee PayU's `refundToken`
   * provided.
   *
   * PhonePe refunds reference `originalMerchantOrderId` (our transaction id),
   * not the provider-side payment id. `providerPaymentId` is therefore unused
   * here, but the caller still requires it to be present before refunding,
   * which remains a correct precondition: it is only ever set once PhonePe has
   * confirmed the payment.
   */
  async refundPayment(input: {
    transactionId: string;
    providerPaymentId: string;
    amountPaise: number;
    reason: string;
  }): Promise<ProviderRefundResult> {
    const result = await this.client.refund({
      merchantRefundId: this.buildMerchantRefundId(input.transactionId),
      originalMerchantOrderId: input.transactionId,
      amountPaise: input.amountPaise,
    });

    return {
      accepted: result.accepted,
      providerRefundId: result.refundId,
      message: result.message,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  WEBHOOK AUTHENTICATION
  // ══════════════════════════════════════════════════════════════════

  /**
   * Validates a PhonePe webhook `Authorization` header.
   *
   * PhonePe's SHA scheme: the header value is `SHA256(username:password)`,
   * hex-encoded, using the username and password configured for the webhook in
   * the PhonePe dashboard. This is the ONLY thing that authenticates a webhook
   * request, so it is checked before the payload is looked at at all.
   *
   * Deliberately tolerant of a scheme prefix (`SHA256 …`) and of hex casing,
   * because the dashboard documents the digest without pinning either, and
   * intolerant of everything else. Comparison is constant-time.
   *
   * Returns false — never throws — for a missing header or missing
   * configuration, so the caller rejects every failure on one path. A missing
   * credential is logged by NAME only.
   */
  verifyWebhookAuthorization(headerValue: string | undefined): boolean {
    const username = this.configService.get<string>('PHONEPE_WEBHOOK_USERNAME');
    const password = this.configService.get<string>('PHONEPE_WEBHOOK_PASSWORD');

    if (!username?.trim() || !password?.trim()) {
      this.logger.error(
        'PhonePe webhook credentials are not configured ' +
          '(PHONEPE_WEBHOOK_USERNAME / PHONEPE_WEBHOOK_PASSWORD)',
      );
      return false;
    }

    if (typeof headerValue !== 'string' || headerValue.trim().length === 0) {
      return false;
    }

    // Accept `<hex>` and `SHA256 <hex>`; reject anything else outright.
    const received = headerValue
      .trim()
      .replace(/^sha256\s+/i, '')
      .trim();

    const expected = createHash('sha256')
      .update(`${username.trim()}:${password.trim()}`, 'utf8')
      .digest('hex');

    return this.safeCompare(received, expected);
  }

  /**
   * Reads a webhook envelope without trusting any of it.
   *
   * Returns the event kind and the merchant order id to re-check, so the
   * webhook handler knows WHICH transaction to ask PhonePe about. The event's
   * own `state` is never used to decide an outcome.
   */
  interpretWebhookEvent(payload: Record<string, unknown>): {
    kind: PhonePeWebhookEventKind;
    event: string | null;
    transactionId: string | null;
  } {
    const envelope = payload as PhonePeWebhookEvent;
    const rawEvent =
      envelope.event ?? (envelope as Record<string, unknown>).type;
    const event = typeof rawEvent === 'string' ? rawEvent.trim() : null;
    const inner = (envelope.payload ?? {}) as Record<string, unknown>;

    const orderId =
      (typeof inner.merchantOrderId === 'string' && inner.merchantOrderId) ||
      (typeof inner.originalMerchantOrderId === 'string' &&
        inner.originalMerchantOrderId) ||
      (typeof inner.orderId === 'string' && inner.orderId) ||
      null;

    const normalized = (event ?? '').toLowerCase().replace(/_/g, '.');

    switch (normalized) {
      case 'checkout.order.completed':
      case 'checkout.order.failed':
        return { kind: 'ORDER', event, transactionId: orderId };

      case 'pg.refund.completed':
      case 'pg.refund.failed':
        return {
          kind: 'REFUND',
          event,
          transactionId:
            (typeof inner.originalMerchantOrderId === 'string' &&
              inner.originalMerchantOrderId) ||
            orderId,
        };

      default:
        return { kind: 'UNKNOWN', event, transactionId: orderId };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  INTERNALS
  // ══════════════════════════════════════════════════════════════════

  /** Fetches and normalises an order, or null when PhonePe has no record. */
  private async fetchOrder(
    merchantOrderId: string,
  ): Promise<PhonePeAuthoritativeOrder | null> {
    const response = await this.client.getOrderStatus(merchantOrderId);
    if (!response) return null;
    return this.normaliseOrder(response);
  }

  private normaliseOrder(
    response: PhonePeOrderStatusResponse,
  ): PhonePeAuthoritativeOrder {
    const attempts = Array.isArray(response.paymentDetails)
      ? response.paymentDetails
      : [];

    // Latest attempt first: the status API with details=false returns only the
    // most recent one, but a details=true response is ordered newest-first.
    const latest = attempts[0];

    return {
      rawState:
        typeof response.state === 'string' ? response.state.trim() : null,
      orderId: typeof response.orderId === 'string' ? response.orderId : null,
      amountPaise: this.toPaise(response.amount),
      errorCode: response.errorCode ?? latest?.errorCode ?? null,
      errorMessage:
        response.detailedErrorCode ?? latest?.detailedErrorCode ?? null,
      hasAttempt: attempts.length > 0,
    };
  }

  /**
   * Maps PhonePe's order vocabulary onto our lifecycle.
   *
   * An unrecognised state maps to null so an unknown provider state is never
   * optimistically read as success — the same rule the PayU mapping used.
   *
   * PENDING is split on `hasAttempt`: a created order nobody has paid yet is
   * not actionable (null), whereas a PENDING order with an attempt on it is a
   * capture in flight (PROCESSING).
   */
  private mapOrderState(
    rawState: string | null,
    hasAttempt: boolean,
  ): PaymentTransactionStatus | null {
    if (!rawState) return null;
    switch (rawState.trim().toUpperCase()) {
      case PHONEPE_STATE_COMPLETED:
        return PaymentTransactionStatus.SUCCESS;
      case PHONEPE_STATE_FAILED:
        return PaymentTransactionStatus.FAILED;
      case PHONEPE_STATE_PENDING:
        return hasAttempt ? PaymentTransactionStatus.PROCESSING : null;
      default:
        return null;
    }
  }

  /**
   * Builds the browser return URL from PUBLIC_API_BASE_URL so a client can
   * never point a payment result at a URL of its own choosing — the same rule
   * the PayU `surl`/`furl` construction followed.
   */
  private buildReturnUrl(transactionId: string): string {
    const base = this.configService.get<string>('PUBLIC_API_BASE_URL');
    if (!base) {
      this.logger.error('PUBLIC_API_BASE_URL is not configured');
      throw new InternalServerErrorException(
        'Payment provider is not configured',
      );
    }
    const url = new URL(
      `${base.replace(/\/+$/, '')}/${PHONEPE_REDIRECT_CALLBACK_PATH}`,
    );
    url.searchParams.set(PHONEPE_REDIRECT_TXN_PARAM, transactionId);
    return url.toString();
  }

  /**
   * Order lifetime handed to PhonePe, kept in step with the Payment row's own
   * `expiresAt` so the provider and our expiry sweep agree. Clamped to
   * PhonePe's documented [300, 3600] second bounds.
   */
  private resolveExpireAfterSeconds(): number {
    const configured = parseInt(
      this.configService.get<string>('PAYMENT_EXPIRY_MINUTES') ||
        String(PAYMENT_EXPIRY_MINUTES_DEFAULT),
      10,
    );
    const minutes =
      Number.isFinite(configured) && configured > 0
        ? configured
        : PAYMENT_EXPIRY_MINUTES_DEFAULT;

    return Math.min(
      PHONEPE_EXPIRE_AFTER_MAX_SECONDS,
      Math.max(PHONEPE_EXPIRE_AFTER_MIN_SECONDS, minutes * 60),
    );
  }

  /** Deterministic refund id, so a retried refund is never a second refund. */
  private buildMerchantRefundId(transactionId: string): string {
    return `${PHONEPE_REFUND_ID_PREFIX}${transactionId}`;
  }

  /**
   * Asserts our transaction id satisfies PhonePe's `merchantOrderId` rules
   * before it is sent, so a violation is a server error here rather than an
   * opaque provider rejection mid-checkout.
   */
  private assertMerchantOrderId(transactionId: string): void {
    if (
      typeof transactionId !== 'string' ||
      transactionId.length === 0 ||
      transactionId.length > PHONEPE_MERCHANT_ORDER_ID_MAX_LENGTH ||
      !PHONEPE_MERCHANT_ORDER_ID_PATTERN.test(transactionId)
    ) {
      this.logger.error(
        `Transaction id is not a valid PhonePe merchantOrderId (length=${
          typeof transactionId === 'string' ? transactionId.length : 0
        })`,
      );
      throw new InternalServerErrorException('Invalid payment reference');
    }
  }

  /**
   * Reads an amount PhonePe reports as integer paise.
   *
   * The docs type `amount` as String on the status response and as Long
   * elsewhere, so both are accepted — but only an exact integer is: a
   * fractional or malformed amount returns null and the amount check in
   * `applyVerifiedOutcome` is then skipped rather than compared against a
   * rounded value.
   */
  private toPaise(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!/^\d{1,15}$/.test(trimmed)) return null;
      const parsed = Number(trimmed);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
  }

  private truncate(value: string, max: number): string {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  /**
   * Constant-time hex comparison. Lower-cased first because the digest casing
   * is not pinned by PhonePe's docs, then length-checked, because
   * `timingSafeEqual` throws on unequal buffer lengths.
   */
  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a.trim().toLowerCase(), 'utf8');
    const bufB = Buffer.from(b.trim().toLowerCase(), 'utf8');
    if (bufA.length !== bufB.length) {
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }
}
