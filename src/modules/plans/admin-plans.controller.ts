import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PlansService } from './plans.service';
import { ApproveSubscriptionPlanDto } from './dto/admin/approve-subscription.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { PlanType } from './plans.constants';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';

const planTypePipe = new ParseEnumPipe(PlanType, {
  exceptionFactory: () =>
    new BadRequestException(
      `planType must be one of: ${Object.values(PlanType).join(', ')}`,
    ),
});

/**
 * Admin-side plan configuration. Lives in the SAME PlansModule as the customer
 * controller and shares the SAME PlansService/PlanConfig rows, so admin edits
 * flow straight into customer eligibility and quotes.
 *
 * Every route requires an ADMIN JWT: JwtAuthGuard authenticates and @Roles
 * enforces the ADMIN role, so a customer token receives 403. The three plan
 * types are fixed — there is no create/delete route.
 */
@Controller(['api/v1/admin/plans', 'admin/plans'])
@UseGuards(JwtAuthGuard)
@Roles('ADMIN')
export class AdminPlansController {
  constructor(private readonly plansService: PlansService) {}

  @Get('subscriptions')
  @HttpCode(HttpStatus.OK)
  async getSubscriptions(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('planType') planType?: string,
    @Query('search') search?: string,
  ) {
    return this.plansService.getAdminSubscriptions({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      status,
      planType,
      search,
    });
  }

  @Post('subscriptions/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approveSubscription(
    @CurrentUser() admin: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ApproveSubscriptionPlanDto,
  ) {
    return this.plansService.adminApproveSubscription(admin.sub, id, dto);
  }

  @Post('subscriptions/:id/start-date')
  @HttpCode(HttpStatus.OK)
  async updateSubscriptionStartDate(
    @CurrentUser() admin: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ApproveSubscriptionPlanDto,
  ) {
    return this.plansService.adminApproveSubscription(admin.sub, id, dto);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async getPlans() {
    return this.plansService.getAdminPlans();
  }

  @Get(':planType')
  @HttpCode(HttpStatus.OK)
  async getPlan(@Param('planType', planTypePipe) planType: PlanType) {
    return this.plansService.getAdminPlan(planType);
  }

  /**
   * The body is validated against the plan-specific DTO inside the service
   * (its shape depends on :planType); unknown fields such as adminId are 400.
   */
  @Patch(':planType')
  @HttpCode(HttpStatus.OK)
  async updatePlan(
    @Param('planType', planTypePipe) planType: PlanType,
    @Body() body: Record<string, unknown>,
  ) {
    return this.plansService.updateAdminPlan(planType, body);
  }
}
