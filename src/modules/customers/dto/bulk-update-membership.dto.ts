import { IsArray, IsEnum, IsNotEmpty, IsString, ArrayMinSize } from 'class-validator';
import { MembershipType } from '@prisma/client';

export class BulkUpdateMembershipDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  customerIds: string[];

  @IsNotEmpty()
  @IsEnum(MembershipType)
  membershipType: MembershipType;
}
