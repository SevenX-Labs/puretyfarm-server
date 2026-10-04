import { IsDateString } from "class-validator";

/**
 * Body for POST /customer/manage-delivery/skip.
 * The customer identifies the delivery to skip by its calendar date.
 */
export class SkipDeliveryDto {
  @IsDateString(
    {},
    { message: "deliveryDate must be a valid date (YYYY-MM-DD)" },
  )
  deliveryDate: string;
}
