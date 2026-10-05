import { IsString, IsNotEmpty, MaxLength } from "class-validator";
import { Transform } from "class-transformer";

export class RejectRequestDto {
  @IsString({ message: "note must be a string" })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsNotEmpty({ message: "A rejection reason is required" })
  @MaxLength(1000, { message: "note must be at most 1000 characters" })
  note: string;
}
