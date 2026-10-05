import { IsBoolean, IsOptional } from "class-validator";
import { UpdatePlanBaseDto } from "./update-plan-base.dto";

/**
 * Body for PATCH /admin/plans/MONTHLY. The toggles decide which frequencies and
 * quantity modes customers may choose; at least one of each must stay enabled.
 */
export class UpdateMonthlyPlanDto extends UpdatePlanBaseDto {
  @IsOptional()
  @IsBoolean({ message: "dailyEnabled must be a boolean" })
  dailyEnabled?: boolean;

  @IsOptional()
  @IsBoolean({ message: "alternateDaysEnabled must be a boolean" })
  alternateDaysEnabled?: boolean;

  @IsOptional()
  @IsBoolean({ message: "fixedQuantityEnabled must be a boolean" })
  fixedQuantityEnabled?: boolean;

  @IsOptional()
  @IsBoolean({ message: "alternatingQuantityEnabled must be a boolean" })
  alternatingQuantityEnabled?: boolean;
}
