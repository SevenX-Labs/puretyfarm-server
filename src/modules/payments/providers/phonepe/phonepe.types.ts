/**
 * Wire shapes for the PhonePe Standard Checkout v2 APIs and webhooks.
 *
 * Every field is optional and loosely typed on the response side: these are
 * untrusted payloads from an external service, so the provider narrows them
 * at runtime rather than trusting the declared type.
 */

/** POST body of the OAuth token call (sent form-urlencoded). */
export interface PhonePeAuthTokenResponse {
  access_token?: string;
  token_type?: string;
  /** Epoch SECONDS at which the token stops being accepted. */
  expires_at?: number;
  issued_at?: number;
}

/** `paymentFlow.merchantUrls` of the create-order request. */
export interface PhonePeMerchantUrls {
  redirectUrl: string;
}

/** Create-order request body. */
export interface PhonePeCreateOrderRequest {
  merchantOrderId: string;
  /** INTEGER PAISE. Minimum 100. */
  amount: number;
  /** Seconds. Clamped to [300, 3600] by the provider. */
  expireAfter: number;
  metaInfo?: Record<string, string>;
  paymentFlow: {
    type: string;
    merchantUrls: PhonePeMerchantUrls;
  };
}

/** Create-order success response. */
export interface PhonePeCreateOrderResponse {
  /** PhonePe-side order id. Stored as our `providerPaymentId`. */
  orderId?: string;
  state?: string;
  expireAt?: number;
  /** Where the customer's browser must be sent to pay. */
  redirectUrl?: string;
  /** Present on the error shapes instead of the above. */
  code?: string;
  message?: string;
}

/** One payment attempt inside an order-status or webhook payload. */
export interface PhonePePaymentAttempt {
  paymentMode?: string;
  transactionId?: string;
  timestamp?: number;
  amount?: number;
  state?: string;
  errorCode?: string;
  detailedErrorCode?: string;
}

/** Order status response, and the `payload` of a checkout.order.* webhook. */
export interface PhonePeOrderStatusResponse {
  orderId?: string;
  merchantId?: string;
  merchantOrderId?: string;
  state?: string;
  /** INTEGER PAISE. Documented as String, delivered as a number; both handled. */
  amount?: number | string;
  expireAt?: number;
  metaInfo?: Record<string, unknown>;
  paymentDetails?: PhonePePaymentAttempt[];
  errorCode?: string;
  detailedErrorCode?: string;
  code?: string;
  message?: string;
}

/** Refund initiation response. */
export interface PhonePeRefundResponse {
  /** PhonePe-side refund id. Stored as our `providerRefundId`. */
  refundId?: string;
  amount?: number;
  state?: string;
  code?: string;
  message?: string;
}

/** Refund status response, and the `payload` of a pg.refund.* webhook. */
export interface PhonePeRefundStatusResponse {
  merchantId?: string;
  merchantRefundId?: string;
  refundId?: string;
  originalMerchantOrderId?: string;
  amount?: number | string;
  state?: string;
  errorCode?: string;
  detailedErrorCode?: string;
  paymentDetails?: PhonePePaymentAttempt[];
  code?: string;
  message?: string;
}

/** Envelope of every PhonePe webhook event. */
export interface PhonePeWebhookEvent {
  event?: string;
  payload?: PhonePeOrderStatusResponse & PhonePeRefundStatusResponse;
}

/** Normalised, provider-agnostic view of a PhonePe order's real state. */
export interface PhonePeAuthoritativeOrder {
  /** Raw `state` as PhonePe reported it, or null when PhonePe has no record. */
  rawState: string | null;
  /** PhonePe-side order id. */
  orderId: string | null;
  amountPaise: number | null;
  /** Latest attempt's error codes, when the order failed. */
  errorCode: string | null;
  errorMessage: string | null;
  /**
   * True when PhonePe has at least one payment attempt on the order. An order
   * that exists but has NO attempt is a customer who never started paying,
   * which must not be read as "a payment is in flight".
   */
  hasAttempt: boolean;
}
