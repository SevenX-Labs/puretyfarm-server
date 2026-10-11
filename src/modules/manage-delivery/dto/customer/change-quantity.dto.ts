import { IsInt, IsOptional, Matches, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { QUANTITY_MIN, QUANTITY_MAX } from '../../../plans/plans.constants';

/**
 * Body for POST /customer/manage-delivery/change-quantity.
 * With `deliveryDate`, changes the quantity of that one upcoming delivery.
 * Without it, sets a single fixed quantity for all FUTURE deliveries.
 * Either way the change only takes effect once an admin approves it.
 */
export class ChangeQuantityDto {
  @Type(() => Number)
  @IsInt({ message: 'quantityLitres must be a whole number' })
  @Min(QUANTITY_MIN, {
    message: `quantityLitres must be at least ${QUANTITY_MIN}`,
  })
  @Max(QUANTITY_MAX, {
    message: `quantityLitres must be at most ${QUANTITY_MAX}`,
  })
  quantityLitres: number;

  /** The scheduled date (YYYY-MM-DD) of the single delivery to change. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'deliveryDate must be in YYYY-MM-DD format',
  })
  deliveryDate?: string;
}
