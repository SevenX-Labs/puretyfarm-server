import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { CreateCreditRequestDto } from './dto/customer/create-credit-request.dto';
import { ListTransactionsQueryDto } from './dto/customer/list-transactions-query.dto';
import { ListCreditRequestsQueryDto } from './dto/customer/list-credit-requests-query.dto';

@Controller(['api/v1/customer/wallet', 'customer/wallet'])
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getWallet(@CurrentUser() user: JwtPayload) {
    return this.walletService.getWallet(user.sub);
  }

  @Post('credit-request')
  @HttpCode(HttpStatus.CREATED)
  async createCreditRequest(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateCreditRequestDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    if (
      !idempotencyKey ||
      typeof idempotencyKey !== 'string' ||
      !idempotencyKey.trim()
    ) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    return this.walletService.createCreditRequest(
      user.sub,
      dto,
      idempotencyKey.trim(),
    );
  }

  @Get('transactions')
  @HttpCode(HttpStatus.OK)
  async getTransactions(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListTransactionsQueryDto,
  ) {
    return this.walletService.getTransactions(user.sub, query);
  }

  @Get('credit-requests')
  @HttpCode(HttpStatus.OK)
  async getCreditRequests(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListCreditRequestsQueryDto,
  ) {
    return this.walletService.getCreditRequests(user.sub, query);
  }
}
