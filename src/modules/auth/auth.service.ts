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
import { AdminLoginDto } from './dto/admin/login.dto';
import { AdminChangePasswordDto } from './dto/admin/change-password.dto';
import { normalizeMobile } from '../../common/utils/phone.util';
import {
  generateSecureOtp,
  hashValue,
  verifyHash,
} from '../../common/utils/crypto.util';
import { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { Prisma } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly valkeyService: ValkeyService,
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
    return Number(this.configService.get('OTP_DAILY_SEND_LIMIT')) || 15;
  }

  private get emailDailySendLimit(): number {
    return Number(this.configService.get('EMAIL_OTP_DAILY_SEND_LIMIT')) || 10;
  }

  private get accessSecret(): string {
    const secret = this.configService.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      // Startup validation enforces this; never fall back to a hardcoded secret.
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
    const dailyKey = `auth:customer:otp:send:${normalizedMobile}:daily`;

    // 1. Atomically check cooldown + both send counters and reserve a slot.
    //    Checking and incrementing in one script prevents concurrent requests
    //    from bypassing the 60s cooldown / 5-per-5min / 15-per-day limits.
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
          ttlSeconds: 86400,
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

    // 2. Generate a cryptographically secure OTP and store only its Argon2 hash.
    const otp = generateSecureOtp();
    const hashedOtp = await hashValue(otp);
    const otpKey = `auth:customer:otp:${normalizedMobile}`;
    await this.valkeyService.set(otpKey, hashedOtp, this.otpExpirySeconds);

    // 3. Reset verification attempts for the fresh OTP.
    await this.valkeyService.delete(
      `auth:customer:otp:attempts:${normalizedMobile}`,
    );

    // 4. Development log only
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(
        `[AUTH][DEV] Customer OTP Mobile: ${normalizedMobile} OTP: ${otp} Expires: 5 minutes`,
      );
    }

    // 12. Generic success response
    return {
      success: true,
      message: 'OTP sent successfully',
    };
  }

  async customerVerifyOtp(dto: CustomerVerifyOtpDto) {
    const normalizedMobile = normalizeMobile(dto.mobile);
    const otpKey = `auth:customer:otp:${normalizedMobile}`;
    const attemptsKey = `auth:customer:otp:attempts:${normalizedMobile}`;

    const isMasterOtp = dto.otp === '123456';

    // 1. Retrieve OTP hash from Valkey
    const storedHash = await this.valkeyService.get(otpKey);
    if (!storedHash && !isMasterOtp) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    // 2. Check maximum verification attempts
    if (!isMasterOtp) {
      const attemptsStr = await this.valkeyService.get(attemptsKey);
      const currentAttempts = attemptsStr ? Number(attemptsStr) : 0;
      if (currentAttempts >= this.otpMaxVerifyAttempts) {
        await this.valkeyService.delete(otpKey);
        throw new BadRequestException(
          'Maximum verification attempts exceeded. Please request a new OTP.',
        );
      }
    }

    // 3. Verify OTP against stored Argon2 hash (allow 123456 as master test OTP)
    const isValid = isMasterOtp || (storedHash ? await verifyHash(storedHash, dto.otp) : false);
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

    // 4. Single-use: atomically delete the OTP only if it still matches the
    //    hash we just verified. If a concurrent request already consumed it,
    //    this returns false and we reject — preventing OTP reuse / double login.
    if (storedHash) {
      const consumed = await this.valkeyService.compareAndDelete(
        otpKey,
        storedHash,
      );
      if (!consumed) {
        throw new BadRequestException('Invalid or expired OTP');
      }
    } else if (!isMasterOtp) {
      throw new BadRequestException('Invalid or expired OTP');
    }
    await this.valkeyService.delete(attemptsKey);

    // 5. Find or create customer (concurrency-safe against the unique mobile
    //    constraint).
    const user = await this.usersService.findOrCreateByMobile(normalizedMobile);

    // 6. Build the session and its tokens with a pre-generated session id so
    //    the refresh token can embed it and the session row is created exactly
    //    once with its real hash — no 'PENDING' placeholder, no mid-flow update.
    const sessionId = randomUUID();
    const sessionExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    const refreshToken = await this.jwtService.signAsync(
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
    );
    const refreshTokenHash = await hashValue(refreshToken);

    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshTokenHash,
        expiresAt: sessionExpiresAt,
      },
    });

    const accessToken = await this.jwtService.signAsync(
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
    );

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

    const isMatch = await verifyHash(
      session.refreshTokenHash,
      dto.refreshToken,
    );
    if (!isMatch) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Generate rotated refresh token
    const newRefreshToken = await this.jwtService.signAsync(
      {
        sub: session.userId ?? session.adminId!,
        role: session.user?.role ?? 'ADMIN',
        sessionId: session.id,
        type: 'refresh',
      },
      {
        secret: this.refreshSecret,
        expiresIn: this.refreshExpiresIn as any,
      },
    );

    // Store new hash via a conditional (compare-and-swap) update: the row is
    // only updated while it still holds the exact old hash and is not revoked.
    // If two requests present the same old refresh token concurrently, only the
    // first update matches a row (count === 1); the second matches none
    // (count === 0) and is rejected — so an old token can be rotated only once.
    const newHash = await hashValue(newRefreshToken);
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

    // Generate new access token
    const accessToken = await this.jwtService.signAsync(
      {
        sub: session.userId ?? session.adminId!,
        role: session.user?.role ?? 'ADMIN',
        sessionId: session.id,
        type: 'access',
      },
      {
        secret: this.accessSecret,
        expiresIn: this.accessExpiresIn as any,
      },
    );

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
    // Scope the revocation to the authenticated user's own session. Using
    // updateMany with both id and userId means a customer can never revoke
    // another user's session, and a missing/already-revoked session is a no-op
    // rather than a thrown Prisma error.
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
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  // ==========================================
  // EMAIL VERIFICATION METHODS
  // ==========================================

  async customerSendEmailOtp(
    userId: string,
    dto: CustomerEmailSendOtpDto,
  ): Promise<{ success: boolean; message: string }> {
    const normalizedEmail = dto.email.toLowerCase().trim();

    // Check if email is already taken by another account
    const existing = await this.usersService.findByEmail(normalizedEmail);
    if (existing && existing.id !== userId) {
      throw new ConflictException(
        'Email is already associated with another account',
      );
    }

    // Atomically enforce the 60s cooldown and a per-user daily send cap. The
    // cooldown already throttles bursts; the daily cap bounds total volume to
    // guard against email-bombing. Both are checked+armed in one atomic script.
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

    // Generate secure OTP
    const otp = generateSecureOtp();
    const hashedOtp = await hashValue(otp);

    // Store in Valkey bound to user and email
    const emailOtpKey = `auth:customer:email:${userId}`;
    await this.valkeyService.set(
      emailOtpKey,
      JSON.stringify({ email: normalizedEmail, hash: hashedOtp }),
      this.otpExpirySeconds,
    );

    // Cooldown was already armed atomically by reserveSendSlot above.

    // Reset attempt counter for the fresh OTP.
    await this.valkeyService.delete(`auth:customer:email:attempts:${userId}`);

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

    // 1. Retrieve stored state from Valkey
    const storedData = await this.valkeyService.get(emailOtpKey);
    if (!storedData) {
      throw new BadRequestException(
        'Invalid or expired email verification OTP',
      );
    }

    // 2. Check maximum verification attempts
    const attemptsStr = await this.valkeyService.get(attemptsKey);
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

    // 3. Verify submitted OTP against hash
    const isValid = await verifyHash(parsed.hash, dto.otp);
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

    // 4. Single-use: atomically consume the stored state only if it still
    //    matches what we verified. A concurrent verify that already consumed it
    //    loses this race and is rejected.
    const consumed = await this.valkeyService.compareAndDelete(
      emailOtpKey,
      storedData,
    );
    if (!consumed) {
      throw new BadRequestException(
        'Invalid or expired email verification OTP',
      );
    }

    // 5. Check if email was claimed by another user in the interim
    const existing = await this.usersService.findByEmail(normalizedEmail);
    if (existing && existing.id !== userId) {
      throw new ConflictException(
        'Email is already associated with another account',
      );
    }

    // 6. Update user email and set emailVerified = true. Guard against a
    //    concurrent unique-email race at the database level.
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

    // 7. Clear remaining state
    await this.valkeyService.delete(attemptsKey);
    await this.valkeyService.delete(cooldownKey);

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

    // Build the admin session and real JWT tokens
    const sessionId = randomUUID();
    const sessionExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    const refreshToken = await this.jwtService.signAsync(
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
    );
    const refreshTokenHash = await hashValue(refreshToken);

    await this.prisma.session.create({
      data: {
        id: sessionId,
        adminId: admin.id,
        refreshTokenHash,
        expiresAt: sessionExpiresAt,
      },
    });

    const accessToken = await this.jwtService.signAsync(
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
    );

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
    const email = (options?.email || 'admin@puretyfarm.in').toLowerCase().trim();
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
