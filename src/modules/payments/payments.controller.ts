import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { CreatePaymentDto } from './dto/customer/create-payment.dto';
import { VerifyPaymentDto } from './dto/customer/verify-payment.dto';
import { RetryPaymentDto } from './dto/customer/retry-payment.dto';
import { CancelPaymentDto } from './dto/customer/cancel-payment.dto';
import { CustomerListPaymentsQueryDto } from './dto/customer/list-payments-query.dto';

/**
 * Authenticated customer payment APIs.
 *
 * Every handler derives the customer from `JWT.sub`. No endpoint here accepts
 * a userId, a payment status, or an amount that is not re-validated against
 * the wallet's server-side rules.
 *
 * `JwtAuthGuard` with no `@Roles(...)` means CUSTOMER-only, which is this
 * project's established default (see the guard's RBAC fallback).
 */
@Controller(['api/v1/customer/payments', 'customer/payments'])
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Starts a wallet top-up.
   *
   * ONLINE returns PayU Hosted Checkout fields to submit as a form. CASH
   * registers a cash collection; no payment gateway is involved and no
   * Payment record is created.
   *
   * Requires an `Idempotency-Key` header, matching the existing wallet
   * credit-request convention, so a retried request never creates a second
   * credit request or a second payment.
   */
  @Post('create')
  @HttpCode(HttpStatus.CREATED)
  async createPayment(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePaymentDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    return this.paymentsService.createWalletTopUp(
      user.sub,
      dto,
      this.requireIdempotencyKey(idempotencyKey),
    );
  }

  /**
   * Re-checks a payment's real state with the gateway, server-to-server.
   *
   * The client cannot assert an outcome here — it only names the transaction.
   * This is the safe way for an app to resolve a payment whose browser
   * callback was lost.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyPayment(
    @CurrentUser() user: JwtPayload,
    @Body() dto: VerifyPaymentDto,
  ) {
    return this.paymentsService.verifyPayment(user.sub, dto);
  }

  /**
   * Retries a failed, cancelled or expired online top-up. The amount comes
   * from the still-open credit request, never from the request body.
   */
  @Post('retry')
  @HttpCode(HttpStatus.CREATED)
  async retryPayment(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RetryPaymentDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    return this.paymentsService.retryPayment(
      user.sub,
      dto,
      this.requireIdempotencyKey(idempotencyKey),
    );
  }

  /**
   * Cancels an online top-up the customer abandoned before paying, releasing
   * the pending-top-up slot immediately so they can start a new one.
   *
   * The server re-verifies the real state with the gateway first, so a payment
   * that actually succeeded is never discarded.
   */
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  async cancelPayment(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CancelPaymentDto,
  ) {
    return this.paymentsService.cancelPendingTopUp(user.sub, dto.transactionId);
  }

  /** The authenticated customer's own payments. Never another customer's. */
  @Get()
  @HttpCode(HttpStatus.OK)
  async listPayments(
    @CurrentUser() user: JwtPayload,
    @Query() query: CustomerListPaymentsQueryDto,
  ) {
    return this.paymentsService.getCustomerPayments(user.sub, query);
  }

  /**
   * A single payment, including whether the wallet credit it funds has been
   * completed — so the app can show "Payment successful" and "Wallet credited"
   * as the distinct events they are for a first credit.
   */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getPayment(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.paymentsService.getCustomerPayment(user.sub, id);
  }

  private requireIdempotencyKey(value: string): string {
    if (!value || typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    return value.trim();
  }
}
