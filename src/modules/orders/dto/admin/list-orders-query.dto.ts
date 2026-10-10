import {
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsDateString,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus, PaymentStatus } from '../../orders.constants';
import { PlanType } from '../../../plans/plans.constants';

export class AdminListOrdersQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus, {
    message: `status must be one of: ${Object.values(OrderStatus).join(', ')}`,
  })
  status?: OrderStatus;

  @IsOptional()
  @IsEnum(PaymentStatus, {
    message: `paymentStatus must be one of: ${Object.values(PaymentStatus).join(', ')}`,
  })
  paymentStatus?: PaymentStatus;

  @IsOptional()
  @IsEnum(PlanType, {
    message: `planType must be one of: ${Object.values(PlanType).join(', ')}`,
  })
  planType?: PlanType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  customerSearch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  orderNumber?: string;

  @IsOptional()
  @IsDateString({}, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string;

  @IsOptional()
  @IsDateString({}, { message: 'endDate must be YYYY-MM-DD' })
  endDate?: string;

  @IsOptional()
  @IsDateString({}, { message: 'deliveryDate must be YYYY-MM-DD' })
  deliveryDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
