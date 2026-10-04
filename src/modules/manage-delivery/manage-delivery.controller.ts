import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ManageDeliveryService } from "./manage-delivery.service";
import { SkipDeliveryDto } from "./dto/customer/skip-delivery.dto";
import { ChangeQuantityDto } from "./dto/customer/change-quantity.dto";
import { ChangeScheduleDto } from "./dto/customer/change-schedule.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { JwtPayload } from "../../common/interfaces/jwt-payload.interface";

/**
 * Customer Manage Delivery APIs. Every endpoint requires a CUSTOMER JWT and
 * operates only on the authenticated customer's own active plan. Identity is
 * always taken from JWT.sub — the body never supplies a userId.
 */
@Controller(["api/v1/customer/manage-delivery", "customer/manage-delivery"])
@UseGuards(JwtAuthGuard)
export class ManageDeliveryController {
  constructor(private readonly service: ManageDeliveryService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getManageDelivery(@CurrentUser() user: JwtPayload) {
    return this.service.getManageDelivery(user.sub);
  }

  @Post("skip")
  @HttpCode(HttpStatus.OK)
  async skip(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SkipDeliveryDto,
  ) {
    return this.service.skipDelivery(user.sub, dto);
  }

  @Post("change-quantity")
  @HttpCode(HttpStatus.OK)
  async changeQuantity(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangeQuantityDto,
  ) {
    return this.service.changeQuantity(user.sub, dto);
  }

  @Post("change-schedule")
  @HttpCode(HttpStatus.OK)
  async changeSchedule(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangeScheduleDto,
  ) {
    return this.service.changeSchedule(user.sub, dto);
  }
}
