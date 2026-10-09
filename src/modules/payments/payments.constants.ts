/**
 * Payment module constants.
 *
 * Mirrors the Prisma enums as plain TypeScript enums, following the convention
 * established by `orders.constants.ts` and `wallet.constants.ts`, so services
 * and DTOs do not import generated Prisma types directly.
 */

/**
 * Payment gateways this project has used. PHONEPE is the active one;
 * PAYU is retained so historical Payment rows still deserialise and so the
 * cutover can be rolled back without a migration.
 */
export enum PaymentProviderType {
  PAYU = 'PAYU',
  PHONEPE = 'PHONEPE',
}

/** The gateway new payments are created against. */
export const ACTIVE_PAYMENT_PROVIDER = PaymentProviderType.PHONEPE;

export enum PaymentPurpose {
  ORDER = 'ORDER',
  WALLET_TOPUP = 'WALLET_TOPUP',
}

/**
 * Lifecycle of a single payment attempt.
 *
 * Deliberately NOT named `PaymentStatus`: that name is already taken by the
 * pre-existing `Order.paymentStatus` enum, which has different values.
 */
export enum PaymentTransactionStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
  REFUND_PENDING = 'REFUND_PENDING',
  REFUNDED = 'REFUNDED',
}

export enum PaymentMethod {
  ONLINE = 'ONLINE',
  CASH = 'CASH',
}

export enum CashCollectionStatus {
  PENDING = 'PENDING',
  COLLECTED = 'COLLECTED',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}

/**
 * Statuses a payment may legally transition OUT of when a verified provider
 * message reports success. Checked inside a conditional UPDATE so two
 * simultaneous callbacks can never both win.
 */
export const PAYMENT_SUCCESS_FROM_STATUSES: PaymentTransactionStatus[] = [
  PaymentTransactionStatus.PENDING,
  PaymentTransactionStatus.PROCESSING,
];

/** Statuses a payment may legally transition out of on a verified failure. */
export const PAYMENT_FAILURE_FROM_STATUSES: PaymentTransactionStatus[] = [
  PaymentTransactionStatus.PENDING,
  PaymentTransactionStatus.PROCESSING,
];

/** Statuses from which a refund may be initiated. */
export const PAYMENT_REFUNDABLE_FROM_STATUSES: PaymentTransactionStatus[] = [
  PaymentTransactionStatus.SUCCESS,
];

/** Terminal statuses: no further transition is ever applied. */
export const PAYMENT_TERMINAL_STATUSES: PaymentTransactionStatus[] = [
  PaymentTransactionStatus.FAILED,
  PaymentTransactionStatus.CANCELLED,
  PaymentTransactionStatus.EXPIRED,
  PaymentTransactionStatus.REFUNDED,
];

/**
 * Statuses that still allow a retry of the same wallet top-up intent. A
 * SUCCESS or in-flight payment is never retryable.
 */
export const PAYMENT_RETRYABLE_STATUSES: PaymentTransactionStatus[] = [
  PaymentTransactionStatus.FAILED,
  PaymentTransactionStatus.CANCELLED,
  PaymentTransactionStatus.EXPIRED,
];

/** Merchant transaction id prefix, mirroring the `PF` order-number prefix. */
export const PAYMENT_TXNID_PREFIX = 'PF';

/**
 * PayU rejected a `txnid` longer than 25 characters; PhonePe allows a
 * `merchantOrderId` of up to 63. The tighter bound is kept so the generated id
 * stays valid for either gateway during the rollback window.
 */
export const PAYMENT_TXNID_MAX_LENGTH = 25;

/** How long a created-but-unpaid payment stays claimable before it expires. */
export const PAYMENT_EXPIRY_MINUTES_DEFAULT = 30;

/**
 * Payment description sent to the gateway for a wallet top-up (PayU
 * `productinfo`, PhonePe `metaInfo.udf1`). Never customer-controlled.
 */
export const PAYMENT_WALLET_TOPUP_PRODUCT_INFO = 'PuretyFarm Wallet Top-up';

/** Only INR is supported today. */
export const PAYMENT_CURRENCY = 'INR';

/**
 * Provider payload keys that must never be persisted in
 * `Payment.providerResponse`, so no signing material ever reaches the database
 * or an API response.
 */
export const PROVIDER_RESPONSE_REDACTED_KEYS: string[] = [
  'hash',
  'salt',
  'key',
  // PhonePe: the webhook Authorization digest and OAuth bearer material.
  'authorization',
  'access_token',
  'accesstoken',
  'client_secret',
  'clientsecret',
  'card_token',
  'cardtoken',
  'cardnum',
  'card_no',
  'ccnum',
  'ccname',
  'ccvv',
  'ccexpmon',
  'ccexpyr',
  'token',
];
