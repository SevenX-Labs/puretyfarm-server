import { IsInt, Min, Max } from 'class-validator';

export class CreateCreditRequestDto {
  @IsInt({ message: 'amount must be an integer (paise)' })
  @Min(1, { message: 'amount must be greater than 0' })
  @Max(2_147_483_647, { message: 'amount exceeds maximum allowed' })
  amount: number;
}
