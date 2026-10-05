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
import { CashCollectionStatus } from '../../payments.constants';

/** Admin filters over the physical-cash collection queue. */
export class AdminListCashCollectionsQueryDto {
  @IsOptional()
  @IsEnum(CashCollectionStatus, {
    message: `status must be one of: ${Object.values(CashCollectionStatus).join(', ')}`,
  })
  status?: CashCollectionStatus;

  /** Matches customer mobile, email or name. */
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
