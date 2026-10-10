import { IsDateString, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { Transform } from "class-transformer";

export class ApproveSubscriptionPlanDto {
  @IsNotEmpty({ message: "firstDeliveryDate is required" })
  @IsDateString({}, { message: "firstDeliveryDate must be a valid ISO date (YYYY-MM-DD)" })
  firstDeliveryDate: string;

  @IsOptional()
  @IsString({ message: "note must be a string" })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @MaxLength(1000, { message: "note must be at most 1000 characters" })
  note?: string;
}
