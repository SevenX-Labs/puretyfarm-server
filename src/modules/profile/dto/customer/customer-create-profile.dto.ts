import {
  IsEnum,
  IsNotEmpty,
  IsString,
  MaxLength,
  IsDateString,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Gender } from '@prisma/client';

export class CustomerCreateProfileDto {
  @IsString()
  @IsNotEmpty({ message: 'firstName is required' })
  @MaxLength(50)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  firstName: string;

  @IsString()
  @IsNotEmpty({ message: 'lastName is required' })
  @MaxLength(50)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  lastName: string;

  @IsEnum(Gender, {
    message: 'gender must be a valid enum value (MALE, FEMALE, OTHER)',
  })
  @IsNotEmpty({ message: 'gender is required' })
  gender: Gender;

  @IsDateString(
    {},
    {
      message:
        'dateOfBirth must be a valid date string (e.g. YYYY-MM-DD or ISO 8601)',
    },
  )
  @IsNotEmpty({ message: 'dateOfBirth is required' })
  dateOfBirth: string;

  @IsString()
  @IsNotEmpty({ message: 'whatsappNumber is required' })
  @MaxLength(20)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  whatsappNumber: string;
}
