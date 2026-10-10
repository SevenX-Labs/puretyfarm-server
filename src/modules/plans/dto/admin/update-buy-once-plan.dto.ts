import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { UpdatePlanBaseDto } from './update-plan-base.dto';
import { BUY_ONCE_MAX_USAGES_LIMIT } from '../../plans.constants';

/** Body for PATCH /admin/plans/BUY_ONCE. */
export class UpdateBuyOncePlanDto extends UpdatePlanBaseDto {
  /** Maximum lifetime Buy Once uses per customer. */
  @IsOptional()
  @IsInt({ message: 'maxUsages must be a whole number' })
  @Min(1, { message: 'maxUsages must be at least 1' })
  @Max(BUY_ONCE_MAX_USAGES_LIMIT, {
    message: `maxUsages must be at most ${BUY_ONCE_MAX_USAGES_LIMIT}`,
  })
  maxUsages?: number;
}
