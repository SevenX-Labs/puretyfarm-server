import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ManageDeliveryService } from "./manage-delivery.service";
import { SkipDeliveryDto } from "./dto/customer/skip-delivery.dto";
import { ChangeQuantityDto } from "./dto/customer/change-quantity.dto";
import { ChangeFrequencyDto } from "./dto/customer/change-frequency.dto";
import { ChangePlanDto } from "./dto/customer/change-plan.dto";
import { ChangeScheduleDto } from "./dto/customer/change-schedule.dto";
import { PauseDeliveryDto } from "./dto/customer/pause-delivery.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { JwtPayload } from "../../common/interfaces/jwt-payload.interface";

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

  @Post("pause")
  @HttpCode(HttpStatus.OK)
  async pause(
    @CurrentUser() user: JwtPayload,
    @Body() dto: PauseDeliveryDto,
  ) {
    return this.service.pauseDelivery(user.sub, dto);
  }

  /** Requests a resume for a PAUSED plan. Takes no body. */
  @Post("resume")
  @HttpCode(HttpStatus.OK)
  async resume(@CurrentUser() user: JwtPayload) {
    return this.service.resumeDelivery(user.sub);
  }

  @Post("change-quantity")
  @HttpCode(HttpStatus.OK)
  async changeQuantity(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangeQuantityDto,
  ) {
    return this.service.changeQuantity(user.sub, dto);
  }

  @Post("change-frequency")
  @HttpCode(HttpStatus.OK)
  async changeFrequency(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangeFrequencyDto,
  ) {
    return this.service.changeFrequency(user.sub, dto);
  }

  @Post("change-plan")
  @HttpCode(HttpStatus.OK)
  async changePlan(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangePlanDto,
  ) {
    return this.service.changePlan(user.sub, dto);
  }

  @Post("change-schedule")
  @HttpCode(HttpStatus.OK)
  async changeSchedule(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangeScheduleDto,
  ) {
    return this.service.changeSchedule(user.sub, dto);
  }

  @Get("requests")
  @HttpCode(HttpStatus.OK)
  async getRequests(@CurrentUser() user: JwtPayload) {
    return this.service.getCustomerRequests(user.sub);
  }

  @Get("requests/:requestId")
  @HttpCode(HttpStatus.OK)
  async getRequest(
    @CurrentUser() user: JwtPayload,
    @Param("requestId") requestId: string,
  ) {
    return this.service.getCustomerRequest(user.sub, requestId);
  }
}
