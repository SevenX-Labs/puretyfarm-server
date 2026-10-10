import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  IsDateString,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Gender } from '@prisma/client';

export class CustomerUpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'firstName cannot be empty' })
  @MaxLength(50)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'lastName cannot be empty' })
  @MaxLength(50)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  lastName?: string;

  @IsOptional()
  @IsEnum(Gender, {
    message: 'gender must be a valid enum value (MALE, FEMALE, OTHER)',
  })
  gender?: Gender;

  @IsOptional()
  @IsDateString(
    {},
    {
      message:
        'dateOfBirth must be a valid date string (e.g. YYYY-MM-DD or ISO 8601)',
    },
  )
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'whatsappNumber cannot be empty' })
  @MaxLength(20)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  whatsappNumber?: string;
}
