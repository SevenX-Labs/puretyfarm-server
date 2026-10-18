import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class ChangeMpinDto {
  @IsNotEmpty({ message: 'Current MPIN is required' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'Current MPIN must be exactly 4 digits' })
  currentMpin: string;

  @IsNotEmpty({ message: 'New MPIN is required' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'New MPIN must be exactly 4 digits' })
  newMpin: string;

  @IsNotEmpty({ message: 'Confirm MPIN is required' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'Confirm MPIN must be exactly 4 digits' })
  confirmMpin: string;
}
