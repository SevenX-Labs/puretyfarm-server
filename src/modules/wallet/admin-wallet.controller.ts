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
import { WalletService } from "./wallet.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { JwtPayload } from "../../common/interfaces/jwt-payload.interface";
import { AdminListCreditRequestsQueryDto } from "./dto/admin/list-credit-requests-query.dto";
import { RejectCreditRequestDto } from "./dto/admin/reject-credit-request.dto";

@Controller(["api/v1/admin/wallet", "admin/wallet"])
@UseGuards(JwtAuthGuard)
@Roles("ADMIN")
export class AdminWalletController {
  constructor(private readonly walletService: WalletService) {}

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
    return this.walletService.rejectCreditRequest(id, admin.sub, dto);
  }

  @Get("customers/:userId")
  @HttpCode(HttpStatus.OK)
  async getCustomerWallet(@Param("userId") userId: string) {
    return this.walletService.getAdminCustomerWallet(userId);
  }
}
