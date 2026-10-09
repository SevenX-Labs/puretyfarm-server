/**
 * PhonePe Payment Gateway (Standard Checkout v2) endpoints and constants.
 *
 * Production endpoints only, matching `PHONEPE_ENV=PRODUCTION` as configured
 * in the PhonePe merchant dashboard. The sandbox hosts are kept here so a
 * staging deployment can be pointed at pre-prod with `PHONEPE_ENV=SANDBOX`
 * without a code change, which is how the pre-release checklist is run.
 */

/** OAuth token host. Production tokens come from identity-manager, not the PG host. */
export const PHONEPE_PROD_AUTH_URL =
  'https://api.phonepe.com/apis/identity-manager/v1/oauth/token';
export const PHONEPE_SANDBOX_AUTH_URL =
  'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token';

/** Payment Gateway API base. All checkout/refund paths hang off this. */
export const PHONEPE_PROD_PG_BASE_URL = 'https://api.phonepe.com/apis/pg';
export const PHONEPE_SANDBOX_PG_BASE_URL =
  'https://api-preprod.phonepe.com/apis/pg-sandbox';

/** Standard Checkout order creation. POST, JSON. */
export const PHONEPE_PAY_PATH = '/checkout/v2/pay';

/** Order status by OUR merchant order id. `{merchantOrderId}` is substituted. */
export const PHONEPE_ORDER_STATUS_PATH =
  '/checkout/v2/order/{merchantOrderId}/status';

/** Refund initiation and refund status, keyed by our own merchant refund id. */
export const PHONEPE_REFUND_PATH = '/payments/v2/refund';
export const PHONEPE_REFUND_STATUS_PATH =
  '/payments/v2/refund/{merchantRefundId}/status';

/** OAuth grant type. The only one PhonePe supports for server integrations. */
export const PHONEPE_GRANT_TYPE = 'client_credentials';

/** Token type PhonePe issues; used verbatim as the Authorization prefix. */
export const PHONEPE_TOKEN_TYPE = 'O-Bearer';

/** Network timeout, matching the PayU client and GeoapifyService convention. */
export const PHONEPE_REQUEST_TIMEOUT_MS = 15000;

/**
 * Re-fetch the OAuth token this many seconds before `expires_at` so a token
 * never expires mid-request. PhonePe tokens are long-lived; the margin is
 * generous because the cost of a refresh is one extra HTTP call.
 */
export const PHONEPE_TOKEN_REFRESH_MARGIN_SECONDS = 120;

/** The only `paymentFlow.type` Standard Checkout accepts. */
export const PHONEPE_PAYMENT_FLOW_CHECKOUT = 'PG_CHECKOUT';

/**
 * `merchantOrderId` bounds from the PhonePe docs: max 63 characters, and no
 * special characters other than `_` and `-`. Our `PF…` transaction ids are
 * uppercase alphanumeric and ~20 characters, so they satisfy both; the
 * constants exist so the provider can assert rather than assume.
 */
export const PHONEPE_MERCHANT_ORDER_ID_MAX_LENGTH = 63;
export const PHONEPE_MERCHANT_ORDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** PhonePe rejects an order below ₹1. */
export const PHONEPE_MIN_AMOUNT_PAISE = 100;

/** `expireAfter` bounds, in seconds, from the create-order reference. */
export const PHONEPE_EXPIRE_AFTER_MIN_SECONDS = 300;
export const PHONEPE_EXPIRE_AFTER_MAX_SECONDS = 3600;

/** Order / payment-attempt / refund states PhonePe reports. */
export const PHONEPE_STATE_PENDING = 'PENDING';
export const PHONEPE_STATE_COMPLETED = 'COMPLETED';
export const PHONEPE_STATE_FAILED = 'FAILED';

/** Webhook event names selected in the PhonePe dashboard. */
export const PHONEPE_EVENT_ORDER_COMPLETED = 'checkout.order.completed';
export const PHONEPE_EVENT_ORDER_FAILED = 'checkout.order.failed';

/**
 * Refund webhook events. NOT currently selected in the dashboard — see the
 * configuration gaps in docs/customer/payments.md. Handled defensively so that
 * enabling them in the dashboard needs no code change.
 */
export const PHONEPE_EVENT_REFUND_COMPLETED = 'pg.refund.completed';
export const PHONEPE_EVENT_REFUND_FAILED = 'pg.refund.failed';

/**
 * Prefix for the `merchantRefundId` we send to PhonePe. Derived from the
 * merchant order id so a repeated refund attempt for the same payment is the
 * SAME request to PhonePe rather than a second refund — the same guarantee the
 * PayU `refundToken` gave.
 */
export const PHONEPE_REFUND_ID_PREFIX = 'RFND-';

/**
 * Route segment of the browser return URL handed to PhonePe as
 * `paymentFlow.merchantUrls.redirectUrl`.
 *
 * PhonePe returns the customer's browser here with a GET and no trustworthy
 * payload, so this route carries NO authority: it only triggers a
 * server-to-server status check and then forwards the browser to the frontend
 * result page, exactly as the PayU `surl`/`furl` handlers did.
 */
export const PHONEPE_REDIRECT_CALLBACK_PATH = 'api/v1/payments/phonepe/return';

/** Query parameter carrying our merchant order id on the return URL. */
export const PHONEPE_REDIRECT_TXN_PARAM = 'txnid';

/** The webhook route registered in the PhonePe dashboard. */
export const PHONEPE_WEBHOOK_PATH = 'api/v1/payments/webhooks/phonepe';
