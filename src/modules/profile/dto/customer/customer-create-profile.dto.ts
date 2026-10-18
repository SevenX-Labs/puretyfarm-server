import {
  IsEnum,
  IsNotEmpty,
  IsString,
  MaxLength,
  IsDateString,
  IsOptional,
  IsNumber,
  Min,
  Max,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { Gender } from "@prisma/client";

export class CustomerCreateProfileDto {
  @IsString()
  @IsNotEmpty({ message: "firstName is required" })
  @MaxLength(50)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  firstName: string;

  @IsString()
  @IsNotEmpty({ message: "lastName is required" })
  @MaxLength(50)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  lastName: string;

  @IsEnum(Gender, {
    message: "gender must be a valid enum value (MALE, FEMALE, OTHER)",
  })
  @IsNotEmpty({ message: "gender is required" })
  gender: Gender;

  @IsDateString(
    {},
    {
      message:
        "dateOfBirth must be a valid date string (e.g. YYYY-MM-DD or ISO 8601)",
    },
  )
  @IsNotEmpty({ message: "dateOfBirth is required" })
  dateOfBirth: string;

  @IsString()
  @IsNotEmpty({ message: "whatsappNumber is required" })
  @MaxLength(20)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  whatsappNumber: string;

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
