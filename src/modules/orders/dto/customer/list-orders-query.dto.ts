import { IsOptional, IsEnum, IsInt, Min, Max, IsDateString, IsString, MaxLength } from "class-validator";
import { Type } from "class-transformer";
import { OrderStatus } from "../../orders.constants";
import { PlanType } from "../../../plans/plans.constants";

export class CustomerListOrdersQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus, {
    message: `status must be one of: ${Object.values(OrderStatus).join(", ")}`,
  })
  status?: OrderStatus;

  @IsOptional()
  @IsEnum(PlanType, {
    message: `planType must be one of: ${Object.values(PlanType).join(", ")}`,
  })
  planType?: PlanType;

  @IsOptional()
  @IsDateString({}, { message: "startDate must be YYYY-MM-DD" })
  startDate?: string;

  @IsOptional()
  @IsDateString({}, { message: "endDate must be YYYY-MM-DD" })
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  orderNumber?: string;

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
