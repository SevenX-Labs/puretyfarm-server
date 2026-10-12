import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InMemoryRealtimeBus } from './buses/in-memory-realtime-bus';
import { RealtimeEventsService } from './realtime-events.service';
import { CustomerEventsController } from './controllers/customer-events.controller';
import { AdminEventsController } from './controllers/admin-events.controller';

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [CustomerEventsController, AdminEventsController],
  providers: [
    InMemoryRealtimeBus,
    {
      provide: 'REALTIME_BUS',
      useExisting: InMemoryRealtimeBus,
    },
    RealtimeEventsService,
  ],
  exports: [RealtimeEventsService, 'REALTIME_BUS', InMemoryRealtimeBus],
})
export class RealtimeModule {}
