import { IsDateString, IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class AdminRescheduleDeliveryDto {
  @IsDateString(
    {},
    { message: 'fromDate must be a valid date (YYYY-MM-DD)' },
  )
  fromDate: string;

  @IsDateString(
    {},
    { message: 'toDate must be a valid date (YYYY-MM-DD)' },
  )
  toDate: string;

  @IsString({ message: 'note must be a string' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'A reason is required when an admin reschedules a delivery' })
  @MaxLength(1000, { message: 'note must be at most 1000 characters' })
  note: string;
}
