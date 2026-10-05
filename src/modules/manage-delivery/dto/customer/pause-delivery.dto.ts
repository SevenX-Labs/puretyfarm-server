import { IsOptional, IsDateString } from "class-validator";

export class PauseDeliveryDto {
  @IsOptional()
  @IsDateString({}, { message: "resumeDate must be a valid date (YYYY-MM-DD)" })
  resumeDate?: string;
}
