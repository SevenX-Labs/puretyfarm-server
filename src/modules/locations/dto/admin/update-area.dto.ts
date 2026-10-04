import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";
import { Transform } from "class-transformer";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

/**
 * Body for PATCH /admin/locations/areas/:areaId. All fields optional; the same
 * endpoint renames, repincodes, and/or enables/disables an area. Setting
 * isActive=false removes the area from customer serviceability matching;
 * isActive=true makes it eligible again (provided its parent city and state
 * are also active). Moving an area between cities is not supported.
 */
export class UpdateAreaDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "name must not be empty" })
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "pincode must not be empty" })
  @Transform(trim)
  @Matches(/^\d{4,10}$/, { message: "pincode must be 4 to 10 digits" })
  pincode?: string;

  @IsOptional()
  @IsBoolean({ message: "isActive must be a boolean" })
  isActive?: boolean;
}
