export enum WalletCreditRequestStatus {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  REJECTED = "REJECTED",
}

export enum WalletRefundStatus {
  NOT_REQUIRED = "NOT_REQUIRED",
  REFUND_PENDING = "REFUND_PENDING",
  REFUNDED = "REFUNDED",
  REFUND_FAILED = "REFUND_FAILED",
}

export enum WalletTransactionType {
  CREDIT = "CREDIT",
  DEBIT = "DEBIT",
}

export enum WalletTransactionReferenceType {
  CREDIT_REQUEST = "CREDIT_REQUEST",
  ORDER = "ORDER",
}

export const WALLET_CREDIT_MIN_PAISE_DEFAULT = 100;
export const WALLET_CREDIT_MAX_PAISE_DEFAULT = 10_000_00;
export const WALLET_MAX_BALANCE_PAISE = 2_000_000_00;
