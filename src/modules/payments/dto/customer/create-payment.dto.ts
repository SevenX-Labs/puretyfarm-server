import { IsEnum, IsInt, Max, Min } from 'class-validator';
import { PaymentMethod } from '../../payments.constants';

/**
 * Starts a wallet top-up.
 *
 * Deliberately minimal. The customer supplies ONLY how much and how they wish
 * to pay. Everything financially meaningful — the payable amount sent to PayU,
 * the transaction id, the payment status, the wallet balance and whether the
 * credit is approved — is derived server-side.
 *
 * `userId`, `status`, `adminId`, `walletBalance` and `refundStatus` are absent
 * on purpose: the global ValidationPipe runs with `whitelist: true`, so any
 * such field a client sends is stripped before this object is constructed.
 */
export class CreatePaymentDto {
  /** Top-up amount in INTEGER PAISE (₹1 = 100). Bounds are re-checked against the wallet's configured limits in the service. */
  @IsInt({ message: 'amount must be an integer (paise)' })
  @Min(1, { message: 'amount must be greater than 0' })
  @Max(2_147_483_647, { message: 'amount exceeds maximum allowed' })
  amount: number;

  /** ONLINE routes through PayU Hosted Checkout; CASH creates a cash collection. */
  @IsEnum(PaymentMethod, {
    message: `paymentMethod must be one of: ${Object.values(PaymentMethod).join(', ')}`,
  })
  paymentMethod: PaymentMethod;
}
