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
    };
    controller = new OrderPaymentsController(mockPaymentsService);
  });

  describe('payOrder with WALLET', () => {
    it('calls payOrderFromWallet for wallet payments', async () => {
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
      );

      expect(mockPaymentsService.payOrderFromWallet).toHaveBeenCalledTimes(1);
      expect(mockPaymentsService.payOrderFromWallet).toHaveBeenCalledWith(
        'user-123',
        'order-1',
      );
      expect((result as any).paymentStatus).toBe('PAID');
    });
  });

  describe('payOrder with CASH', () => {
    it('throws BadRequestException and never calls wallet debit', async () => {
      await expect(
        controller.payOrder(
          mockUser,
          'order-1',
          { paymentMethod: OrderPaymentChoice.CASH },
        ),
      ).rejects.toThrow(BadRequestException);

      expect(mockPaymentsService.payOrderFromWallet).not.toHaveBeenCalled();
    });

    it('returns DIRECT_CASH_ORDER_PAYMENT_NOT_SUPPORTED error code', async () => {
      try {
        await controller.payOrder(
          mockUser,
          'order-1',
          { paymentMethod: OrderPaymentChoice.CASH },
        );
        fail('Expected BadRequestException');
      } catch (err: any) {
        expect(err.getResponse().error).toBe('DIRECT_CASH_ORDER_PAYMENT_NOT_SUPPORTED');
      }
    });
  });
});
