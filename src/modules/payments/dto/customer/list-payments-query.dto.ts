import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentTransactionStatus,
} from '../../payments.constants';

/** Filters for a customer's own payment history. Always scoped to JWT.sub. */
export class CustomerListPaymentsQueryDto {
  @IsOptional()
  @IsEnum(PaymentTransactionStatus, {
    message: `status must be one of: ${Object.values(PaymentTransactionStatus).join(', ')}`,
  })
  status?: PaymentTransactionStatus;

  @IsOptional()
  @IsEnum(PaymentPurpose, {
    message: `purpose must be one of: ${Object.values(PaymentPurpose).join(', ')}`,
  })
  purpose?: PaymentPurpose;

  @IsOptional()
  @IsEnum(PaymentMethod, {
    message: `paymentMethod must be one of: ${Object.values(PaymentMethod).join(', ')}`,
  })
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsDateString({}, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string;

  @IsOptional()
  @IsDateString({}, { message: 'endDate must be YYYY-MM-DD' })
  endDate?: string;

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
