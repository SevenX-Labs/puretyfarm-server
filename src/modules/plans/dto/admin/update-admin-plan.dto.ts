import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PlanType } from "../../plans.constants";
import { UpdateBuyOncePlanDto } from "./update-buy-once-plan.dto";
import { UpdateTrialPlanDto } from "./update-trial-plan.dto";
import { UpdateMonthlyPlanDto } from "./update-monthly-plan.dto";

export type UpdateAdminPlanDto =
  | UpdateBuyOncePlanDto
  | UpdateTrialPlanDto
  | UpdateMonthlyPlanDto;

const DTO_BY_PLAN_TYPE = {
  [PlanType.BUY_ONCE]: UpdateBuyOncePlanDto,
  [PlanType.SEVEN_DAY_TRIAL]: UpdateTrialPlanDto,
  [PlanType.MONTHLY]: UpdateMonthlyPlanDto,
};

/**
 * Validates a PATCH body against the DTO for `planType`. The body shape depends
 * on the route param, so this runs here rather than in the global pipe.
 *
 * Unknown properties are REJECTED (not stripped): a field from another plan
 * type, or an identity field like `adminId`, fails with 400 instead of being
 * silently ignored.
 */
export async function parseUpdateAdminPlanDto(
  planType: PlanType,
  body: unknown,
): Promise<UpdateAdminPlanDto> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("Request body must be a JSON object");
  }
  if (Object.keys(body).length === 0) {
    throw new BadRequestException("At least one field must be provided");
  }

  const dto = plainToInstance(DTO_BY_PLAN_TYPE[planType], body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    throw new BadRequestException(
      errors.flatMap((e) => Object.values(e.constraints ?? {})),
    );
  }

  // Keep only the fields the client sent. Under ES2022+ class-field semantics
  // every declared DTO property exists as `undefined`, which would otherwise
  // overwrite stored values when merged for cross-field validation.
  return Object.fromEntries(
    Object.entries(dto).filter(([, v]) => v !== undefined),
  ) as UpdateAdminPlanDto;
}
