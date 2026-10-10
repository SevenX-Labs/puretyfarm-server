import { IsString, IsNotEmpty, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class RejectCreditRequestDto {
  @IsString({ message: 'note must be a string' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'A rejection reason is required' })
  @MinLength(3, { message: 'note must be at least 3 characters' })
  @MaxLength(1000, { message: 'note must be at most 1000 characters' })
  note: string;
}
