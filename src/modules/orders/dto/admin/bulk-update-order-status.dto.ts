import { IsArray, IsEnum, IsUUID, ArrayMinSize } from 'class-validator';
import { OrderStatus } from '../../orders.constants';

export class BulkUpdateOrderStatusDto {
  @IsArray({ message: 'orderIds must be an array of order IDs' })
  @ArrayMinSize(1, { message: 'orderIds must contain at least 1 order ID' })
  @IsUUID('4', { each: true, message: 'Each order ID must be a valid UUID' })
  orderIds: string[];

  @IsEnum(OrderStatus, {
    message: `status must be one of: ${Object.values(OrderStatus).join(', ')}`,
  })
  status: OrderStatus;
}
