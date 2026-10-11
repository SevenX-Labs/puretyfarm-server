import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { requestTimingMiddleware } from './common/middleware/request-timing.middleware';

// How long (seconds) a browser may reuse a CORS preflight result. Without it
// browsers fall back to a few seconds, so cross-origin clients (the admin
// panel) pay an extra OPTIONS round-trip before almost every API call. Origin,
// method and header rules are unchanged; only the re-check interval is.
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

// http://localhost, http://127.0.0.1 and http://[::1], with or without a port.
const LOOPBACK_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Opt-in per-request timing (Server-Timing header + one log line). Off by
  // default; see request-timing.middleware.ts.
  if (process.env.PERF_TIMING === 'true') {
    app.use(requestTimingMiddleware);
  }

  const configService = app.get(ConfigService);
  const corsOriginRaw =
    configService.get<string>('CORS_ORIGIN') ||
    configService.get<string>('CORS_ORIGINS') ||
    process.env.CORS_ORIGIN ||
    process.env.CORS_ORIGINS;

  if (corsOriginRaw) {
    const rawOrigins = corsOriginRaw
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter((origin) => origin.length > 0);

    const isWildcard = rawOrigins.includes('*');

    // Build list of acceptable origins with protocols
    const normalizedOrigins = new Set<string>();
    for (const item of rawOrigins) {
      normalizedOrigins.add(item);
      if (!item.startsWith('http://') && !item.startsWith('https://')) {
        normalizedOrigins.add(`https://${item}`);
        normalizedOrigins.add(`http://${item}`);
      }
    }

    app.enableCors({
      origin: isWildcard
        ? true
        : (origin, callback) => {
            // Allow requests with no origin (e.g. mobile apps, curl, server-to-server, Postman)
            if (!origin) {
              return callback(null, true);
            }
            const cleanOrigin = origin.replace(/\/+$/, '');
            if (normalizedOrigins.has(cleanOrigin)) {
              return callback(null, true);
            }
            // Always allow loopback origins (any port) so local dev frontends
            // work without having to enumerate every port in CORS_ORIGIN.
            // Loopback can only be reached from the developer's own machine, so
            // this does not widen exposure to remote origins.
            if (LOOPBACK_ORIGIN.test(cleanOrigin)) {
              return callback(null, true);
            }
            return callback(
              new Error(`CORS error: Origin ${origin} not allowed by policy`),
            );
          },
      credentials: true,
      maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Accept',
        'Origin',
        'X-Requested-With',
        'Idempotency-Key',
        'idempotency-key',
      ],
    });
  } else {
    // If no CORS env variable is set, enable CORS for all origins with credentials
    app.enableCors({
      origin: true,
      credentials: true,
      maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Accept',
        'Origin',
        'X-Requested-With',
        'Idempotency-Key',
        'idempotency-key',
      ],
    });
  }

  app.useGlobalFilters(new PrismaExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await app.listen(port, '0.0.0.0');
}
bootstrap();
