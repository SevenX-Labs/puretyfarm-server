import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body for POST /admin/locations/cities. A city is always created under an
 * existing, active parent state. isActive defaults to true at the database
 * level.
 */
export class CreateCityDto {
  @IsUUID('4', { message: 'stateId must be a valid UUID' })
  stateId: string;

  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  @MaxLength(100)
  @Transform(trim)
  name: string;
}
