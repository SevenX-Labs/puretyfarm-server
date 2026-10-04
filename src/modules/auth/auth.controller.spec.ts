import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminLoginDto } from './dto/admin/login.dto';
import { AdminChangePasswordDto } from './dto/admin/change-password.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

jest.mock('@nestjs/jwt', () => ({
  JwtService: jest.fn().mockImplementation(() => ({
    signAsync: jest.fn(),
    verifyAsync: jest.fn(),
  })),
}));

describe('AuthController', () => {
  let controller: AuthController;

  const mockAuthService = {
    customerLogin: jest
      .fn()
      .mockResolvedValue({ success: true, message: 'OTP sent successfully' }),
    customerVerifyOtp: jest.fn().mockResolvedValue({
      success: true,
      message: 'Authentication successful',
      accessToken: 'acc-token',
      refreshToken: 'ref-token',
    }),
    customerRefreshToken: jest.fn().mockResolvedValue({
      success: true,
      accessToken: 'new-acc',
      refreshToken: 'new-ref',
    }),
    customerLogout: jest
      .fn()
      .mockResolvedValue({ success: true, message: 'Logged out successfully' }),
    customerGetMe: jest
      .fn()
      .mockResolvedValue({ id: 'user-1', mobile: '+919876543210' }),
    customerSendEmailOtp: jest
      .fn()
      .mockResolvedValue({ success: true, message: 'Email OTP sent' }),
    customerVerifyEmailOtp: jest
      .fn()
      .mockResolvedValue({ success: true, message: 'Email verified' }),
    adminLogin: jest.fn().mockResolvedValue({
      success: true,
      message: 'Authentication successful',
      accessToken: 'admin-acc-token',
      refreshToken: 'admin-ref-token',
      admin: {
        id: 'admin-1',
        email: 'admin@puretyfarm.com',
        role: 'ADMIN',
      },
    }),
    adminChangePassword: jest.fn().mockResolvedValue({
      success: true,
      message: 'Password changed successfully',
    }),
    adminGetMe: jest.fn().mockResolvedValue({
      id: 'admin-1',
      email: 'admin@puretyfarm.com',
      role: 'ADMIN',
    }),
  };

  const adminJwtUser = {
    sub: 'admin-1',
    role: 'ADMIN',
    sessionId: 'session-admin-1',
    type: 'access' as const,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: JwtService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: {} },
        JwtAuthGuard,
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ==========================================
  // CUSTOMER AUTH CONTROLLER TESTS
  // ==========================================

  it('should call customerLogin', async () => {
    const res = await controller.customerLogin({ mobile: '9876543210' });
    expect(res.success).toBe(true);
    expect(mockAuthService.customerLogin).toHaveBeenCalledWith({
      mobile: '9876543210',
    });
  });

  it('should call customerVerifyOtp', async () => {
    const res = await controller.customerVerifyOtp({
      mobile: '9876543210',
      otp: '123456',
    });
    expect(res.success).toBe(true);
    expect(mockAuthService.customerVerifyOtp).toHaveBeenCalledWith({
      mobile: '9876543210',
      otp: '123456',
    });
  });

  it('should call customerRefresh', async () => {
    const res = await controller.customerRefresh({ refreshToken: 'ref' });
    expect(res.accessToken).toBe('new-acc');
    expect(mockAuthService.customerRefreshToken).toHaveBeenCalledWith({
      refreshToken: 'ref',
    });
  });

  it('should call customerLogout', async () => {
    const user = {
      sub: 'u1',
      role: 'CUSTOMER',
      sessionId: 's1',
      type: 'access' as const,
    };
    const res = await controller.customerLogout(user);
    expect(res.success).toBe(true);
    expect(mockAuthService.customerLogout).toHaveBeenCalledWith('u1', 's1');
  });

  it('should call customerGetMe', async () => {
    const user = {
      sub: 'u1',
      role: 'CUSTOMER',
      sessionId: 's1',
      type: 'access' as const,
    };
    const res = await controller.customerGetMe(user);
    expect(res.id).toBe('user-1');
    expect(mockAuthService.customerGetMe).toHaveBeenCalledWith('u1');
  });

  it('should call customerEmailSendOtp', async () => {
    const user = {
      sub: 'u1',
      role: 'CUSTOMER',
      sessionId: 's1',
      type: 'access' as const,
    };
    const res = await controller.customerEmailSendOtp(user, {
      email: 't@e.com',
    });
    expect(res.success).toBe(true);
    expect(mockAuthService.customerSendEmailOtp).toHaveBeenCalledWith('u1', {
      email: 't@e.com',
    });
  });

  it('should call customerEmailVerifyOtp', async () => {
    const user = {
      sub: 'u1',
      role: 'CUSTOMER',
      sessionId: 's1',
      type: 'access' as const,
    };
    const res = await controller.customerEmailVerifyOtp(user, {
      email: 't@e.com',
      otp: '123456',
    });
    expect(res.success).toBe(true);
    expect(mockAuthService.customerVerifyEmailOtp).toHaveBeenCalledWith('u1', {
      email: 't@e.com',
      otp: '123456',
    });
  });

  // ==========================================
  // ADMIN AUTH CONTROLLER TESTS
  // ==========================================

  it('should call adminLogin', async () => {
    const dto: AdminLoginDto = {
      email: 'admin@puretyfarm.com',
      password: 'puretyfarm@2026',
    };
    const res = await controller.adminLogin(dto);
    expect(res.success).toBe(true);
    expect(res.accessToken).toBe('admin-acc-token');
    expect(mockAuthService.adminLogin).toHaveBeenCalledWith(dto);
  });

  it('should call adminChangePassword with user.sub from JWT', async () => {
    const dto: AdminChangePasswordDto = {
      currentPassword: 'old-password',
      newPassword: 'new-password-123',
    };
    const res = await controller.adminChangePassword(adminJwtUser, dto);
    expect(res.success).toBe(true);
    expect(mockAuthService.adminChangePassword).toHaveBeenCalledWith(
      'admin-1',
      dto,
    );
  });

  it('should call adminGetMe with user.sub from JWT', async () => {
    const res = await controller.adminGetMe(adminJwtUser);
    expect(res.id).toBe('admin-1');
    expect(res.role).toBe('ADMIN');
    expect(mockAuthService.adminGetMe).toHaveBeenCalledWith('admin-1');
  });

  // ==========================================
  // DTO VALIDATION TESTS
  // ==========================================

  describe('AdminLoginDto validation', () => {
    it('accepts valid credentials', async () => {
      const dto = plainToInstance(AdminLoginDto, {
        email: 'admin@puretyfarm.com',
        password: 'securePassword123',
      });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('rejects an invalid email format', async () => {
      const dto = plainToInstance(AdminLoginDto, {
        email: 'not-an-email',
        password: 'securePassword123',
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'email')).toBe(true);
    });

    it('rejects an empty password', async () => {
      const dto = plainToInstance(AdminLoginDto, {
        email: 'admin@puretyfarm.com',
        password: '',
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'password')).toBe(true);
    });
  });

  describe('AdminChangePasswordDto validation', () => {
    it('accepts valid passwords', async () => {
      const dto = plainToInstance(AdminChangePasswordDto, {
        currentPassword: 'currentPassword123',
        newPassword: 'newPassword1234',
      });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('rejects a new password shorter than 8 characters', async () => {
      const dto = plainToInstance(AdminChangePasswordDto, {
        currentPassword: 'currentPassword123',
        newPassword: 'short',
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'newPassword')).toBe(true);
    });

    it('rejects an empty current password', async () => {
      const dto = plainToInstance(AdminChangePasswordDto, {
        currentPassword: '',
        newPassword: 'newPassword1234',
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'currentPassword')).toBe(true);
    });
  });
});
