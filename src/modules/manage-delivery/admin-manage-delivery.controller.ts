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
} from '@nestjs/common';
import { ManageDeliveryService } from './manage-delivery.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { RejectRequestDto } from './dto/admin/reject-request.dto';
import { ListRequestsQueryDto } from './dto/admin/list-requests-query.dto';

@Controller(['api/v1/admin/manage-delivery', 'admin/manage-delivery'])
@UseGuards(JwtAuthGuard)
@Roles('ADMIN')
export class AdminManageDeliveryController {
  constructor(private readonly service: ManageDeliveryService) {}

  @Get('requests')
  @HttpCode(HttpStatus.OK)
  async listRequests(@Query() query: ListRequestsQueryDto) {
    return this.service.getAdminRequests(query);
  }

  @Get('requests/:requestId')
  @HttpCode(HttpStatus.OK)
  async getRequest(@Param('requestId') requestId: string) {
    return this.service.getAdminRequest(requestId);
  }

  @Post('requests/:requestId/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @CurrentUser() admin: JwtPayload,
    @Param('requestId') requestId: string,
  ) {
    return this.service.approveRequest(admin.sub, requestId);
  }

  @Post('requests/:requestId/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @CurrentUser() admin: JwtPayload,
    @Param('requestId') requestId: string,
    @Body() dto: RejectRequestDto,
  ) {
    return this.service.rejectRequest(admin.sub, requestId, dto);
  }
}
