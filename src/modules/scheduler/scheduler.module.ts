import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PaymentExpiryJob } from './jobs/payment-expiry.job';
import { PaymentsModule } from '../payments/payments.module';

/**
 * Application-wide cron scheduler.
 *
 * `ScheduleModule.forRoot()` is initialised here, and ONLY here, to avoid
 * registering the cron discovery lifecycle twice. Each individual job is a
 * `@Injectable()` provider that owns one `@Cron(...)` method and delegates all
 * real work to the module that already owns that concern — the scheduler is
 * only an automatic timer.
 *
 * Future jobs (quote expiry, reconciliation, consistency checks) belong here
 * as additional providers in the same `providers` list. They are not
 * implemented in this change.
 */
@Module({
  imports: [ScheduleModule.forRoot(), PaymentsModule],
  providers: [PaymentExpiryJob],
})
export class SchedulerModule {}
