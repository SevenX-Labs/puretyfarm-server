import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { OrdersService } from "./orders.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { AdminListOrdersQueryDto } from "./dto/admin/list-orders-query.dto";
import { UpdateOrderStatusDto } from "./dto/admin/update-order-status.dto";

@Controller(["api/v1/admin/orders", "admin/orders"])
@UseGuards(JwtAuthGuard)
@Roles("ADMIN")
export class AdminOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async listOrders(@Query() query: AdminListOrdersQueryDto) {
    return this.ordersService.getAdminOrders(query);
  }

  @Get(":id")
  @HttpCode(HttpStatus.OK)
  async getOrder(@Param("id") id: string) {
    return this.ordersService.getAdminOrder(id);
  }

  @Patch(":id/status")
  @HttpCode(HttpStatus.OK)
  async updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateOrderStatus(id, dto);
  }
}
