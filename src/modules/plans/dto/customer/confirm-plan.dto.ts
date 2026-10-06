import { IsEnum, IsUUID } from "class-validator";

export enum PlanPaymentMethod {
  WALLET = "WALLET",
  CASH = "CASH",
}

export class ConfirmPlanDto {
  @IsUUID("4", { message: "quoteId must be a valid UUID" })
  quoteId: string;

  @IsEnum(PlanPaymentMethod, {
    message: `paymentMethod must be one of: ${Object.values(PlanPaymentMethod).join(", ")}`,
  })
  paymentMethod: PlanPaymentMethod;
}
