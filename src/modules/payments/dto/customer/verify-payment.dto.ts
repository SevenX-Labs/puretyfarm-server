import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PAYMENT_TXNID_MAX_LENGTH } from '../../payments.constants';

/**
 * Asks the server to re-check a payment's real state with PayU.
 *
 * The client identifies WHICH payment to check and nothing more. It cannot
 * assert an outcome: the status is fetched server-to-server from PayU, so a
 * client claiming `status=success` has no effect whatsoever.
 */
export class VerifyPaymentDto {
  @IsString({ message: 'transactionId must be a string' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(6, { message: 'transactionId is not valid' })
  @MaxLength(PAYMENT_TXNID_MAX_LENGTH, {
    message: 'transactionId is not valid',
  })
  transactionId: string;
}
