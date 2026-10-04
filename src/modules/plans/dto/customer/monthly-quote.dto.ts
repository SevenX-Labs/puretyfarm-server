import {
  IsEnum,
  IsInt,
  Min,
  Max,
  ValidateIf,
  IsDefined,
} from "class-validator";
import { Type } from "class-transformer";
import {
  DeliveryFrequency,
  QuantityMode,
  QUANTITY_MIN,
  QUANTITY_MAX,
} from "../../plans.constants";

/**
 * Body for POST /customer/plans/monthly/quote.
 *
 * FIXED mode requires `quantity`.
 * ALTERNATING mode requires `quantityA` and `quantityB`.
 */
export class MonthlyQuoteDto {
  @IsEnum(DeliveryFrequency, {
    message: `frequency must be one of: ${Object.values(DeliveryFrequency).join(", ")}`,
  })
  frequency: DeliveryFrequency;

  @IsEnum(QuantityMode, {
    message: `quantityMode must be one of: ${Object.values(QuantityMode).join(", ")}`,
  })
  quantityMode: QuantityMode;

  // ── FIXED mode ──
  @ValidateIf((o) => o.quantityMode === QuantityMode.FIXED)
  @IsDefined({ message: "quantity is required for FIXED mode" })
  @Type(() => Number)
  @IsInt({ message: "quantity must be a whole number" })
  @Min(QUANTITY_MIN, { message: `quantity must be at least ${QUANTITY_MIN}` })
  @Max(QUANTITY_MAX, { message: `quantity must be at most ${QUANTITY_MAX}` })
  quantity?: number;

  // ── ALTERNATING mode ──
  @ValidateIf((o) => o.quantityMode === QuantityMode.ALTERNATING)
  @IsDefined({ message: "quantityA is required for ALTERNATING mode" })
  @Type(() => Number)
  @IsInt({ message: "quantityA must be a whole number" })
  @Min(QUANTITY_MIN, { message: `quantityA must be at least ${QUANTITY_MIN}` })
  @Max(QUANTITY_MAX, { message: `quantityA must be at most ${QUANTITY_MAX}` })
  quantityA?: number;

  @ValidateIf((o) => o.quantityMode === QuantityMode.ALTERNATING)
  @IsDefined({ message: "quantityB is required for ALTERNATING mode" })
  @Type(() => Number)
  @IsInt({ message: "quantityB must be a whole number" })
  @Min(QUANTITY_MIN, { message: `quantityB must be at least ${QUANTITY_MIN}` })
  @Max(QUANTITY_MAX, { message: `quantityB must be at most ${QUANTITY_MAX}` })
  quantityB?: number;
}
