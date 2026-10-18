import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  IsDateString,
  IsNumber,
  Min,
  Max,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { Gender } from "@prisma/client";

export class CustomerUpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "firstName cannot be empty" })
  @MaxLength(50)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "lastName cannot be empty" })
  @MaxLength(50)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  lastName?: string;

  @IsOptional()
  @IsEnum(Gender, {
    message: "gender must be a valid enum value (MALE, FEMALE, OTHER)",
  })
  gender?: Gender;

  @IsOptional()
  @IsDateString(
    {},
    {
      message:
        "dateOfBirth must be a valid date string (e.g. YYYY-MM-DD or ISO 8601)",
    },
  )
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "whatsappNumber cannot be empty" })
  @MaxLength(20)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  whatsappNumber?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "latitude must be a number" })
  @Min(-90, { message: "latitude must be between -90 and 90" })
  @Max(90, { message: "latitude must be between -90 and 90" })
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "longitude must be a number" })
  @Min(-180, { message: "longitude must be between -180 and 180" })
  @Max(180, { message: "longitude must be between -180 and 180" })
  longitude?: number;
}
