import {
  IsArray,
  IsInt,
  IsUUID,
  ArrayMinSize,
  Min,
  Max,
} from 'class-validator';
import { QUANTITY_MIN, QUANTITY_MAX } from '../../../plans/plans.constants';

export class BulkUpdateOrderQuantityDto {
  @IsArray({ message: 'orderIds must be an array of order IDs' })
  @ArrayMinSize(1, { message: 'orderIds must contain at least 1 order ID' })
  @IsUUID('4', { each: true, message: 'Each order ID must be a valid UUID' })
  orderIds: string[];

  @IsInt({ message: 'quantity must be an integer (in litres)' })
  @Min(QUANTITY_MIN, { message: `quantity must be at least ${QUANTITY_MIN}` })
  @Max(QUANTITY_MAX, { message: `quantity must be at most ${QUANTITY_MAX}` })
  quantity: number;
}
