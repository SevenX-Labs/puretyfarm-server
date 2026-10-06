import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminDashboardOverviewQueryDto } from './dto/admin-dashboard-overview-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@Controller(['api/v1/admin/dashboard', 'admin/dashboard'])
@UseGuards(JwtAuthGuard)
@Roles('ADMIN')
export class AdminDashboardController {
  constructor(private readonly adminDashboardService: AdminDashboardService) {}

  @Get('overview')
  async getOverview(@Query() query: AdminDashboardOverviewQueryDto) {
    return this.adminDashboardService.getOverview(query);
  }
}
