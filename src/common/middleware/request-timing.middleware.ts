import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('RequestTiming');

/**
 * Opt-in request timing (enabled with PERF_TIMING=true). Adds an
 * `X-Request-Id` and a `Server-Timing: app;dur=<ms>` response header and logs
 * one line per request. Only the method, the path without its query string,
 * the status and the duration are logged — never headers, bodies or user ids.
 */
export function requestTimingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startedAt = process.hrtime.bigint();
  const requestId = randomUUID();
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;

  res.setHeader('X-Request-Id', requestId);

  // Headers are flushed on the first writeHead, so that is the last moment the
  // duration can still be attached to the response.
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
  res.writeHead = ((...args: unknown[]) => {
    if (!res.headersSent) {
      res.setHeader('Server-Timing', `app;dur=${elapsedMs().toFixed(1)}`);
    }
    return writeHead(...args);
  }) as typeof res.writeHead;

  res.on('finish', () => {
    logger.log(
      `${requestId} ${req.method} ${req.path} ${res.statusCode} ${elapsedMs().toFixed(1)}ms`,
    );
  });

  next();
}
