import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PAYMENT_TXNID_MAX_LENGTH } from '../../payments.constants';

/**
 * Retries a wallet top-up whose previous online payment failed, was cancelled
 * or expired.
 *
 * The amount is intentionally NOT accepted here: it is re-read from the
 * original credit request so a retry can never change what is owed. A fresh
 * transaction id and hash are generated server-side.
 */
export class RetryPaymentDto {
  @IsString({ message: 'transactionId must be a string' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(6, { message: 'transactionId is not valid' })
  @MaxLength(PAYMENT_TXNID_MAX_LENGTH, {
    message: 'transactionId is not valid',
  })
  transactionId: string;
}
