import {
  Controller,
  Post,
  Get,
  Patch,
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
import { CreateMpinDto } from './dto/customer/create-mpin.dto';
import { VerifyMpinDto } from './dto/customer/verify-mpin.dto';
import { ChangeMpinDto } from './dto/customer/change-mpin.dto';
import { ResetMpinDto } from './dto/customer/reset-mpin.dto';
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
  // MPIN ENDPOINTS
  // ==========================================

  @Post('customer/create-mpin')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createMpin(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateMpinDto,
  ) {
    return this.authService.createMpin(user.sub, dto);
  }

  @Post('customer/verify-mpin')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async verifyMpin(
    @CurrentUser() user: JwtPayload,
    @Body() dto: VerifyMpinDto,
  ) {
    return this.authService.verifyMpin(user.sub, dto);
  }

  @Patch('customer/change-mpin')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async changeMpin(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangeMpinDto,
  ) {
    return this.authService.changeMpin(user.sub, dto);
  }

  @Post('customer/reset-mpin')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async resetMpin(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ResetMpinDto,
  ) {
    return this.authService.resetMpin(user.sub, dto);
  }

  @Get('customer/mpin-status')
  @UseGuards(JwtAuthGuard)
  async getMpinStatus(@CurrentUser() user: JwtPayload) {
    return this.authService.getMpinStatus(user.sub);
  }

  // ==========================================
  // ADMIN AUTHENTICATION ENDPOINTS
  // ==========================================

  @Post('admin/login')
  @HttpCode(HttpStatus.OK)
  async adminLogin(@Body() dto: AdminLoginDto) {
    return this.authService.adminLogin(dto);
  }

  @Post('admin/refresh')
  @HttpCode(HttpStatus.OK)
  async adminRefresh(@Body() dto: CustomerRefreshTokenDto) {
    return this.authService.customerRefreshToken(dto);
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
