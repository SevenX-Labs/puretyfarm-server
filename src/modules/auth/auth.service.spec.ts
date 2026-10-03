import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { ValkeyService } from '../../valkey/valkey.service';
import { hashValue } from '../../common/utils/crypto.util';

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

describe('AuthService', () => {
  let service: AuthService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const config: Record<string, any> = {
        OTP_EXPIRY_SECONDS: 300,
        OTP_RESEND_COOLDOWN_SECONDS: 60,
        OTP_MAX_VERIFY_ATTEMPTS: 5,
        OTP_SEND_LIMIT: 5,
        OTP_SEND_WINDOW_SECONDS: 300,
        OTP_DAILY_SEND_LIMIT: 15,
        JWT_ACCESS_SECRET: 'test-access-secret',
        JWT_REFRESH_SECRET: 'test-refresh-secret',
        JWT_ACCESS_EXPIRES_IN: '30m',
        JWT_REFRESH_EXPIRES_IN: '90d',
      };
      return config[key];
    }),
  };

  const mockJwtService = {
    signAsync: jest.fn().mockImplementation((payload) => {
      return Promise.resolve(`mock-jwt-${payload.type}-${payload.sub}`);
    }),
    verifyAsync: jest.fn(),
  };

  const mockPrismaService = {
    session: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const mockUsersService = {
    findByMobile: jest.fn(),
    createCustomer: jest.fn(),
    findOrCreateByMobile: jest.fn(),
    findById: jest.fn(),
    findByEmail: jest.fn(),
    updateEmail: jest.fn(),
  };

  const valkeyStore = new Map<string, string>();
  const mockValkeyService = {
    get: jest
      .fn()
      .mockImplementation((key: string) =>
        Promise.resolve(valkeyStore.get(key) || null),
      ),
    set: jest.fn().mockImplementation((key: string, value: string) => {
      valkeyStore.set(key, value);
      return Promise.resolve('OK');
    }),
    delete: jest.fn().mockImplementation((key: string) => {
      const deleted = valkeyStore.delete(key);
      return Promise.resolve(deleted ? 1 : 0);
    }),
    incr: jest.fn().mockImplementation((key: string) => {
      const current = Number(valkeyStore.get(key) || '0') + 1;
      valkeyStore.set(key, String(current));
      return Promise.resolve(current);
    }),
    expire: jest.fn().mockResolvedValue(true),
    ttl: jest.fn().mockResolvedValue(300),
    // Simulates the atomic Lua reservation against the in-memory store.
    reserveSendSlot: jest
      .fn()
      .mockImplementation(
        (
          cooldownKey: string,
          _cooldownTtl: number,
          counters: Array<{ key: string; limit: number; ttlSeconds: number }>,
        ) => {
          if (valkeyStore.has(cooldownKey)) return Promise.resolve(-1);
          for (let i = 0; i < counters.length; i++) {
            const cur = Number(valkeyStore.get(counters[i].key) || '0');
            if (cur >= counters[i].limit) return Promise.resolve(-(i + 2));
          }
          for (const c of counters) {
            valkeyStore.set(
              c.key,
              String(Number(valkeyStore.get(c.key) || '0') + 1),
            );
          }
          valkeyStore.set(cooldownKey, '1');
          return Promise.resolve(0);
        },
      ),
    // Simulates atomic compare-and-delete against the in-memory store.
    compareAndDelete: jest
      .fn()
      .mockImplementation((key: string, expected: string) => {
        if (valkeyStore.get(key) === expected) {
          valkeyStore.delete(key);
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      }),
  };

  beforeEach(async () => {
    valkeyStore.clear();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: UsersService, useValue: mockUsersService },
        { provide: ValkeyService, useValue: mockValkeyService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('customerLogin', () => {
    it('should generate secure OTP, hash with Argon2, store in Valkey, and set cooldown', async () => {
      const result = await service.customerLogin({ mobile: '9876543210' });

      expect(result.success).toBe(true);
      expect(result.message).toBe('OTP sent successfully');

      // Stored OTP hash in Valkey
      const otpHash = valkeyStore.get('auth:customer:otp:+919876543210');
      expect(otpHash).toBeDefined();
      expect(otpHash).toContain('$argon2');

      // Cooldown set
      expect(valkeyStore.get('auth:customer:otp:cooldown:+919876543210')).toBe(
        '1',
      );
    });

    it('should reject when in resend cooldown (429)', async () => {
      valkeyStore.set('auth:customer:otp:cooldown:+919876543210', '1');

      await expect(
        service.customerLogin({ mobile: '9876543210' }),
      ).rejects.toThrow(HttpException);
    });

    it('should reject when 5-minute send limit reached (429)', async () => {
      valkeyStore.set('auth:customer:otp:send:+919876543210:5m', '5');

      await expect(
        service.customerLogin({ mobile: '9876543210' }),
      ).rejects.toThrow(HttpException);
    });

    it('should reject when daily send limit reached (429)', async () => {
      valkeyStore.set('auth:customer:otp:send:+919876543210:daily', '15');

      await expect(
        service.customerLogin({ mobile: '9876543210' }),
      ).rejects.toThrow(HttpException);
    });

    it('should reserve the send slot with the exact preserved limits (5/5min, 15/day, 60s cooldown)', async () => {
      await service.customerLogin({ mobile: '9876543210' });

      expect(mockValkeyService.reserveSendSlot).toHaveBeenCalledWith(
        'auth:customer:otp:cooldown:+919876543210',
        60,
        [
          {
            key: 'auth:customer:otp:send:+919876543210:5m',
            limit: 5,
            ttlSeconds: 300,
          },
          {
            key: 'auth:customer:otp:send:+919876543210:daily',
            limit: 15,
            ttlSeconds: 86400,
          },
        ],
      );
    });

    it('should block a second immediate send via the armed cooldown', async () => {
      await service.customerLogin({ mobile: '9876543210' });
      // Cooldown is now set by the first reservation.
      await expect(
        service.customerLogin({ mobile: '9876543210' }),
      ).rejects.toThrow(HttpException);
    });
  });

  describe('customerVerifyOtp', () => {
    it('should verify OTP, create customer if not found, create session, and issue tokens', async () => {
      const plainOtp = '123456';
      const hash = await hashValue(plainOtp);
      valkeyStore.set('auth:customer:otp:+919876543210', hash);

      mockUsersService.findOrCreateByMobile.mockResolvedValue({
        id: 'user-123',
        mobile: '+919876543210',
        role: 'CUSTOMER',
        email: null,
        emailVerified: false,
      });

      mockPrismaService.session.create.mockResolvedValue({
        id: 'session-123',
        userId: 'user-123',
      });

      const response = await service.customerVerifyOtp({
        mobile: '9876543210',
        otp: plainOtp,
      });

      expect(response.success).toBe(true);
      expect(response.accessToken).toBeDefined();
      expect(response.refreshToken).toBeDefined();
      expect(response.user.id).toBe('user-123');

      // OTP must be single-use: deleted from Valkey
      expect(valkeyStore.has('auth:customer:otp:+919876543210')).toBe(false);
    });

    it('should use existing customer on login without creating duplicate', async () => {
      const plainOtp = '654321';
      const hash = await hashValue(plainOtp);
      valkeyStore.set('auth:customer:otp:+919876543210', hash);

      const existingUser = {
        id: 'existing-user-1',
        mobile: '+919876543210',
        role: 'CUSTOMER',
        email: 'test@example.com',
        emailVerified: true,
      };
      mockUsersService.findOrCreateByMobile.mockResolvedValue(existingUser);
      mockPrismaService.session.create.mockResolvedValue({ id: 'sess-1' });

      const response = await service.customerVerifyOtp({
        mobile: '+919876543210',
        otp: plainOtp,
      });

      expect(response.user.id).toBe('existing-user-1');
      expect(mockUsersService.findOrCreateByMobile).toHaveBeenCalledWith(
        '+919876543210',
      );
    });

    it('should throw BadRequestException if OTP expired or not found', async () => {
      await expect(
        service.customerVerifyOtp({ mobile: '9876543210', otp: '111111' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should increment attempt counter on invalid OTP and reject after 5 failed attempts', async () => {
      const plainOtp = '123456';
      const hash = await hashValue(plainOtp);
      valkeyStore.set('auth:customer:otp:+919876543210', hash);

      // Attempt 1 to 4: throws Invalid OTP with remaining attempts
      await expect(
        service.customerVerifyOtp({ mobile: '9876543210', otp: '000000' }),
      ).rejects.toThrow(/Invalid OTP/);
      expect(valkeyStore.get('auth:customer:otp:attempts:+919876543210')).toBe(
        '1',
      );

      // Set attempts to 4, next attempt is 5th failure -> invalidates OTP
      valkeyStore.set('auth:customer:otp:attempts:+919876543210', '4');
      await expect(
        service.customerVerifyOtp({ mobile: '9876543210', otp: '000000' }),
      ).rejects.toThrow(/Maximum verification attempts exceeded/);

      // OTP was invalidated
      expect(valkeyStore.has('auth:customer:otp:+919876543210')).toBe(false);
    });

    it('should allow only ONE of two concurrent correct verifications (single-use race)', async () => {
      const plainOtp = '424242';
      const hash = await hashValue(plainOtp);
      valkeyStore.set('auth:customer:otp:+919876543210', hash);

      mockUsersService.findOrCreateByMobile.mockResolvedValue({
        id: 'user-x',
        mobile: '+919876543210',
        role: 'CUSTOMER',
        email: null,
        emailVerified: false,
      });
      mockPrismaService.session.create.mockResolvedValue({ id: 'sess-x' });

      const results = await Promise.allSettled([
        service.customerVerifyOtp({ mobile: '9876543210', otp: plainOtp }),
        service.customerVerifyOtp({ mobile: '9876543210', otp: plainOtp }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // Only one session should have been created.
      expect(mockPrismaService.session.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('customerRefreshToken', () => {
    it('should rotate refresh token and issue new access token', async () => {
      const oldRefreshToken = 'valid-refresh-token';
      const oldHash = await hashValue(oldRefreshToken);

      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        sessionId: 'sess-1',
        type: 'refresh',
      });

      mockPrismaService.session.findUnique.mockResolvedValue({
        id: 'sess-1',
        userId: 'user-1',
        refreshTokenHash: oldHash,
        expiresAt: new Date(Date.now() + 1000000),
        revokedAt: null,
        user: { role: 'CUSTOMER' },
      });
      mockPrismaService.session.updateMany.mockResolvedValue({ count: 1 });

      const response = await service.customerRefreshToken({
        refreshToken: oldRefreshToken,
      });

      expect(response.success).toBe(true);
      expect(response.accessToken).toBeDefined();
      expect(response.refreshToken).toBeDefined();
      expect(mockPrismaService.session.updateMany).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException if session is revoked', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        sessionId: 'sess-1',
        type: 'refresh',
      });

      mockPrismaService.session.findUnique.mockResolvedValue({
        id: 'sess-1',
        userId: 'user-1',
        refreshTokenHash: 'hash',
        expiresAt: new Date(Date.now() + 1000000),
        revokedAt: new Date(), // revoked!
      });

      await expect(
        service.customerRefreshToken({ refreshToken: 'some-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject a replayed/concurrently-rotated refresh token (CAS update matched no row)', async () => {
      const oldRefreshToken = 'rotate-once-token';
      const oldHash = await hashValue(oldRefreshToken);

      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        sessionId: 'sess-1',
        type: 'refresh',
      });
      mockPrismaService.session.findUnique.mockResolvedValue({
        id: 'sess-1',
        userId: 'user-1',
        refreshTokenHash: oldHash,
        expiresAt: new Date(Date.now() + 1000000),
        revokedAt: null,
        user: { role: 'CUSTOMER' },
      });
      // Simulate the row already having been rotated by a concurrent request:
      // the conditional update matches zero rows.
      mockPrismaService.session.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.customerRefreshToken({ refreshToken: oldRefreshToken }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject a refresh token whose stored hash does not match', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        sessionId: 'sess-1',
        type: 'refresh',
      });
      mockPrismaService.session.findUnique.mockResolvedValue({
        id: 'sess-1',
        userId: 'user-1',
        refreshTokenHash: await hashValue('a-different-token'),
        expiresAt: new Date(Date.now() + 1000000),
        revokedAt: null,
        user: { role: 'CUSTOMER' },
      });

      await expect(
        service.customerRefreshToken({ refreshToken: 'wrong-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject a non-refresh token type', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        sessionId: 'sess-1',
        type: 'access',
      });

      await expect(
        service.customerRefreshToken({ refreshToken: 'access-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('customerLogout', () => {
    it('should revoke only the current session scoped to the user', async () => {
      mockPrismaService.session.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.customerLogout('user-123', 'session-123');
      expect(result.success).toBe(true);
      expect(mockPrismaService.session.updateMany).toHaveBeenCalledWith({
        where: { id: 'session-123', userId: 'user-123', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe('customerGetMe', () => {
    it('should return customer account details from users service', async () => {
      const user = {
        id: 'user-123',
        mobile: '+919876543210',
        email: 'test@example.com',
        emailVerified: true,
        role: 'CUSTOMER',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockUsersService.findById.mockResolvedValue(user);

      const result = await service.customerGetMe('user-123');
      expect(result.id).toBe('user-123');
      expect(result.mobile).toBe('+919876543210');
      expect(result.emailVerified).toBe(true);
    });
  });

  describe('customerSendEmailOtp & customerVerifyEmailOtp', () => {
    it('should send email OTP bound to userId and email, and verify successfully', async () => {
      mockUsersService.findByEmail.mockResolvedValue(null);

      const sendRes = await service.customerSendEmailOtp('user-1', {
        email: 'cust@example.com',
      });
      expect(sendRes.success).toBe(true);

      const stateRaw = valkeyStore.get('auth:customer:email:user-1');
      expect(stateRaw).toBeDefined();
      const parsed = JSON.parse(stateRaw!);
      expect(parsed.email).toBe('cust@example.com');

      // Now verify with OTP
      const plainOtp = '999999';
      parsed.hash = await hashValue(plainOtp);
      valkeyStore.set('auth:customer:email:user-1', JSON.stringify(parsed));

      mockUsersService.updateEmail.mockResolvedValue({});

      const verifyRes = await service.customerVerifyEmailOtp('user-1', {
        email: 'cust@example.com',
        otp: plainOtp,
      });

      expect(verifyRes.success).toBe(true);
      expect(mockUsersService.updateEmail).toHaveBeenCalledWith(
        'user-1',
        'cust@example.com',
        true,
      );
      expect(valkeyStore.has('auth:customer:email:user-1')).toBe(false);
    });

    it('should reject email OTP if email is already associated with another user', async () => {
      mockUsersService.findByEmail.mockResolvedValue({ id: 'other-user' });

      await expect(
        service.customerSendEmailOtp('user-1', { email: 'taken@example.com' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject verification if OTP was generated for email A but submitted for email B', async () => {
      const hash = await hashValue('123456');
      valkeyStore.set(
        'auth:customer:email:user-1',
        JSON.stringify({ email: 'a@example.com', hash }),
      );

      await expect(
        service.customerVerifyEmailOtp('user-1', {
          email: 'b@example.com',
          otp: '123456',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should enforce the email send cooldown + daily cap atomically', async () => {
      mockUsersService.findByEmail.mockResolvedValue(null);

      await service.customerSendEmailOtp('user-1', {
        email: 'cust@example.com',
      });

      expect(mockValkeyService.reserveSendSlot).toHaveBeenCalledWith(
        'auth:customer:email:cooldown:user-1',
        60,
        [
          {
            key: 'auth:customer:email:send:user-1:daily',
            limit: 10,
            ttlSeconds: 86400,
          },
        ],
      );

      // Second immediate send is blocked by the armed cooldown.
      await expect(
        service.customerSendEmailOtp('user-1', { email: 'cust@example.com' }),
      ).rejects.toThrow(HttpException);
    });

    it('should allow only ONE of two concurrent email verifications (single-use race)', async () => {
      const plainOtp = '777777';
      const hash = await hashValue(plainOtp);
      valkeyStore.set(
        'auth:customer:email:user-1',
        JSON.stringify({ email: 'cust@example.com', hash }),
      );
      mockUsersService.findByEmail.mockResolvedValue(null);
      mockUsersService.updateEmail.mockResolvedValue({});

      const results = await Promise.allSettled([
        service.customerVerifyEmailOtp('user-1', {
          email: 'cust@example.com',
          otp: plainOtp,
        }),
        service.customerVerifyEmailOtp('user-1', {
          email: 'cust@example.com',
          otp: plainOtp,
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(mockUsersService.updateEmail).toHaveBeenCalledTimes(1);
    });
  });
});
