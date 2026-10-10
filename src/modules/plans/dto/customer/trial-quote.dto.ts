import { IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { QUANTITY_MIN, QUANTITY_MAX } from '../../plans.constants';

/**
 * Body for POST /customer/plans/trial/quote.
 * Only the per-delivery litre quantity is accepted.
 */
export class TrialQuoteDto {
  @Type(() => Number)
  @IsInt({ message: 'quantityLitres must be a whole number' })
  @Min(QUANTITY_MIN, {
    message: `quantityLitres must be at least ${QUANTITY_MIN}`,
  })
  @Max(QUANTITY_MAX, {
    message: `quantityLitres must be at most ${QUANTITY_MAX}`,
  })
  quantityLitres: number;
}
