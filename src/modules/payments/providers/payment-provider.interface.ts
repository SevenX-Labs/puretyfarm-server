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
 * Contains no secret: the salt is used only to compute `fields.hash`.
 */
export interface ProviderCheckoutInstruction {
  /** Form action URL to POST the fields to. */
  endpoint: string;
  /** HTTP method the form must use. */
  method: 'POST';
  /** Exact form fields, including the server-computed hash. */
  fields: Record<string, string>;
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
