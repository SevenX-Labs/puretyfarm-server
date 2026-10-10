import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Confirms that the physical cash for a top-up or plan was received.
 */
export class ConfirmCashCollectionDto {
  @IsOptional()
  @IsString({ message: 'note must be a string' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(1000, { message: 'note must be at most 1000 characters' })
  note?: string;
}
