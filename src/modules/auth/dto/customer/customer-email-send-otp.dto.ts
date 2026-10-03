import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class CustomerEmailSendOtpDto {
  @IsNotEmpty({ message: 'Email is required' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsString()
  email: string;
}
