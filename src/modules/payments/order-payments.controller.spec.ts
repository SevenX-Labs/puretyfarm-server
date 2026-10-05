jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock('@nestjs/jwt', () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { BadRequestException } from '@nestjs/common';
import { OrderPaymentsController } from './order-payments.controller';
import { OrderPaymentChoice } from './dto/customer/pay-order.dto';

describe('OrderPaymentsController', () => {
  let controller: OrderPaymentsController;
  let mockPaymentsService: any;

  const mockUser = {
    sub: 'user-123',
    role: 'CUSTOMER',
  } as any;

  beforeEach(() => {
    mockPaymentsService = {
      payOrderFromWallet: jest.fn(),
      createOrderPayment: jest.fn(),
    };
    controller = new OrderPaymentsController(mockPaymentsService);
  });

  describe('payOrder with WALLET', () => {
    it('calls payOrderFromWallet without requiring an idempotency key', async () => {
      mockPaymentsService.payOrderFromWallet.mockResolvedValueOnce({
        success: true,
        orderId: 'order-1',
        paymentMethod: 'WALLET',
        paymentStatus: 'PAID',
        orderStatus: 'CONFIRMED',
      });

      const result = await controller.payOrder(
        mockUser,
        'order-1',
        { paymentMethod: OrderPaymentChoice.WALLET },
        undefined as any,
      );

      expect(mockPaymentsService.payOrderFromWallet).toHaveBeenCalledTimes(1);
      expect(mockPaymentsService.payOrderFromWallet).toHaveBeenCalledWith(
        'user-123',
        'order-1',
      );
      expect(result.paymentStatus).toBe('PAID');
    });
  });

  describe('payOrder with ONLINE', () => {
    it('throws BadRequestException if idempotency-key header is missing', async () => {
      await expect(
        controller.payOrder(
          mockUser,
          'order-1',
          { paymentMethod: OrderPaymentChoice.ONLINE },
          '',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockPaymentsService.createOrderPayment).not.toHaveBeenCalled();
    });

    it('calls createOrderPayment with validated idempotency key', async () => {
      mockPaymentsService.createOrderPayment.mockResolvedValueOnce({
        payment: { id: 'p-1', transactionId: 'PF123', amountPaise: 50000 },
        orderId: 'order-1',
        checkout: { endpoint: 'https://secure.payu.in/_payment', fields: {} },
      });

      const result = await controller.payOrder(
        mockUser,
        'order-1',
        { paymentMethod: OrderPaymentChoice.ONLINE },
        'idem-key-1',
      );

      expect(mockPaymentsService.createOrderPayment).toHaveBeenCalledTimes(1);
      expect(mockPaymentsService.createOrderPayment).toHaveBeenCalledWith(
        'user-123',
        'order-1',
        'idem-key-1',
      );
      expect(result.orderId).toBe('order-1');
    });
  });
});
