import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Cancels a cash collection: the cash was never collected, or was collected
 * and could not be reconciled.
 *
 * A reason is mandatory because this closes a customer's top-up request. As
 * with confirmation, `adminId` is never accepted from the body.
 *
 * No wallet credit and no refund result: nothing was ever credited, so the
 * linked credit request moves to CANCELLED, not REJECTED.
 */
export class RejectCashCollectionDto {
  @IsString({ message: 'note must be a string' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'A cancellation reason is required' })
  @MinLength(3, { message: 'note must be at least 3 characters' })
  @MaxLength(1000, { message: 'note must be at most 1000 characters' })
  note: string;
}
