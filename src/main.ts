import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
            return callback(
              new Error(`CORS error: Origin ${origin} not allowed by policy`),
            );
          },
      credentials: true,
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
