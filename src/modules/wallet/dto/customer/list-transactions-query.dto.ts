import {
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { WalletTransactionType } from '../../wallet.constants';

export class ListTransactionsQueryDto {
  @IsOptional()
  @IsEnum(WalletTransactionType, {
    message: `type must be one of: ${Object.values(WalletTransactionType).join(', ')}`,
  })
  type?: WalletTransactionType;

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
