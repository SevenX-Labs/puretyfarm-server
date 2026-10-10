import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body for POST /admin/locations/states. Only the state name is accepted;
 * isActive defaults to true at the database level and can be toggled later via
 * the update endpoint.
 */
export class CreateStateDto {
  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  @MaxLength(100)
  @Transform(trim)
  name: string;
}
