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
 * Body for POST /customer/addresses.
 *
 * State/City/Area are referenced by ID only — the IDs are the source of truth
 * and the backend resolves the display names itself, so the client can never
 * spoof a state/city/area name. userId is taken from the JWT, never the body.
 * Coordinates are optional: present for GPS-detected locations, absent for
 * manual selection (they are never invented server-side).
 */
export class CreateAddressDto {
  @IsString()
  @IsNotEmpty({ message: 'fullName is required' })
  @MaxLength(100)
  @Transform(trim)
  fullName: string;

  // Format is validated + canonicalized by normalizeMobile() in the service
  // (shared with Auth), so the DTO only enforces presence here.
  @IsString()
  @IsNotEmpty({ message: 'mobile is required' })
  @Transform(trim)
  mobile: string;

  @IsString()
  @IsNotEmpty({ message: 'houseNumber is required' })
  @MaxLength(100)
  @Transform(trim)
  houseNumber: string;

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

  @IsUUID('4', { message: 'stateId must be a valid UUID' })
  stateId: string;

  @IsUUID('4', { message: 'cityId must be a valid UUID' })
  cityId: string;

  @IsUUID('4', { message: 'areaId must be a valid UUID' })
  areaId: string;

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
