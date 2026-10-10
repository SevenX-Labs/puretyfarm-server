import { IsUUID } from 'class-validator';

export class CreateOrderDto {
  @IsUUID('4', { message: 'planDeliveryId must be a valid UUID' })
  planDeliveryId: string;

  @IsUUID('4', { message: 'addressId must be a valid UUID' })
  addressId: string;
}
