import { Fast2SmsService } from '../sms/fast2sms.service';
import { randomUUID } from 'crypto';
import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { ValkeyService } from '../../valkey/valkey.service';
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
import { normalizeMobile } from '../../common/utils/phone.util';
import {
  getIstDateString,
  getSecondsUntilIstMidnight,
} from '../../common/utils/ist-date.util';
import {
  generateSecureOtp,
  hashValue,
  verifyHash,
} from '../../common/utils/crypto.util';
import { hashSecret, verifySecret } from '../../common/utils/secret-hash.util';
import { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { Prisma } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private static readonly MPIN_MAX_ATTEMPTS = 5;
  private static readonly MPIN_LOCKOUT_MINUTES = 15;

  // Contexts that bind each hashed secret to its subject, so a hash lifted
  // from one mobile/user/session cannot be replayed against another.
  private static otpContext(mobile: string): string {
    return `customer-otp:${mobile}`;
  }

  private static emailOtpContext(userId: string): string {
    return `customer-email-otp:${userId}`;
  }

  private static refreshTokenContext(sessionId: string): string {
    return `refresh-token:${sessionId}`;
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly valkeyService: ValkeyService,
    private readonly fast2SmsService: Fast2SmsService,
  ) {}

  private get otpExpirySeconds(): number {
    return Number(this.configService.get('OTP_EXPIRY_SECONDS')) || 300;
  }

  private get otpResendCooldownSeconds(): number {
    return Number(this.configService.get('OTP_RESEND_COOLDOWN_SECONDS')) || 60;
  }

  private get otpMaxVerifyAttempts(): number {
    return Number(this.configService.get('OTP_MAX_VERIFY_ATTEMPTS')) || 5;
  }

  private get otpSendLimit(): number {
    return Number(this.configService.get('OTP_SEND_LIMIT')) || 5;
  }

  private get otpSendWindowSeconds(): number {
    return Number(this.configService.get('OTP_SEND_WINDOW_SECONDS')) || 300;
  }

  private get otpDailySendLimit(): number {
    return Number(this.configService.get('OTP_DAILY_SEND_LIMIT')) || 20;
  }

  private get emailDailySendLimit(): number {
    return Number(this.configService.get('EMAIL_OTP_DAILY_SEND_LIMIT')) || 10;
  }

  private get accessSecret(): string {
    const secret = this.configService.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      throw new InternalServerErrorException(
        'Authentication is not configured',
      );
    }
    return secret;
  }

  private get refreshSecret(): string {
    const secret = this.configService.get<string>('JWT_REFRESH_SECRET');
    if (!secret) {
      throw new InternalServerErrorException(
        'Authentication is not configured',
      );
    }
    return secret;
  }

  private get accessExpiresIn(): string {
    return this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') || '30m';
  }

  private get refreshExpiresIn(): string {
    return this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '90d';
  }

  // ==========================================
  // CUSTOMER AUTHENTICATION METHODS
  // ==========================================

  async customerLogin(
    dto: CustomerLoginDto,
  ): Promise<{ success: boolean; message: string }> {
    const normalizedMobile = normalizeMobile(dto.mobile);

    const cooldownKey = `auth:customer:otp:cooldown:${normalizedMobile}`;
    const fiveMinKey = `auth:customer:otp:send:${normalizedMobile}:5m`;
    const todayIst = getIstDateString();
    const dailyKey = `auth:customer:otp:send:${normalizedMobile}:daily:${todayIst}`;
    const secondsUntilMidnight = getSecondsUntilIstMidnight();

    const reservation = await this.valkeyService.reserveSendSlot(
      cooldownKey,
      this.otpResendCooldownSeconds,
      [
        {
          key: fiveMinKey,
          limit: this.otpSendLimit,
          ttlSeconds: this.otpSendWindowSeconds,
        },
        {
          key: dailyKey,
          limit: this.otpDailySendLimit,
          ttlSeconds: secondsUntilMidnight,
        },
      ],
    );

    if (reservation === -1) {
      throw new HttpException(
        'Please wait before requesting another OTP',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (reservation === -2) {
      throw new HttpException(
        'Too many OTP requests. Please try again after 5 minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (reservation === -3) {
      throw new HttpException(
        'Daily OTP limit exceeded. Please try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const otp = generateSecureOtp();
    const hashedOtp = hashSecret(otp, AuthService.otpContext(normalizedMobile));
    const otpKey = `auth:customer:otp:${normalizedMobile}`;

    await Promise.all([
      this.valkeyService.set(otpKey, hashedOtp, this.otpExpirySeconds),
      this.valkeyService.delete(
        `auth:customer:otp:attempts:${normalizedMobile}`,
      ),
    ]);

    const smsResult = await this.fast2SmsService.sendOtp(normalizedMobile, otp);
    if (!smsResult.success) {
      this.logger.error(
        `[Fast2SMS] Failed to send OTP to ${normalizedMobile}: ${smsResult.error}`,
      );
      throw new HttpException(
        smsResult.error || "Failed to dispatch OTP SMS. Please try again.",
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(
        `[AUTH][DEV] Customer OTP Mobile: ${normalizedMobile} OTP: ${otp} Expires: 5 minutes`,
      );
    }

    return {
      success: true,
      message: 'OTP sent successfully',
    };
  }

  async customerVerifyOtp(dto: CustomerVerifyOtpDto) {
    const normalizedMobile = normalizeMobile(dto.mobile);
    const otpKey = `auth:customer:otp:${normalizedMobile}`;
    const attemptsKey = `auth:customer:otp:attempts:${normalizedMobile}`;

    const [storedHash, attemptsStr] = await Promise.all([
      this.valkeyService.get(otpKey),
      this.valkeyService.get(attemptsKey),
    ]);
    if (!storedHash) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    const currentAttempts = attemptsStr ? Number(attemptsStr) : 0;
    if (currentAttempts >= this.otpMaxVerifyAttempts) {
      await this.valkeyService.delete(otpKey);
      throw new BadRequestException(
        'Maximum verification attempts exceeded. Please request a new OTP.',
      );
    }

    const isValid = await verifySecret(
      storedHash,
      dto.otp,
      AuthService.otpContext(normalizedMobile),
    );
    if (!isValid) {
      const attempts = await this.valkeyService.incr(attemptsKey);
      if (attempts === 1) {
        await this.valkeyService.expire(attemptsKey, this.otpExpirySeconds);
      }
      if (attempts >= this.otpMaxVerifyAttempts) {
        await this.valkeyService.delete(otpKey);
        throw new BadRequestException(
          'Maximum verification attempts exceeded. Please request a new OTP.',
        );
      }
      const remaining = this.otpMaxVerifyAttempts - attempts;
      throw new BadRequestException(
        `Invalid OTP. Attempts remaining: ${remaining}`,
      );
    }

    const [consumed] = await Promise.all([
      this.valkeyService.compareAndDelete(otpKey, storedHash),
      this.valkeyService.delete(attemptsKey),
    ]);
    if (!consumed) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    const user = await this.usersService.findOrCreateByMobile(normalizedMobile);

    // Authorize MPIN reset for 15 minutes after successful OTP verification.
    await this.valkeyService.set(
      `mpin_reset_authorized:${user.id}`,
      'true',
      900,
    );

    const sessionId = randomUUID();
    const sessionExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    const [refreshToken, accessToken] = await Promise.all([
      this.jwtService.signAsync(
        {
          sub: user.id,
          role: user.role,
          sessionId,
          type: 'refresh',
        },
        {
          secret: this.refreshSecret,
          expiresIn: this.refreshExpiresIn as any,
        },
      ),
      this.jwtService.signAsync(
        {
          sub: user.id,
          role: user.role,
          sessionId,
          type: 'access',
        },
        {
          secret: this.accessSecret,
          expiresIn: this.accessExpiresIn as any,
        },
      ),
    ]);

    const refreshTokenHash = hashSecret(
      refreshToken,
      AuthService.refreshTokenContext(sessionId),
    );

    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshTokenHash,
        expiresAt: sessionExpiresAt,
      },
    });

    return {
      success: true,
      message: 'Authentication successful',
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        mobile: user.mobile,
        email: user.email,
        emailVerified: user.emailVerified,
        role: user.role,
        isMpinSet: !!user.mpinHash,
      },
    };
  }

  async customerRefreshToken(dto: CustomerRefreshTokenDto) {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(
        dto.refreshToken,
        {
          secret: this.refreshSecret,
        },
      );
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (payload.type !== 'refresh' || !payload.sessionId) {
      throw new UnauthorizedException('Invalid refresh token type');
    }

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sessionId },
      include: { user: true, admin: true },
    });

    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt < new Date()
    ) {
      throw new UnauthorizedException('Session has been revoked or expired');
    }

    const isMatch = await verifySecret(
      session.refreshTokenHash,
      dto.refreshToken,
      AuthService.refreshTokenContext(session.id),
    );
    if (!isMatch) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const subject = session.userId ?? session.adminId!;
    const role = session.user?.role ?? 'ADMIN';

    const [newRefreshToken, accessToken] = await Promise.all([
      this.jwtService.signAsync(
        {
          sub: subject,
          role,
          sessionId: session.id,
          type: 'refresh',
        },
        {
          secret: this.refreshSecret,
          expiresIn: this.refreshExpiresIn as any,
        },
      ),
      this.jwtService.signAsync(
        {
          sub: subject,
          role,
          sessionId: session.id,
          type: 'access',
        },
        {
          secret: this.accessSecret,
          expiresIn: this.accessExpiresIn as any,
        },
      ),
    ]);

    const newHash = hashSecret(
      newRefreshToken,
      AuthService.refreshTokenContext(session.id),
    );
    const rotation = await this.prisma.session.updateMany({
      where: {
        id: session.id,
        refreshTokenHash: session.refreshTokenHash,
        revokedAt: null,
      },
      data: {
        refreshTokenHash: newHash,
        lastUsedAt: new Date(),
      },
    });

    if (rotation.count === 0) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    return {
      success: true,
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  async customerLogout(
    userId: string,
    sessionId: string,
  ): Promise<{ success: boolean; message: string }> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return {
      success: true,
      message: 'Logged out successfully',
    };
  }

  async customerGetMe(userId: string) {
    const user = await this.usersService.findById(userId);
    return {
      id: user.id,
      mobile: user.mobile,
      email: user.email,
      emailVerified: user.emailVerified,
      role: user.role,
      isMpinSet: !!user.mpinHash,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  // ==========================================
  // MPIN METHODS
  // ==========================================

  async createMpin(
    userId: string,
    dto: CreateMpinDto,
  ): Promise<{ success: boolean; message: string }> {
    if (dto.mpin !== dto.confirmMpin) {
      throw new BadRequestException('MPIN and confirmation do not match');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.mpinHash) {
      throw new ConflictException(
        'MPIN is already set. Use change-mpin to update it.',
      );
    }

    const mpinHash = await hashValue(dto.mpin);
    const now = new Date();
    await this.prisma.user.update({
      where: { id: userId },
      data: { mpinHash, mpinCreatedAt: now, mpinUpdatedAt: now },
    });

    return { success: true, message: 'MPIN created successfully' };
  }

  async verifyMpin(
    userId: string,
    dto: VerifyMpinDto,
  ): Promise<{ success: boolean; message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.mpinHash) {
      throw new BadRequestException('MPIN is not set. Please create one first.');
    }

    if (user.mpinLockedUntil && user.mpinLockedUntil > new Date()) {
      const remainingMs = user.mpinLockedUntil.getTime() - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      throw new BadRequestException(
        `MPIN verification locked. Try again in ${remainingMinutes} minute(s).`,
      );
    }

    const isValid = await verifyHash(user.mpinHash, dto.mpin);
    if (!isValid) {
      const newAttempts = user.failedMpinAttempts + 1;
      const updateData: Record<string, unknown> = {
        failedMpinAttempts: newAttempts,
      };

      if (newAttempts >= AuthService.MPIN_MAX_ATTEMPTS) {
        updateData.mpinLockedUntil = new Date(
          Date.now() + AuthService.MPIN_LOCKOUT_MINUTES * 60 * 1000,
        );
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      });

      if (newAttempts >= AuthService.MPIN_MAX_ATTEMPTS) {
        throw new UnauthorizedException(
          `MPIN locked for ${AuthService.MPIN_LOCKOUT_MINUTES} minutes due to too many failed attempts.`,
        );
      }

      const remaining = AuthService.MPIN_MAX_ATTEMPTS - newAttempts;
      throw new UnauthorizedException(
        `Invalid MPIN. Attempts remaining: ${remaining}`,
      );
    }

    if (user.failedMpinAttempts > 0 || user.mpinLockedUntil) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { failedMpinAttempts: 0, mpinLockedUntil: null },
      });
    }

    return { success: true, message: 'MPIN verified successfully' };
  }

  async changeMpin(
    userId: string,
    dto: ChangeMpinDto,
  ): Promise<{ success: boolean; message: string }> {
    if (dto.newMpin !== dto.confirmMpin) {
      throw new BadRequestException(
        'New MPIN and confirmation do not match',
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.mpinHash) {
      throw new BadRequestException('MPIN is not set. Please create one first.');
    }

    if (user.mpinLockedUntil && user.mpinLockedUntil > new Date()) {
      const remainingMs = user.mpinLockedUntil.getTime() - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      throw new BadRequestException(
        `MPIN verification locked. Try again in ${remainingMinutes} minute(s).`,
      );
    }

    const isValid = await verifyHash(user.mpinHash, dto.currentMpin);
    if (!isValid) {
      const newAttempts = user.failedMpinAttempts + 1;
      const updateData: Record<string, unknown> = {
        failedMpinAttempts: newAttempts,
      };

      if (newAttempts >= AuthService.MPIN_MAX_ATTEMPTS) {
        updateData.mpinLockedUntil = new Date(
          Date.now() + AuthService.MPIN_LOCKOUT_MINUTES * 60 * 1000,
        );
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      });

      if (newAttempts >= AuthService.MPIN_MAX_ATTEMPTS) {
        throw new UnauthorizedException(
          `MPIN locked for ${AuthService.MPIN_LOCKOUT_MINUTES} minutes due to too many failed attempts.`,
        );
      }

      const remaining = AuthService.MPIN_MAX_ATTEMPTS - newAttempts;
      throw new UnauthorizedException(
        `Invalid current MPIN. Attempts remaining: ${remaining}`,
      );
    }

    const mpinHash = await hashValue(dto.newMpin);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mpinHash,
        mpinUpdatedAt: new Date(),
        failedMpinAttempts: 0,
        mpinLockedUntil: null,
      },
    });

    return { success: true, message: 'MPIN changed successfully' };
  }

  async resetMpin(
    userId: string,
    dto: ResetMpinDto,
  ): Promise<{ success: boolean; message: string }> {
    if (dto.newMpin !== dto.confirmMpin) {
      throw new BadRequestException(
        'New MPIN and confirmation do not match',
      );
    }

    const resetKey = `mpin_reset_authorized:${userId}`;
    const authorized = await this.valkeyService.get(resetKey);
    if (!authorized) {
      throw new ForbiddenException(
        'OTP verification required before resetting MPIN',
      );
    }

    const mpinHash = await hashValue(dto.newMpin);
    const now = new Date();

    await Promise.all([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          mpinHash,
          mpinUpdatedAt: now,
          mpinCreatedAt: now,
          failedMpinAttempts: 0,
          mpinLockedUntil: null,
        },
      }),
      this.valkeyService.delete(resetKey),
    ]);

    return { success: true, message: 'MPIN reset successfully' };
  }

  async getMpinStatus(
    userId: string,
  ): Promise<{ isMpinSet: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return { isMpinSet: !!user.mpinHash };
  }

  // ==========================================
  // EMAIL VERIFICATION METHODS
  // ==========================================

  async customerSendEmailOtp(
    userId: string,
    dto: CustomerEmailSendOtpDto,
  ): Promise<{ success: boolean; message: string }> {
    const normalizedEmail = dto.email.toLowerCase().trim();

    const existing = await this.usersService.findByEmail(normalizedEmail);
    if (existing && existing.id !== userId) {
      throw new ConflictException(
        'Email is already associated with another account',
      );
    }

    const cooldownKey = `auth:customer:email:cooldown:${userId}`;
    const dailyKey = `auth:customer:email:send:${userId}:daily`;
    const reservation = await this.valkeyService.reserveSendSlot(
      cooldownKey,
      this.otpResendCooldownSeconds,
      [{ key: dailyKey, limit: this.emailDailySendLimit, ttlSeconds: 86400 }],
    );
    if (reservation === -1) {
      throw new HttpException(
        'Please wait before requesting another email verification OTP',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (reservation === -2) {
      throw new HttpException(
        'Daily email verification limit exceeded. Please try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const otp = generateSecureOtp();
    const hashedOtp = hashSecret(otp, AuthService.emailOtpContext(userId));

    const emailOtpKey = `auth:customer:email:${userId}`;
    await Promise.all([
      this.valkeyService.set(
        emailOtpKey,
        JSON.stringify({ email: normalizedEmail, hash: hashedOtp }),
        this.otpExpirySeconds,
      ),
      this.valkeyService.delete(`auth:customer:email:attempts:${userId}`),
    ]);

    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(
        `[AUTH][DEV] Customer Email OTP UserId: ${userId} Email: ${normalizedEmail} OTP: ${otp} Expires: 5 minutes`,
      );
    }

    return {
      success: true,
      message: 'Email verification OTP sent successfully',
    };
  }

  async customerVerifyEmailOtp(
    userId: string,
    dto: CustomerEmailVerifyOtpDto,
  ): Promise<{ success: boolean; message: string }> {
    const normalizedEmail = dto.email.toLowerCase().trim();
    const emailOtpKey = `auth:customer:email:${userId}`;
    const attemptsKey = `auth:customer:email:attempts:${userId}`;
    const cooldownKey = `auth:customer:email:cooldown:${userId}`;

    const [storedData, attemptsStr] = await Promise.all([
      this.valkeyService.get(emailOtpKey),
      this.valkeyService.get(attemptsKey),
    ]);
    if (!storedData) {
      throw new BadRequestException(
        'Invalid or expired email verification OTP',
      );
    }

    const currentAttempts = attemptsStr ? Number(attemptsStr) : 0;
    if (currentAttempts >= this.otpMaxVerifyAttempts) {
      await this.valkeyService.delete(emailOtpKey);
      throw new BadRequestException(
        'Maximum verification attempts exceeded. Please request a new OTP.',
      );
    }

    let parsed: { email: string; hash: string };
    try {
      parsed = JSON.parse(storedData);
    } catch {
      throw new BadRequestException(
        'Corrupted OTP state. Please request a new OTP.',
      );
    }

    if (parsed.email !== normalizedEmail) {
      throw new BadRequestException(
        'OTP was not requested for this email address',
      );
    }

    const isValid = await verifySecret(
      parsed.hash,
      dto.otp,
      AuthService.emailOtpContext(userId),
    );
    if (!isValid) {
      const attempts = await this.valkeyService.incr(attemptsKey);
      if (attempts === 1) {
        await this.valkeyService.expire(attemptsKey, this.otpExpirySeconds);
      }
      if (attempts >= this.otpMaxVerifyAttempts) {
        await this.valkeyService.delete(emailOtpKey);
        throw new BadRequestException(
          'Maximum verification attempts exceeded. Please request a new OTP.',
        );
      }
      const remaining = this.otpMaxVerifyAttempts - attempts;
      throw new BadRequestException(
        `Invalid OTP. Attempts remaining: ${remaining}`,
      );
    }

    const consumed = await this.valkeyService.compareAndDelete(
      emailOtpKey,
      storedData,
    );
    if (!consumed) {
      throw new BadRequestException(
        'Invalid or expired email verification OTP',
      );
    }

    try {
      await this.usersService.updateEmail(userId, normalizedEmail, true);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Email is already associated with another account',
        );
      }
      throw error;
    }

    await Promise.all([
      this.valkeyService.delete(attemptsKey),
      this.valkeyService.delete(cooldownKey),
    ]);

    return {
      success: true,
      message: 'Email verified successfully',
    };
  }
  // ==========================================
  // ADMIN AUTHENTICATION METHODS
  // ==========================================

  async adminLogin(dto: AdminLoginDto) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    const admin = await this.prisma.admin.findUnique({
      where: { email: normalizedEmail },
    });

    if (!admin) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!admin.isActive) {
      throw new UnauthorizedException('Admin account is inactive');
    }

    const isMatch = await verifyHash(admin.passwordHash, dto.password);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const sessionId = randomUUID();
    const sessionExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    const [refreshToken, accessToken] = await Promise.all([
      this.jwtService.signAsync(
        {
          sub: admin.id,
          role: 'ADMIN',
          sessionId,
          type: 'refresh',
        },
        {
          secret: this.refreshSecret,
          expiresIn: this.refreshExpiresIn as any,
        },
      ),
      this.jwtService.signAsync(
        {
          sub: admin.id,
          role: 'ADMIN',
          sessionId,
          type: 'access',
        },
        {
          secret: this.accessSecret,
          expiresIn: this.accessExpiresIn as any,
        },
      ),
    ]);

    const refreshTokenHash = hashSecret(
      refreshToken,
      AuthService.refreshTokenContext(sessionId),
    );

    await this.prisma.session.create({
      data: {
        id: sessionId,
        adminId: admin.id,
        refreshTokenHash,
        expiresAt: sessionExpiresAt,
      },
    });

    return {
      success: true,
      message: 'Authentication successful',
      accessToken,
      refreshToken,
      admin: {
        id: admin.id,
        email: admin.email,
        role: 'ADMIN',
      },
    };
  }

  async adminChangePassword(adminId: string, dto: AdminChangePasswordDto) {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
    });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    if (!admin.isActive) {
      throw new ForbiddenException('Admin account is inactive');
    }

    const isMatch = await verifyHash(admin.passwordHash, dto.currentPassword);
    if (!isMatch) {
      throw new BadRequestException('Incorrect current password');
    }

    const newPasswordHash = await hashValue(dto.newPassword);
    await this.prisma.admin.update({
      where: { id: admin.id },
      data: { passwordHash: newPasswordHash },
    });

    return {
      success: true,
      message: 'Password changed successfully',
    };
  }

  async adminGetMe(adminId: string) {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
    });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    if (!admin.isActive) {
      throw new ForbiddenException('Admin account is inactive');
    }

    return {
      id: admin.id,
      email: admin.email,
      role: 'ADMIN',
    };
  }

  async seedInitialAdmin(options?: {
    email?: string;
    password?: string;
  }): Promise<{ id: string; email: string; created: boolean }> {
    const email = (options?.email || 'admin@puretyfarm.in')
      .toLowerCase()
      .trim();
    const password = options?.password || 'puretyfarm@2026';

    const existing = await this.prisma.admin.findUnique({
      where: { email },
    });

    if (existing) {
      this.logger.log(`Initial admin already exists with ID: ${existing.id}`);
      return {
        id: existing.id,
        email: existing.email,
        created: false,
      };
    }

    const passwordHash = await hashValue(password);
    const admin = await this.prisma.admin.create({
      data: {
        email,
        passwordHash,
        isActive: true,
      },
    });

    this.logger.log(`Seeded initial admin with ID: ${admin.id}`);
    return {
      id: admin.id,
      email: admin.email,
      created: true,
    };
  }
}
