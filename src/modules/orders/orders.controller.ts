import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { OrdersService } from "./orders.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { JwtPayload } from "../../common/interfaces/jwt-payload.interface";
import { CreateOrderDto } from "./dto/customer/create-order.dto";
import { ReorderDto } from "./dto/customer/reorder.dto";
import { CustomerListOrdersQueryDto } from "./dto/customer/list-orders-query.dto";

@Controller(["api/v1/customer/orders", "customer/orders"])
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async listOrders(
    @CurrentUser() user: JwtPayload,
    @Query() query: CustomerListOrdersQueryDto,
  ) {
    return this.ordersService.getCustomerOrders(user.sub, query);
  }

  @Get(":id")
  @HttpCode(HttpStatus.OK)
  async getOrder(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
  ) {
    return this.ordersService.getCustomerOrder(user.sub, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createOrder(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateOrderDto,
  ) {
    return this.ordersService.createOrder(user.sub, dto);
  }

  @Post(":id/reorder")
  @HttpCode(HttpStatus.CREATED)
  async reorder(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
    @Body() dto: ReorderDto,
  ) {
    return this.ordersService.reorder(user.sub, id, dto);
  }

  @Get(":id/invoice")
  @HttpCode(HttpStatus.OK)
  async getInvoice(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
  ) {
    return this.ordersService.getCustomerInvoice(user.sub, id);
  }
}
