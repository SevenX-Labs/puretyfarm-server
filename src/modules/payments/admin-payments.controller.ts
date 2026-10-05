import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { AdminListPaymentsQueryDto } from './dto/admin/list-payments-query.dto';
import { AdminListCashCollectionsQueryDto } from './dto/admin/list-cash-collections-query.dto';
import { ConfirmCashCollectionDto } from './dto/admin/confirm-cash-collection.dto';
import { RejectCashCollectionDto } from './dto/admin/reject-cash-collection.dto';

/**
 * Admin payment APIs.
 *
 * Deliberately NOT present: any endpoint that marks an online payment
 * successful. An online payment reaches SUCCESS only through hash-verified
 * PayU communication. Admins handle business operations only — confirming
 * physical cash, and triggering a refund for a credit request they rejected.
 *
 * Wallet credit approval is NOT duplicated here either: it stays on the
 * existing POST /api/v1/admin/wallet/credit-requests/:id/approve.
 *
 * The acting admin always comes from `JWT.sub`; no DTO in this controller
 * accepts an `adminId`.
 */
@Controller(['api/v1/admin/payments', 'admin/payments'])
@UseGuards(JwtAuthGuard)
@Roles('ADMIN')
export class AdminPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // ── Cash collections ──────────────────────────────────────────────
  // Declared before the `:id` payment routes so "cash-collections" is never
  // captured as a payment id by the route matcher.

  @Get('cash-collections')
  @HttpCode(HttpStatus.OK)
  async listCashCollections(@Query() query: AdminListCashCollectionsQueryDto) {
    return this.paymentsService.getAdminCashCollections(query);
  }

  @Get('cash-collections/:id')
  @HttpCode(HttpStatus.OK)
  async getCashCollection(@Param('id') id: string) {
    return this.paymentsService.getAdminCashCollection(id);
  }

  /**
   * Confirms the physical cash was received. This is the operational gate
   * that credits the wallet, via WalletService.
   */
  @Post('cash-collections/:id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmCashCollection(
    @CurrentUser() admin: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ConfirmCashCollectionDto,
  ) {
    return this.paymentsService.confirmCashCollection(id, admin.sub, dto);
  }

  /** Cancels a cash collection. No wallet credit, no refund obligation. */
  @Post('cash-collections/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelCashCollection(
    @CurrentUser() admin: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RejectCashCollectionDto,
  ) {
    return this.paymentsService.cancelCashCollection(id, admin.sub, dto);
  }

  /**
   * Requests a gateway refund for a credit request the admin rejected through
   * the existing wallet endpoint. The payment moves to REFUND_PENDING; it
   * becomes REFUNDED only when PayU confirms via the webhook.
   */
  @Post('credit-requests/:creditRequestId/refund')
  @HttpCode(HttpStatus.OK)
  async refundRejectedCreditRequest(
    @Param('creditRequestId') creditRequestId: string,
  ) {
    return this.paymentsService.initiateRefundForRejectedCreditRequest(
      creditRequestId,
    );
  }

  // ── Payments (read-only) ──────────────────────────────────────────

  @Get()
  @HttpCode(HttpStatus.OK)
  async listPayments(@Query() query: AdminListPaymentsQueryDto) {
    return this.paymentsService.getAdminPayments(query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getPayment(@Param('id') id: string) {
    return this.paymentsService.getAdminPayment(id);
  }
}
