import { IsNotEmpty, IsNumber, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Body for POST /customer/locations/detect. Coordinates come from the device
 * GPS; the user identity is taken from the JWT, never from the body.
 */
export class DetectLocationDto {
  @Type(() => Number)
  @IsNotEmpty({ message: 'latitude is required' })
  @IsNumber({}, { message: 'latitude must be a number' })
  @Min(-90, { message: 'latitude must be between -90 and 90' })
  @Max(90, { message: 'latitude must be between -90 and 90' })
  latitude: number;

  @Type(() => Number)
  @IsNotEmpty({ message: 'longitude is required' })
  @IsNumber({}, { message: 'longitude must be a number' })
  @Min(-180, { message: 'longitude must be between -180 and 180' })
  @Max(180, { message: 'longitude must be between -180 and 180' })
  longitude: number;
}
