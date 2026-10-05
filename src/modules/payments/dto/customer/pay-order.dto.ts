import { IsEnum } from 'class-validator';

/**
 * The customer chooses how to pay for an already-created order. The amount
 * and the order id are NEVER accepted from the request — amount comes from
 * `Order.totalPaise` in the DB, and the order id comes from the route param.
 *
 * The vocabulary here is PAYMENT CHOICE, not the Prisma `PaymentMethod` enum:
 * cash is intentionally absent (no COD) and we expose only the two valid
 * options.
 *
 * `forbidNonWhitelisted: true` is applied on the route handler so a client
 * that tries to inject `userId`, `amount`, `orderId`, `paymentStatus`,
 * `orderStatus` or `transactionId` gets a 400 — stronger than the project-wide
 * `whitelist: true` (which silently strips).
 */
export enum OrderPaymentChoice {
  WALLET = 'WALLET',
  ONLINE = 'ONLINE',
}

export class PayOrderDto {
  @IsEnum(OrderPaymentChoice, {
    message: `paymentMethod must be one of: ${Object.values(OrderPaymentChoice).join(', ')}`,
  })
  paymentMethod: OrderPaymentChoice;
}
