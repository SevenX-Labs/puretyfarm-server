import { IsNotEmpty, IsNumber, Max, Min } from "class-validator";
import { Type } from "class-transformer";

export class CustomerUpdateLocationDto {
  @Type(() => Number)
  @IsNumber({}, { message: "latitude must be a number" })
  @Min(-90, { message: "latitude must be between -90 and 90" })
  @Max(90, { message: "latitude must be between -90 and 90" })
  @IsNotEmpty({ message: "latitude is required" })
  latitude: number;

  @Type(() => Number)
  @IsNumber({}, { message: "longitude must be a number" })
  @Min(-180, { message: "longitude must be between -180 and 180" })
  @Max(180, { message: "longitude must be between -180 and 180" })
  @IsNotEmpty({ message: "longitude is required" })
  longitude: number;
}
