import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

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
});
