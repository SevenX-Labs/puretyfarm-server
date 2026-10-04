import { IsInt, Min, Max } from "class-validator";
import { Type } from "class-transformer";
import { QUANTITY_MIN, QUANTITY_MAX } from "../../../plans/plans.constants";

/**
 * Body for POST /customer/manage-delivery/change-quantity.
 * Sets a single fixed quantity applied to all FUTURE deliveries.
 */
export class ChangeQuantityDto {
  @Type(() => Number)
  @IsInt({ message: "quantityLitres must be a whole number" })
  @Min(QUANTITY_MIN, { message: `quantityLitres must be at least ${QUANTITY_MIN}` })
  @Max(QUANTITY_MAX, { message: `quantityLitres must be at most ${QUANTITY_MAX}` })
  quantityLitres: number;
}
