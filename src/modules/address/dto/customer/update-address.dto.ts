import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body for PATCH /customer/addresses/:id. Every field is optional; the same
 * validation rules as creation apply to whichever fields are supplied. If any
 * of stateId/cityId/areaId is supplied, the resulting State -> City -> Area
 * triple is re-validated server-side.
 *
 * Hand-written (rather than PartialType) to match the project's DTO style and
 * stay compatible with the CommonJS test runner.
 */
export class UpdateAddressDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'fullName cannot be empty' })
  @MaxLength(100)
  @Transform(trim)
  fullName?: string;

  // Format is validated + canonicalized by normalizeMobile() in the service
  // (shared with Auth). Only supplied when the caller intends to change it.
  @IsOptional()
  @IsString()
  @Transform(trim)
  mobile?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'houseNumber cannot be empty' })
  @MaxLength(100)
  @Transform(trim)
  houseNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Transform(trim)
  buildingName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Transform(trim)
  streetName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Transform(trim)
  landmark?: string;

  @IsOptional()
  @IsUUID('4', { message: 'stateId must be a valid UUID' })
  stateId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'cityId must be a valid UUID' })
  cityId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'areaId must be a valid UUID' })
  areaId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4,10}$/, { message: 'pincode must be 4 to 10 digits' })
  @Transform(trim)
  pincode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'latitude must be a number' })
  @Min(-90, { message: 'latitude must be between -90 and 90' })
  @Max(90, { message: 'latitude must be between -90 and 90' })
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'longitude must be a number' })
  @Min(-180, { message: 'longitude must be between -180 and 180' })
  @Max(180, { message: 'longitude must be between -180 and 180' })
  longitude?: number;
}
