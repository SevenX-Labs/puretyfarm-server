import { IsEnum } from "class-validator";
import { PlanType } from "../../../plans/plans.constants";

export class ChangePlanDto {
  @IsEnum(PlanType, {
    message: `planType must be one of: ${Object.values(PlanType).join(", ")}`,
  })
  planType: PlanType;
}
