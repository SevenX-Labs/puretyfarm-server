import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class ResetMpinDto {
  @IsNotEmpty({ message: 'New MPIN is required' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'New MPIN must be exactly 4 digits' })
  newMpin: string;

  @IsNotEmpty({ message: 'Confirm MPIN is required' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'Confirm MPIN must be exactly 4 digits' })
  confirmMpin: string;
}
