import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class VerifyMpinDto {
  @IsNotEmpty({ message: 'MPIN is required' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'MPIN must be exactly 4 digits' })
  mpin: string;
}
