import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  DELIVERY_TIME_PATTERN,
  PRICE_PER_LITRE_MAX_PAISE,
  QUANTITY_MAX,
  QUANTITY_MIN,
} from '../../plans.constants';

/**
 * Fields every plan type shares. All optional (PATCH semantics). Values are
 * NOT type-coerced: a string "9500" or a float price is rejected, never
 * silently converted. Prices are INTEGER PAISE, matching PlanConfig.
 *
 * Cross-field rules (quantityMin <= quantityMax, selling <= actual) are checked
 * against the merged stored config in PlansService.
 */
export abstract class UpdatePlanBaseDto {
  @IsOptional()
  @IsInt({ message: 'actualPricePerLitre must be a whole number of paise' })
  @Min(0, { message: 'actualPricePerLitre must not be negative' })
  @Max(PRICE_PER_LITRE_MAX_PAISE, {
    message: `actualPricePerLitre must be at most ${PRICE_PER_LITRE_MAX_PAISE} paise`,
  })
  actualPricePerLitre?: number;

  @IsOptional()
  @IsInt({ message: 'sellingPricePerLitre must be a whole number of paise' })
  @Min(0, { message: 'sellingPricePerLitre must not be negative' })
  @Max(PRICE_PER_LITRE_MAX_PAISE, {
    message: `sellingPricePerLitre must be at most ${PRICE_PER_LITRE_MAX_PAISE} paise`,
  })
  sellingPricePerLitre?: number;

  @IsOptional()
  @IsInt({ message: 'quantityMin must be a whole number' })
  @Min(QUANTITY_MIN, {
    message: `quantityMin must be at least ${QUANTITY_MIN}`,
  })
  @Max(QUANTITY_MAX, { message: `quantityMin must be at most ${QUANTITY_MAX}` })
  quantityMin?: number;

  @IsOptional()
  @IsInt({ message: 'quantityMax must be a whole number' })
  @Min(QUANTITY_MIN, {
    message: `quantityMax must be at least ${QUANTITY_MIN}`,
  })
  @Max(QUANTITY_MAX, { message: `quantityMax must be at most ${QUANTITY_MAX}` })
  quantityMax?: number;

  @IsOptional()
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive?: boolean;

  @IsOptional()
  @IsInt({ message: 'deliveryFeePaise must be a whole number of paise' })
  @Min(0, { message: 'deliveryFeePaise must not be negative' })
  @Max(PRICE_PER_LITRE_MAX_PAISE, {
    message: `deliveryFeePaise must be at most ${PRICE_PER_LITRE_MAX_PAISE} paise`,
  })
  deliveryFeePaise?: number;

  @IsOptional()
  @IsString({ message: 'deliveryStartTime must be a string' })
  @Matches(DELIVERY_TIME_PATTERN, {
    message: 'deliveryStartTime must be HH:MM (24h)',
  })
  deliveryStartTime?: string;

  @IsOptional()
  @IsString({ message: 'deliveryEndTime must be a string' })
  @Matches(DELIVERY_TIME_PATTERN, {
    message: 'deliveryEndTime must be HH:MM (24h)',
  })
  deliveryEndTime?: string;
}
