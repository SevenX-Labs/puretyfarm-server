import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { PrismaService } from '../../prisma/prisma.service';

jest.mock('@nestjs/jwt', () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  const jwt = { verifyAsync: jest.fn() };
  const config = { get: jest.fn() };
  const prisma = { session: { findUnique: jest.fn() } };
  const reflector = { getAllAndOverride: jest.fn() };

  const makeContext = (authorization?: string): ExecutionContext => {
    const req: any = { headers: authorization ? { authorization } : {} };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation((key: string) =>
      key === 'JWT_ACCESS_SECRET' ? 'test-access-secret' : undefined,
    );
    guard = new JwtAuthGuard(
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      prisma as unknown as PrismaService,
      reflector as unknown as Reflector,
    );
  });

  const validSession = {
    id: 'sess-1',
    userId: 'user-1',
    adminId: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 1_000_000),
  };

  const validAdminSession = {
    id: 'sess-admin-1',
    userId: null,
    adminId: 'admin-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 1_000_000),
  };

  it('rejects a missing/invalid Authorization header', async () => {
    await expect(guard.canActivate(makeContext())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token that fails signature verification', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('bad sig'));
    await expect(guard.canActivate(makeContext('Bearer tok'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a non-access token type', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      role: 'CUSTOMER',
      sessionId: 'sess-1',
      type: 'refresh',
    });
    await expect(guard.canActivate(makeContext('Bearer tok'))).rejects.toThrow(
      'Invalid token type',
    );
  });

  it('rejects when the session is revoked', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      role: 'CUSTOMER',
      sessionId: 'sess-1',
      type: 'access',
    });
    prisma.session.findUnique.mockResolvedValue({
      ...validSession,
      revokedAt: new Date(),
    });
    await expect(guard.canActivate(makeContext('Bearer tok'))).rejects.toThrow(
      'Session has been revoked or expired',
    );
  });

  it('rejects when the session belongs to a different user than the token subject', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-2', // mismatch
      role: 'CUSTOMER',
      sessionId: 'sess-1',
      type: 'access',
    });
    prisma.session.findUnique.mockResolvedValue(validSession);
    await expect(guard.canActivate(makeContext('Bearer tok'))).rejects.toThrow(
      'Session does not match token subject',
    );
  });

  it('rejects a non-CUSTOMER role with ForbiddenException when no role decorator is present', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      role: 'ADMIN',
      sessionId: 'sess-1',
      type: 'access',
    });
    prisma.session.findUnique.mockResolvedValue(validSession);
    await expect(guard.canActivate(makeContext('Bearer tok'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows a valid CUSTOMER access token and attaches user + session', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const payload = {
      sub: 'user-1',
      role: 'CUSTOMER',
      sessionId: 'sess-1',
      type: 'access',
    };
    jwt.verifyAsync.mockResolvedValue(payload);
    prisma.session.findUnique.mockResolvedValue(validSession);

    const req: any = { headers: { authorization: 'Bearer tok' } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual(payload);
    expect(req.session).toEqual(validSession);
  });

  it('allows a valid ADMIN access token when @Roles("ADMIN") is specified', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    const payload = {
      sub: 'admin-1',
      role: 'ADMIN',
      sessionId: 'sess-admin-1',
      type: 'access',
    };
    jwt.verifyAsync.mockResolvedValue(payload);
    prisma.session.findUnique.mockResolvedValue(validAdminSession);

    const req: any = { headers: { authorization: 'Bearer tok' } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual(payload);
    expect(req.session).toEqual(validAdminSession);
  });

  it('rejects a CUSTOMER access token when @Roles("ADMIN") is specified', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    const payload = {
      sub: 'user-1',
      role: 'CUSTOMER',
      sessionId: 'sess-1',
      type: 'access',
    };
    jwt.verifyAsync.mockResolvedValue(payload);
    prisma.session.findUnique.mockResolvedValue(validSession);

    await expect(guard.canActivate(makeContext('Bearer tok'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects when the access secret is not configured', async () => {
    config.get.mockReturnValue(undefined);
    await expect(guard.canActivate(makeContext('Bearer tok'))).rejects.toThrow(
      'Authentication is not configured',
    );
  });
});
