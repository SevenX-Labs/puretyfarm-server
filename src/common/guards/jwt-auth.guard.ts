import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector?: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (
      !authHeader ||
      typeof authHeader !== 'string' ||
      !authHeader.startsWith('Bearer ')
    ) {
      throw new UnauthorizedException('Authentication token is missing');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('Authentication token is missing');
    }

    const secret = this.configService.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      throw new UnauthorizedException('Authentication is not configured');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret,
      });
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired authentication token',
      );
    }

    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }

    if (!payload.sessionId) {
      throw new UnauthorizedException('Invalid session context');
    }

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sessionId },
    });

    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt < new Date()
    ) {
      throw new UnauthorizedException('Session has been revoked or expired');
    }

    // The session must belong to the subject the token claims to be.
    const sessionOwnerId =
      payload.role === 'ADMIN'
        ? (session.adminId ?? session.userId)
        : session.userId;

    if (!sessionOwnerId || sessionOwnerId !== payload.sub) {
      throw new UnauthorizedException('Session does not match token subject');
    }

    // Role-based access control. If @Roles(...) is declared, enforce it;
    // otherwise default to CUSTOMER for existing customer endpoints.
    const handler =
      typeof context.getHandler === 'function' ? context.getHandler() : null;
    const cls =
      typeof context.getClass === 'function' ? context.getClass() : null;

    const requiredRoles =
      handler && cls && this.reflector
        ? this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [handler, cls])
        : undefined;

    if (requiredRoles && requiredRoles.length > 0) {
      if (!requiredRoles.includes(payload.role)) {
        throw new ForbiddenException('Access denied for this role');
      }
    } else {
      if (payload.role !== 'CUSTOMER') {
        throw new ForbiddenException('Access denied for this role');
      }
    }

    request.user = payload;
    request.session = session;
    return true;
  }
}
