import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CreateMpinDto {
  @IsNotEmpty({ message: 'MPIN is required' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'MPIN must be exactly 4 digits' })
  mpin: string;

  @IsNotEmpty({ message: 'Confirm MPIN is required' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'Confirm MPIN must be exactly 4 digits' })
  confirmMpin: string;
}
