import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Confirms that the physical cash for a top-up was received.
 *
 * This is the operational gate that credits the wallet, so the confirming
 * admin's identity must be unforgeable: `adminId` is NOT a field here and is
 * always taken from JWT.sub. The amount is not a field either — it comes from
 * the credit request, so a confirmation can never change what is credited.
 */
export class ConfirmCashCollectionDto {
  @IsOptional()
  @IsString({ message: 'note must be a string' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(1000, { message: 'note must be at most 1000 characters' })
  note?: string;
}
