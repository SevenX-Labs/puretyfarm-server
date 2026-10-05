import {
  BadRequestException,
  Body,
  Controller,
  Headers,
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

/**
 * Customer order-payment entry point.
 *
 * Served from PaymentsModule (NOT OrdersModule) so the dependency graph stays:
 *   PaymentsModule → OrdersModule + WalletModule
 *   OrdersModule → nothing
 * No new forwardRef required.
 *
 * ONE route handles both methods:
 *   POST /api/v1/customer/orders/:orderId/pay
 *   body: { paymentMethod: "WALLET" | "ONLINE" }
 *
 * WALLET returns a settled receipt synchronously. ONLINE returns the existing
 * PayU Hosted Checkout response for the customer's form to post.
 */
@Controller(['api/v1/customer/orders', 'customer/orders'])
@UseGuards(JwtAuthGuard)
export class OrderPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post(':orderId/pay')
  // Route-local pipe with forbidNonWhitelisted = true. The project-wide pipe
  // only strips unknown fields; here we want a 400 so a client that tries to
  // inject userId / amount / orderId / paymentStatus / orderStatus /
  // transactionId sees that it was rejected.
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
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    if (dto.paymentMethod === OrderPaymentChoice.WALLET) {
      // Wallet path is single-settlement at the DB level (conditional Order
      // update + unique DEBIT ledger key), so an Idempotency-Key is not
      // required here. A retried wallet pay just 409s on ORDER_ALREADY_PROCESSED.
      return this.paymentsService.payOrderFromWallet(user.sub, orderId);
    }

    // ONLINE uses the same Idempotency-Key convention as the wallet top-up
    // create endpoint — fresh UUID per intent, reused on retry.
    const key = this.requireIdempotencyKey(idempotencyKey);
    return this.paymentsService.createOrderPayment(user.sub, orderId, key);
  }

  private requireIdempotencyKey(value: string): string {
    if (!value || typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(
        'Idempotency-Key header is required for ONLINE payment',
      );
    }
    return value.trim();
  }
}
