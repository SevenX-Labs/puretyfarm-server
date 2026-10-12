export const CUSTOMER_EVENT_TYPES = [
  'wallet.updated',
  'orders.updated',
  'plan.updated',
  'plans.catalog.updated',
] as const;

export type CustomerEventType = (typeof CUSTOMER_EVENT_TYPES)[number];

export const ADMIN_EVENT_TYPES = [
  'admin.wallets.updated',
  'admin.payments.updated',
  'admin.orders.updated',
  'admin.deliveries.updated',
  'admin.plans.updated',
  'admin.customers.updated',
  'admin.dashboard.updated',
] as const;

export type AdminEventType = (typeof ADMIN_EVENT_TYPES)[number];

export type RealtimeEventType = CustomerEventType | AdminEventType;

export interface RealtimePayload {
  v: 1;
  types: RealtimeEventType[];
  ts: number;
}
