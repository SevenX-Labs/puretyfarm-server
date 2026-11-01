import { IsDateString, IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class AdminSkipDeliveryDto {
  @IsDateString(
    {},
    { message: 'deliveryDate must be a valid date (YYYY-MM-DD)' },
  )
  deliveryDate: string;

  @IsString({ message: 'note must be a string' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'A reason is required when an admin skips a delivery' })
  @MaxLength(1000, { message: 'note must be at most 1000 characters' })
  note: string;
}
