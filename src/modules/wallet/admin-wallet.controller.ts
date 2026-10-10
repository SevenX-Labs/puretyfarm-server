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
  Inject,
  forwardRef,
} from "@nestjs/common";
import { WalletService } from "./wallet.service";
import { PaymentsService } from "../payments/payments.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { JwtPayload } from "../../common/interfaces/jwt-payload.interface";
import { AdminListCreditRequestsQueryDto } from "./dto/admin/list-credit-requests-query.dto";
import { RejectCreditRequestDto } from "./dto/admin/reject-credit-request.dto";
import { AdminManualWalletAdjustmentDto } from "./dto/admin/manual-wallet-adjustment.dto";
import { Headers } from "@nestjs/common";

@Controller(["api/v1/admin/wallet", "admin/wallet"])
@UseGuards(JwtAuthGuard)
@Roles("ADMIN")
export class AdminWalletController {
  constructor(
    private readonly walletService: WalletService,
    // forwardRef resolves the WalletModule <-> PaymentsModule cycle.
    @Inject(forwardRef(() => PaymentsService))
    private readonly paymentsService: PaymentsService,
  ) {}

  @Get("credit-requests")
  @HttpCode(HttpStatus.OK)
  async listCreditRequests(@Query() query: AdminListCreditRequestsQueryDto) {
    return this.walletService.getAdminCreditRequests(query);
  }

  @Get("credit-requests/:id")
  @HttpCode(HttpStatus.OK)
  async getCreditRequest(@Param("id") id: string) {
    return this.walletService.getAdminCreditRequest(id);
  }

  @Post("credit-requests/:id/approve")
  @HttpCode(HttpStatus.OK)
  async approveCreditRequest(
    @CurrentUser() admin: JwtPayload,
    @Param("id") id: string,
  ) {
    return this.walletService.approveCreditRequest(id, admin.sub);
  }

  @Post("credit-requests/:id/reject")
  @HttpCode(HttpStatus.OK)
  async rejectCreditRequest(
    @CurrentUser() admin: JwtPayload,
    @Param("id") id: string,
    @Body() dto: RejectCreditRequestDto,
  ) {
    // Reject the wallet credit request first — this is the authoritative
    // decision and must succeed before any provider call. The wallet is NEVER
    // credited on this path.
    const rejection = await this.walletService.rejectCreditRequest(
      id,
      admin.sub,
      dto,
    );

    // Then, as part of the same admin action, hand the request to the Payment
    // module to start the PayU refund if there is a settled ONLINE payment
    // behind it. The call no-ops for cash top-ups (no PayU payment exists) and
    // for retried rejections (refund already in progress). The wallet reject
    // outcome is NOT reversed if the refund request itself fails: the admin
    // can retry via POST /admin/payments/credit-requests/:id/refund.
    const refund = await this.paymentsService.initiateRefundIfApplicable(id);

    return { ...rejection, refund };
  }

  @Get("customers/:userId")
  @HttpCode(HttpStatus.OK)
  async getCustomerWallet(@Param("userId") userId: string) {
    return this.walletService.getAdminCustomerWallet(userId);
  }

  @Post("customers/:userId/credit")
  @HttpCode(HttpStatus.OK)
  async manualCredit(
    @CurrentUser() admin: JwtPayload,
    @Param("userId") userId: string,
    @Body() dto: AdminManualWalletAdjustmentDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.walletService.adminManualCredit(userId, admin.sub, dto, idempotencyKey);
  }

  @Post("customers/:userId/debit")
  @HttpCode(HttpStatus.OK)
  async manualDebit(
    @CurrentUser() admin: JwtPayload,
    @Param("userId") userId: string,
    @Body() dto: AdminManualWalletAdjustmentDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.walletService.adminManualDebit(userId, admin.sub, dto, idempotencyKey);
  }

}
