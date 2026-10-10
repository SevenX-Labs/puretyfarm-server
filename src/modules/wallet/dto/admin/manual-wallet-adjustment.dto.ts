import { IsInt, Min, Max, IsString, IsNotEmpty, MinLength, MaxLength, IsOptional } from "class-validator";
import { Transform } from "class-transformer";
import { WALLET_MAX_BALANCE_PAISE } from "../../wallet.constants";

export class AdminManualWalletAdjustmentDto {
  @IsOptional()
  @IsInt({ message: "amountPaise must be an integer (in paise)" })
  @Min(100, { message: "amount must be at least ₹1 (100 paise)" })
  @Max(WALLET_MAX_BALANCE_PAISE, { message: "amount exceeds maximum allowed wallet balance" })
  amountPaise?: number;

  @IsOptional()
  @IsInt({ message: "amount must be an integer (in paise)" })
  @Min(100, { message: "amount must be at least ₹1 (100 paise)" })
  @Max(WALLET_MAX_BALANCE_PAISE, { message: "amount exceeds maximum allowed wallet balance" })
  amount?: number;

  @IsString({ message: "remark must be a string" })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsNotEmpty({ message: "A remark/reason is required" })
  @MinLength(3, { message: "remark must be at least 3 characters" })
  @MaxLength(500, { message: "remark must be at most 500 characters" })
  remark: string;
}
