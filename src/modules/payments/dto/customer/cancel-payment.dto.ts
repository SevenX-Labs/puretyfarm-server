import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PAYMENT_TXNID_MAX_LENGTH } from '../../payments.constants';

/**
 * Cancels a wallet top-up whose online payment the customer abandoned before
 * paying (closed the PayU page, hit back, etc.).
 *
 * Only the transaction id is accepted. The server re-verifies the real state
 * with the provider before cancelling, so a payment PayU has already settled
 * as SUCCESS is never thrown away.
 */
export class CancelPaymentDto {
  @IsString({ message: 'transactionId must be a string' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(6, { message: 'transactionId is not valid' })
  @MaxLength(PAYMENT_TXNID_MAX_LENGTH, {
    message: 'transactionId is not valid',
  })
  transactionId: string;
}
