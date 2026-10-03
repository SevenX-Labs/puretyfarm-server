import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CustomerLoginDto {
  @IsNotEmpty({ message: 'Mobile number is required' })
  @IsString({ message: 'Mobile number must be a string' })
  @Matches(/^(\+91|91|0)?[6-9]\d{9}$/, {
    message: 'Please provide a valid 10-digit Indian mobile number',
  })
  mobile: string;
}
