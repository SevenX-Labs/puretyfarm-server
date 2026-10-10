import { IsOptional, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { WalletCreditRequestStatus } from '../../wallet.constants';

export class ListCreditRequestsQueryDto {
  @IsOptional()
  @IsEnum(WalletCreditRequestStatus, {
    message: `status must be one of: ${Object.values(WalletCreditRequestStatus).join(', ')}`,
  })
  status?: WalletCreditRequestStatus;

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
