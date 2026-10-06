export enum WalletCreditRequestStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  REJECTED = 'REJECTED',
  /**
   * The funding for this request never arrived: a PayU payment that failed,
   * was cancelled or expired, or a cancelled cash collection. Distinct from
   * REJECTED, which is an admin decision about money that WAS received and so
   * implies a refund. CANCELLED carries no refund obligation and releases the
   * one-PENDING-per-wallet slot.
   */
  CANCELLED = 'CANCELLED',
}

export enum WalletRefundStatus {
  NOT_REQUIRED = 'NOT_REQUIRED',
  REFUND_PENDING = 'REFUND_PENDING',
  REFUNDED = 'REFUNDED',
  REFUND_FAILED = 'REFUND_FAILED',
}

export enum WalletTransactionType {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

export enum WalletTransactionReferenceType {
  CREDIT_REQUEST = 'CREDIT_REQUEST',
  ORDER = 'ORDER',
  PLAN_SELECTION = 'PLAN_SELECTION',
}

export const WALLET_CREDIT_MIN_PAISE_DEFAULT = 100;
export const WALLET_CREDIT_MAX_PAISE_DEFAULT = 10_000_00;
export const WALLET_MAX_BALANCE_PAISE = 2_000_000_00;
