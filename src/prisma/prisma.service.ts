import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Interactive-transaction defaults. Prisma's out-of-the-box limits (2s to
    // acquire a slot, 5s to run) are too tight for the plan-purchase and
    // subscription-approval flows: each wraps a schedule reconcile plus the
    // creation of one priced Order (+ nested Invoice, with two sequence reads)
    // for every delivery in the window — dozens of sequential round-trips to a
    // pooled, network-hopped Postgres. Exceeding 5s closed the transaction
    // mid-flight and surfaced as Prisma P2028 ("Transaction not found ...
    // closed"). These wider limits give those batch writes room to finish;
    // per-transaction overrides can still tighten them where appropriate.
    super({
      transactionOptions: {
        maxWait: 10_000,
        timeout: 30_000,
      },
      // Opt-in query timing (PERF_TIMING=true). Emitted as events so only the
      // duration and the statement kind are logged — never query parameters.
      ...(process.env.PERF_TIMING === 'true'
        ? { log: [{ emit: 'event' as const, level: 'query' as const }] }
        : {}),
    });

    if (process.env.PERF_TIMING === 'true') {
      (
        this as unknown as {
          $on(event: 'query', cb: (e: Prisma.QueryEvent) => void): void;
        }
      ).$on('query', (e) => {
        this.logger.log(`db ${e.query.split(' ', 1)[0]} ${e.duration}ms`);
      });
    }
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Successfully connected to the database.');
    } catch (error) {
      this.logger.error('Failed to connect to the database', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Prisma client disconnected.');
  }
}
