import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { Transform } from "class-transformer";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

/**
 * Body for PATCH /admin/locations/states/:stateId. Both fields are optional so
 * the same endpoint renames a state and/or enables/disables it. An empty name
 * is rejected; isActive=false is the primary way to remove a state (and its
 * whole subtree) from customer serviceability without deleting data.
 */
export class UpdateStateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "name must not be empty" })
  @MaxLength(100)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsBoolean({ message: "isActive must be a boolean" })
  isActive?: boolean;
}
