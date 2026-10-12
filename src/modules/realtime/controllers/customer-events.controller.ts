import {
  Controller,
  Get,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/jwt-payload.interface';
import { RealtimeEventsService } from '../realtime-events.service';

@Controller(['api/v1/customer/events', 'customer/events'])
@UseGuards(JwtAuthGuard)
export class CustomerEventsController {
  constructor(private readonly realtimeService: RealtimeEventsService) {}

  @Get('stream')
  stream(
    @CurrentUser() user: JwtPayload & { exp?: number },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.realtimeService.handleStreamConnection(
      user.sub,
      'CUSTOMER',
      req,
      res,
      user.exp,
    );
  }
}
