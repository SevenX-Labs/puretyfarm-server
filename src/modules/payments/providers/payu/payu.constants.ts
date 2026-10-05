/**
 * PayU endpoints and provider constants.
 *
 * Production endpoints only, as configured in the PayU merchant dashboard.
 */

/** PayU Hosted Checkout form action. */
export const PAYU_CHECKOUT_URL = 'https://secure.payu.in/_payment';

/** PayU merchant post-service, used for refunds and server-side verification. */
export const PAYU_POST_SERVICE_URL =
  'https://info.payu.in/merchant/postservice?form=2';

/** Network timeout for merchant post-service calls, matching GeoapifyService. */
export const PAYU_REQUEST_TIMEOUT_MS = 15000;

/** Merchant post-service commands used by this module. */
export const PAYU_COMMAND_VERIFY_PAYMENT = 'verify_payment';
export const PAYU_COMMAND_CANCEL_REFUND = 'cancel_refund_transaction';

/**
 * Order of the user-defined fields inside both hash formulas. PayU always
 * expects all five, in this order, even when empty.
 */
export const PAYU_UDF_KEYS = ['udf1', 'udf2', 'udf3', 'udf4', 'udf5'] as const;

/** Raw `status` values PayU reports in callbacks and webhooks. */
export const PAYU_STATUS_SUCCESS = 'success';
export const PAYU_STATUS_FAILURE = 'failure';
export const PAYU_STATUS_PENDING = 'pending';
export const PAYU_STATUS_IN_PROGRESS = 'in progress';
export const PAYU_STATUS_REFUNDED = 'refunded';

/**
 * Route segments for the PayU callbacks and webhook, exactly as registered in
 * the PayU dashboard. Kept here so `surl`/`furl` are derived from one place.
 */
export const PAYU_SUCCESS_CALLBACK_PATH = 'api/v1/payments/payu/success';
export const PAYU_FAILURE_CALLBACK_PATH = 'api/v1/payments/payu/failure';
export const PAYU_WEBHOOK_PATH = 'api/v1/payments/webhooks/payu';
