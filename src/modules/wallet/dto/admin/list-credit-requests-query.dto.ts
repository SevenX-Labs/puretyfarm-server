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
import { WalletCreditRequestStatus } from '../../wallet.constants';
import { PaymentMethod } from '../../../payments/payments.constants';

export class AdminListCreditRequestsQueryDto {
  @IsOptional()
  @IsEnum(WalletCreditRequestStatus, {
    message: `status must be one of: ${Object.values(WalletCreditRequestStatus).join(', ')}`,
  })
  status?: WalletCreditRequestStatus;

  @IsOptional()
  @IsEnum(PaymentMethod, {
    message: `source must be one of: ${Object.values(PaymentMethod).join(', ')}`,
  })
  source?: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  customerSearch?: string;

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
