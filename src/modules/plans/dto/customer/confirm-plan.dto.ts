import { IsUUID } from "class-validator";

/**
 * Body for POST /customer/plans/confirm.
 * The customer submits only the server-generated quoteId.
 */
export class ConfirmPlanDto {
  @IsUUID("4", { message: "quoteId must be a valid UUID" })
  quoteId: string;
}
