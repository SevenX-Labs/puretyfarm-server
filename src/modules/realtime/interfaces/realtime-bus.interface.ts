import { CustomerEventType, AdminEventType } from '../constants/event-catalog';

export type RealtimeTargetType = 'customer' | 'admin' | 'broadcast_customers';

export interface RealtimeMessage {
  targetType: RealtimeTargetType;
  userId?: string;
  types: (CustomerEventType | AdminEventType)[];
  timestamp: number;
}

export interface RealtimeBus {
  publish(message: RealtimeMessage): Promise<void>;
  subscribe(handler: (message: RealtimeMessage) => void): () => void;
}
