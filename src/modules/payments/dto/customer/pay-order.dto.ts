import { IsEnum } from 'class-validator';

export enum OrderPaymentChoice {
  WALLET = 'WALLET',
  CASH = 'CASH',
}

export class PayOrderDto {
  @IsEnum(OrderPaymentChoice, {
    message: `paymentMethod must be one of: ${Object.values(OrderPaymentChoice).join(', ')}`,
  })
  paymentMethod: OrderPaymentChoice;
}
