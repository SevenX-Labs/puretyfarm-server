import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { OrderPaymentChoice, PayOrderDto } from './dto/customer/pay-order.dto';

@Controller(['api/v1/customer/orders', 'customer/orders'])
@UseGuards(JwtAuthGuard)
export class OrderPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post(':orderId/pay')
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  @HttpCode(HttpStatus.OK)
  async payOrder(
    @CurrentUser() user: JwtPayload,
    @Param('orderId') orderId: string,
    @Body() dto: PayOrderDto,
  ) {
    if (dto.paymentMethod === OrderPaymentChoice.WALLET) {
      return this.paymentsService.payOrderFromWallet(user.sub, orderId);
    }

    throw new BadRequestException({
      error: 'DIRECT_CASH_ORDER_PAYMENT_NOT_SUPPORTED',
      message:
        'Cash is not supported as a direct payment method for orders. Plan deliveries are prepaid.',
    });
  }
}
