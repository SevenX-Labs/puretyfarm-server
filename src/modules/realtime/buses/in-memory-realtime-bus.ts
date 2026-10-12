import { Injectable, Logger } from '@nestjs/common';
import { RealtimeBus, RealtimeMessage } from '../interfaces/realtime-bus.interface';

@Injectable()
export class InMemoryRealtimeBus implements RealtimeBus {
  private readonly logger = new Logger(InMemoryRealtimeBus.name);
  private readonly handlers = new Set<(message: RealtimeMessage) => void>();

  async publish(message: RealtimeMessage): Promise<void> {
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch (err) {
        this.logger.error('Error in InMemoryRealtimeBus subscriber', err);
      }
    }
  }

  subscribe(handler: (message: RealtimeMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
