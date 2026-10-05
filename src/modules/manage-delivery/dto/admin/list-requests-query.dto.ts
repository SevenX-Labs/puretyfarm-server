import { IsOptional, IsEnum, IsInt, Min, Max } from "class-validator";
import { Type } from "class-transformer";
import {
  ChangeRequestStatus,
  ChangeRequestType,
} from "../../../plans/plans.constants";

export class ListRequestsQueryDto {
  @IsOptional()
  @IsEnum(ChangeRequestStatus, {
    message: `status must be one of: ${Object.values(ChangeRequestStatus).join(", ")}`,
  })
  status?: ChangeRequestStatus;

  @IsOptional()
  @IsEnum(ChangeRequestType, {
    message: `requestType must be one of: ${Object.values(ChangeRequestType).join(", ")}`,
  })
  requestType?: ChangeRequestType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
