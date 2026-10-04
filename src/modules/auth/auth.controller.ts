import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { CustomerLoginDto } from './dto/customer/customer-login.dto';
import { CustomerVerifyOtpDto } from './dto/customer/customer-verify-otp.dto';
import { CustomerRefreshTokenDto } from './dto/customer/customer-refresh-token.dto';
import { CustomerEmailSendOtpDto } from './dto/customer/customer-email-send-otp.dto';
import { CustomerEmailVerifyOtpDto } from './dto/customer/customer-email-verify-otp.dto';
import { AdminLoginDto } from './dto/admin/login.dto';
import { AdminChangePasswordDto } from './dto/admin/change-password.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/jwt-payload.interface';

@Controller(['api/v1/auth', 'auth'])
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ==========================================
  // CUSTOMER AUTHENTICATION ENDPOINTS
  // ==========================================

  @Post('customer/login')
  @HttpCode(HttpStatus.OK)
  async customerLogin(@Body() dto: CustomerLoginDto) {
    return this.authService.customerLogin(dto);
  }

  @Post('customer/verify-otp')
  @HttpCode(HttpStatus.OK)
  async customerVerifyOtp(@Body() dto: CustomerVerifyOtpDto) {
    return this.authService.customerVerifyOtp(dto);
  }

  @Post('customer/refresh')
  @HttpCode(HttpStatus.OK)
  async customerRefresh(@Body() dto: CustomerRefreshTokenDto) {
    return this.authService.customerRefreshToken(dto);
  }

  @Post('customer/logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async customerLogout(@CurrentUser() user: JwtPayload) {
    return this.authService.customerLogout(user.sub, user.sessionId);
  }

  @Get('customer/get-me')
  @UseGuards(JwtAuthGuard)
  async customerGetMe(@CurrentUser() user: JwtPayload) {
    return this.authService.customerGetMe(user.sub);
  }

  @Post('customer/email-verification/send-otp')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async customerEmailSendOtp(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CustomerEmailSendOtpDto,
  ) {
    return this.authService.customerSendEmailOtp(user.sub, dto);
  }

  @Post('customer/email-verification/verify-otp')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async customerEmailVerifyOtp(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CustomerEmailVerifyOtpDto,
  ) {
    return this.authService.customerVerifyEmailOtp(user.sub, dto);
  }

  // ==========================================
  // ADMIN AUTHENTICATION ENDPOINTS
  // ==========================================

  @Post('admin/login')
  @HttpCode(HttpStatus.OK)
  async adminLogin(@Body() dto: AdminLoginDto) {
    return this.authService.adminLogin(dto);
  }

  @Post('admin/change-password')
  @UseGuards(JwtAuthGuard)
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async adminChangePassword(
    @CurrentUser() user: JwtPayload,
    @Body() dto: AdminChangePasswordDto,
  ) {
    return this.authService.adminChangePassword(user.sub, dto);
  }

  @Get('admin/get-me')
  @UseGuards(JwtAuthGuard)
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async adminGetMe(@CurrentUser() user: JwtPayload) {
    return this.authService.adminGetMe(user.sub);
  }
}
