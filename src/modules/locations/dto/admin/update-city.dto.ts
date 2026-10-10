import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body for PATCH /admin/locations/cities/:cityId. Both fields optional; the
 * same endpoint renames and/or enables/disables a city. Moving a city between
 * states is intentionally NOT supported — stateId is not accepted here.
 */
export class UpdateCityDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'name must not be empty' })
  @MaxLength(100)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive?: boolean;
}
