import { UpdatePlanBaseDto } from './update-plan-base.dto';

/**
 * Body for PATCH /admin/plans/SEVEN_DAY_TRIAL. The once-per-customer usage
 * limit and 7-day duration are fixed business rules, so neither is accepted.
 */
export class UpdateTrialPlanDto extends UpdatePlanBaseDto {}
