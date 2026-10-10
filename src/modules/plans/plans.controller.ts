import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { PlansService } from './plans.service';
import { BuyOnceQuoteDto } from './dto/customer/buy-once-quote.dto';
import { TrialQuoteDto } from './dto/customer/trial-quote.dto';
import { MonthlyQuoteDto } from './dto/customer/monthly-quote.dto';
import { ConfirmPlanDto } from './dto/customer/confirm-plan.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';

/**
 * Customer-facing plan selection APIs. All endpoints require a CUSTOMER JWT.
 * Identity is always taken from JWT.sub — the body never supplies a userId.
 */
@Controller(['api/v1/customer/plans', 'customer/plans'])
@UseGuards(JwtAuthGuard)
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  /** Returns all three plans with customer-specific availability. */
  @Get()
  @HttpCode(HttpStatus.OK)
  async getPlans(@CurrentUser() user: JwtPayload) {
    return this.plansService.getPlansOverview(user.sub);
  }

  // ── Buy Once ──────────────────────────────────────────────────

  @Get('buy-once/eligibility')
  @HttpCode(HttpStatus.OK)
  async buyOnceEligibility(@CurrentUser() user: JwtPayload) {
    return this.plansService.getBuyOnceEligibility(user.sub);
  }

  @Post('buy-once/quote')
  @HttpCode(HttpStatus.OK)
  async buyOnceQuote(
    @CurrentUser() user: JwtPayload,
    @Body() dto: BuyOnceQuoteDto,
  ) {
    return this.plansService.createBuyOnceQuote(user.sub, dto);
  }

  // ── 7-Day Trial ───────────────────────────────────────────────

  @Get('trial/eligibility')
  @HttpCode(HttpStatus.OK)
  async trialEligibility(@CurrentUser() user: JwtPayload) {
    return this.plansService.getTrialEligibility(user.sub);
  }

  @Post('trial/quote')
  @HttpCode(HttpStatus.OK)
  async trialQuote(
    @CurrentUser() user: JwtPayload,
    @Body() dto: TrialQuoteDto,
  ) {
    return this.plansService.createTrialQuote(user.sub, dto);
  }

  // ── Monthly ───────────────────────────────────────────────────

  @Get('monthly')
  @HttpCode(HttpStatus.OK)
  async monthly() {
    return this.plansService.getMonthlyInfo();
  }

  @Post('monthly/quote')
  @HttpCode(HttpStatus.OK)
  async monthlyQuote(
    @CurrentUser() user: JwtPayload,
    @Body() dto: MonthlyQuoteDto,
  ) {
    return this.plansService.createMonthlyQuote(user.sub, dto);
  }

  // ── Confirm ───────────────────────────────────────────────────

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmPlanDto) {
    return this.plansService.confirmPlan(user.sub, dto);
  }
}
