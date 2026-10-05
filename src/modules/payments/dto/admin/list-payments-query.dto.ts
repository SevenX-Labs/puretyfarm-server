import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentTransactionStatus,
} from '../../payments.constants';

/**
 * Admin payment-ledger filters. Read-only: there is deliberately no field
 * here, or any endpoint, that lets an admin set a payment's status. An online
 * payment only becomes SUCCESS through hash-verified PayU communication.
 */
export class AdminListPaymentsQueryDto {
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

  /** Matches customer mobile, email or name. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  customerSearch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  transactionId?: string;

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
