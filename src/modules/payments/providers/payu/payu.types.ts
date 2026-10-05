/**
 * Strongly typed PayU request and response payloads.
 *
 * Inbound types describe what PayU CLAIMS, never what is true. Nothing from
 * these shapes is trusted until `PayuHashService` has verified the reverse
 * hash over the exact same values.
 */

/** Fields posted to PayU Hosted Checkout. */
export interface PayuCheckoutFields {
  key: string;
  txnid: string;
  /** Rupee-decimal string derived from integer paise, e.g. "1000.00". */
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  phone: string;
  /** Success callback URL, built server-side. */
  surl: string;
  /** Failure callback URL, built server-side. */
  furl: string;
  udf1: string;
  udf2: string;
  udf3: string;
  udf4: string;
  udf5: string;
  /** SHA-512 request hash. Computed server-side; never client-supplied. */
  hash: string;
}

/** Inputs to the forward (request) hash. */
export interface PayuRequestHashInput {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
}

/**
 * The payload PayU posts back to `surl` / `furl` and to the webhook. Every
 * field is optional because the payload is untrusted input that may be
 * malformed, partial, or forged.
 */
export interface PayuCallbackPayload {
  key?: string;
  txnid?: string;
  amount?: string;
  productinfo?: string;
  firstname?: string;
  email?: string;
  phone?: string;
  status?: string;
  /** PayU's own payment id. */
  mihpayid?: string;
  /** Returned `hash` that must match our recomputed reverse hash. */
  hash?: string;
  /** Present on some flows; when present it prefixes the reverse hash. */
  additionalCharges?: string;
  /** Alternate spelling PayU uses on some integrations. */
  additional_charges?: string;
  error?: string;
  error_Message?: string;
  error_code?: string;
  field9?: string;
  unmappedstatus?: string;
  mode?: string;
  bank_ref_num?: string;
  bankcode?: string;
  PG_TYPE?: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  [key: string]: unknown;
}

/** Shape of a merchant post-service response envelope. */
export interface PayuPostServiceResponse {
  status?: number | string;
  msg?: string;
  /** Present on `cancel_refund_transaction`: the refund request reference. */
  request_id?: string | number;
  bank_ref_num?: string;
  mihpayid?: string;
  transaction_details?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Normalised result of a `cancel_refund_transaction` call. */
export interface PayuRefundResponse {
  accepted: boolean;
  requestId: string | null;
  message: string | null;
}
