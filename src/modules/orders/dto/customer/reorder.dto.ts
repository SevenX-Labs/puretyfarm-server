import { IsUUID } from "class-validator";

export class ReorderDto {
  @IsUUID("4", { message: "addressId must be a valid UUID" })
  addressId: string;
}
