import { PaymentTransactionStatus } from '../payments.constants';

/**
 * Provider-agnostic payment gateway abstraction.
 *
 * `PaymentsService` depends only on this contract so a second gateway can be
 * added without touching payment business logic. Named with the `I` prefix
 * following the `IProfileStorageService` convention, and so it cannot collide
 * with the Prisma `PaymentProviderType` enum.
 */

/** Everything the provider needs to start a hosted-checkout payment. */
export interface CreateProviderPaymentInput {
  /** Server-generated merchant transaction id. */
  transactionId: string;
  /** INTEGER PAISE. Converted to the provider's format by the provider itself. */
  amountPaise: number;
  /** Short description of what is being paid for. Never customer-supplied. */
  productInfo: string;
  customerFirstName: string;
  customerEmail: string;
  customerPhone: string;
}

/**
 * Everything the frontend needs to hand the customer to hosted checkout.
 * Contains no secret.
 *
 * Two shapes, distinguished by `method`, so one contract covers both kinds of
 * hosted checkout this project has used:
 *
 *  - `POST`     — a signed browser form POST. `endpoint` is the form action and
 *                 `fields` are the exact fields to submit (PayU Hosted
 *                 Checkout).
 *  - `REDIRECT` — a provider-generated one-time URL. `redirectUrl` (and
 *                 `endpoint`, which carries the same value) is where the
 *                 browser must be navigated; `fields` is empty (PhonePe
 *                 Standard Checkout v2).
 */
export interface ProviderCheckoutInstruction {
  /**
   * Where to send the customer: the form action for `POST`, or the checkout
   * URL for `REDIRECT`. Always populated, for both shapes.
   */
  endpoint: string;
  /** How the frontend must hand the customer over. */
  method: 'POST' | 'REDIRECT';
  /** Exact form fields for a `POST` checkout. Empty for `REDIRECT`. */
  fields: Record<string, string>;
  /**
   * The checkout URL to navigate to, present only for `REDIRECT`. Duplicated
   * from `endpoint` so a client can branch on the field it recognises.
   */
  redirectUrl?: string;
  /** Provider-side order/transaction reference, when known at creation time. */
  providerOrderId?: string;
  /** Epoch milliseconds after which the provider will reject this checkout. */
  expiresAt?: number;
}

/** Normalised outcome of verifying an untrusted provider message. */
export interface ProviderVerificationResult {
  /** True only when the signature/hash check passed. */
  signatureValid: boolean;
  /** Merchant transaction id echoed by the provider. */
  transactionId: string | null;
  /** Provider-side payment id, when present. */
  providerPaymentId: string | null;
  /** Amount the provider reports, in INTEGER PAISE. */
  amountPaise: number | null;
  /** Provider status mapped onto our own lifecycle. */
  status: PaymentTransactionStatus | null;
  /** Raw provider status string, for logging and diagnostics. */
  rawStatus: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  /** Payload with all signing/card material stripped, safe to persist. */
  sanitisedPayload: Record<string, unknown>;
}

/** Result of asking the provider to refund a settled payment. */
export interface ProviderRefundResult {
  /** True when the provider accepted the refund request. */
  accepted: boolean;
  /** Provider refund reference, when the provider returns one. */
  providerRefundId: string | null;
  /** Raw provider message, for logging. */
  message: string | null;
}

export interface IPaymentProvider {
  /**
   * Builds the hosted-checkout instruction for a payment that has already been
   * persisted. Performs no network call and never returns the signing secret.
   */
  createPayment(
    input: CreateProviderPaymentInput,
  ): Promise<ProviderCheckoutInstruction>;

  /**
   * Verifies an untrusted provider payload (browser callback or webhook) and
   * normalises it. MUST return `signatureValid: false` rather than throwing
   * when the hash does not match, so callers can log and reject uniformly.
   */
  verifyPayment(
    payload: Record<string, unknown>,
  ): Promise<ProviderVerificationResult>;

  /**
   * Requests a refund from the provider. Returning `accepted: true` means the
   * provider accepted the REQUEST only — the refund is confirmed later via a
   * verified webhook, never optimistically.
   */
  refundPayment(input: {
    transactionId: string;
    providerPaymentId: string;
    amountPaise: number;
    reason: string;
  }): Promise<ProviderRefundResult>;
}

/** DI token for the active payment provider implementation. */
export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';
