import { IsEnum, IsNotEmpty } from 'class-validator';
import { MembershipType } from '@prisma/client';

export class UpdateMembershipDto {
  @IsNotEmpty()
  @IsEnum(MembershipType)
  membershipType: MembershipType;
}
