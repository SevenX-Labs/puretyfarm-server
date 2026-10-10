import { IsNotEmpty, IsString, IsUUID, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body for POST /admin/locations/areas. An area is created under an existing,
 * active parent city. A pincode is required because customer serviceability
 * matching uses it; its 4-10 digit format mirrors the customer address DTO
 * convention.
 */
export class CreateAreaDto {
  @IsUUID('4', { message: 'cityId must be a valid UUID' })
  cityId: string;

  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  @Transform(trim)
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'pincode is required' })
  @Transform(trim)
  @Matches(/^\d{4,10}$/, { message: 'pincode must be 4 to 10 digits' })
  pincode: string;
}
