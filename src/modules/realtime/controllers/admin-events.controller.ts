import {
  Controller,
  Get,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { RealtimeEventsService } from '../realtime-events.service';

@Controller(['api/v1/admin/events', 'admin/events'])
@UseGuards(JwtAuthGuard)
@Roles('ADMIN')
export class AdminEventsController {
  constructor(private readonly realtimeService: RealtimeEventsService) {}

  @Get('stream')
  stream(
    @CurrentUser() admin: JwtPayload & { exp?: number },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.realtimeService.handleStreamConnection(
      admin.sub,
      'ADMIN',
      req,
      res,
      admin.exp,
    );
  }
}
