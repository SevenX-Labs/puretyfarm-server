import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { AdminListOrdersQueryDto } from './dto/admin/list-orders-query.dto';
import { UpdateOrderStatusDto } from './dto/admin/update-order-status.dto';
import { BulkUpdateOrderStatusDto } from './dto/admin/bulk-update-order-status.dto';
import { BulkUpdateOrderQuantityDto } from './dto/admin/bulk-update-order-quantity.dto';

@Controller(['api/v1/admin/orders', 'admin/orders'])
@UseGuards(JwtAuthGuard)
@Roles('ADMIN')
export class AdminOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async listOrders(@Query() query: AdminListOrdersQueryDto) {
    return this.ordersService.getAdminOrders(query);
  }

  /**
   * Bulk updates status for multiple orders (e.g. marking as DELIVERED).
   * Validates eligibility per order, synchronizes PlanDelivery without touching
   * scheduled delivery dates, and reports individual success/failure results.
   */
  @Patch('bulk/status')
  @HttpCode(HttpStatus.OK)
  async bulkUpdateStatus(
    @CurrentUser() admin: JwtPayload,
    @Body() dto: BulkUpdateOrderStatusDto,
  ) {
    return this.ordersService.bulkUpdateOrderStatus(dto, admin.sub);
  }

  /**
   * Bulk updates milk delivery quantity for eligible upcoming orders.
   * Validates configured quantity limits, synchronizes PlanDelivery, and
   * updates line items while preserving immutable invoice and wallet records.
   */
  @Patch('bulk/quantity')
  @HttpCode(HttpStatus.OK)
  async bulkUpdateQuantity(
    @CurrentUser() admin: JwtPayload,
    @Body() dto: BulkUpdateOrderQuantityDto,
  ) {
    return this.ordersService.bulkUpdateOrderQuantity(dto, admin.sub);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getOrder(@Param('id') id: string) {
    return this.ordersService.getAdminOrder(id);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  async updateStatus(
    @CurrentUser() admin: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateOrderStatus(id, dto, admin.sub);
  }

  /**
   * Retries the wallet charge for a delivered order whose delivery charge is
   * outstanding. Takes no body: the amount comes from the persisted order.
   */
  @Post(':orderId/settle')
  @HttpCode(HttpStatus.OK)
  async settleOrder(
    @CurrentUser() admin: JwtPayload,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.ordersService.settleOutstandingOrder(orderId, admin.sub);
  }

  /**
   * Closes a delivered order. Takes no body: the target status is the route,
   * and every eligibility rule is decided server-side from the order and its
   * delivery, never from the caller.
   */
  @Patch(':orderId/complete')
  @HttpCode(HttpStatus.OK)
  async completeOrder(@Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.ordersService.completeOrder(orderId);
  }
}
