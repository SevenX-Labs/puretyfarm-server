import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class AdminChangePasswordDto {
  @IsString({ message: 'currentPassword must be a string' })
  @IsNotEmpty({ message: 'currentPassword is required' })
  currentPassword: string;

  @IsString({ message: 'newPassword must be a string' })
  @IsNotEmpty({ message: 'newPassword is required' })
  @MinLength(8, { message: 'newPassword must be at least 8 characters long' })
  newPassword: string;
}
