jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

import { WalletService } from '../wallet/wallet.service';
import { OrdersService } from '../orders/orders.service';
import { RealtimeEventsService } from './realtime-events.service';

describe('Publish-After-Commit Invariants', () => {
  let mockPrisma: any;
  let mockConfig: any;
  let mockRealtimeService: jest.Mocked<RealtimeEventsService>;

  beforeEach(() => {
    mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'WALLET_CREDIT_MIN_PAISE') return '100';
        if (key === 'WALLET_CREDIT_MAX_PAISE') return '500000';
        return undefined;
      }),
    };

    mockRealtimeService = {
      publishToCustomer: jest.fn(),
      publishToAdmins: jest.fn(),
      broadcastToCustomers: jest.fn(),
    } as any;
  });

  describe('WalletService publish-after-commit', () => {
    it('when prisma transaction rejects, publish is NOT called', async () => {
      mockPrisma = {
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }) },
        $transaction: jest.fn().mockRejectedValue(new Error('Transaction rolled back')),
      };

      const walletService = new WalletService(mockPrisma, mockConfig, mockRealtimeService);

      await expect(
        walletService.adminManualCredit('user-1', 'admin-1', {
          amount: 5000,
          remark: 'Manual adjustment',
        }),
      ).rejects.toThrow('Transaction rolled back');

      expect(mockRealtimeService.publishToCustomer).not.toHaveBeenCalled();
      expect(mockRealtimeService.publishToAdmins).not.toHaveBeenCalled();
    });

    it('when transaction succeeds, publish is called exactly once AFTER commit', async () => {
      mockPrisma = {
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }) },
        $transaction: jest.fn().mockImplementation(async (cb) => {
          return {
            success: true,
            walletId: 'w-1',
            balanceAfterPaise: 5000,
            transactionId: 'tx-1',
          };
        }),
      };

      const walletService = new WalletService(mockPrisma, mockConfig, mockRealtimeService);

      const res = await walletService.adminManualCredit('user-1', 'admin-1', {
        amount: 5000,
        remark: 'Manual adjustment',
      });

      expect(res.success).toBe(true);
      expect(mockRealtimeService.publishToCustomer).toHaveBeenCalledTimes(1);
      expect(mockRealtimeService.publishToCustomer).toHaveBeenCalledWith('user-1', ['wallet.updated']);
      expect(mockRealtimeService.publishToAdmins).toHaveBeenCalledTimes(1);
      expect(mockRealtimeService.publishToAdmins).toHaveBeenCalledWith([
        'admin.wallets.updated',
        'admin.dashboard.updated',
      ]);
    });
  });

  describe('Bulk operations coalescing', () => {
    it('bulkUpdateOrderStatus publishes once per unique user even for multiple orders', async () => {
      mockPrisma = {
        order: {
          findUnique: jest.fn()
            // 3 orders: order 1 and order 2 belong to user A, order 3 belongs to user B
            .mockResolvedValueOnce({ id: 'o-1', orderNumber: 'PF1', userId: 'user-A', status: 'PENDING' })
            .mockResolvedValueOnce({ id: 'o-2', orderNumber: 'PF2', userId: 'user-A', status: 'PENDING' })
            .mockResolvedValueOnce({ id: 'o-3', orderNumber: 'PF3', userId: 'user-B', status: 'PENDING' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        $transaction: jest.fn().mockImplementation(async (cb) => {
          if (typeof cb === 'function') {
            return cb(mockPrisma);
          }
          return cb;
        }),
      };

      const mockBillingService: any = {
        settleDelivery: jest.fn(),
      };

      const ordersService = new OrdersService(mockPrisma, mockBillingService, mockRealtimeService);

      const res = await ordersService.bulkUpdateOrderStatus({
        orderIds: ['o-1', 'o-2', 'o-3'],
        status: 'CONFIRMED' as any,
      });

      expect(res.successCount).toBe(3);

      // Verify coalesced publish: user-A published ONCE, user-B published ONCE
      expect(mockRealtimeService.publishToCustomer).toHaveBeenCalledTimes(2);
      expect(mockRealtimeService.publishToCustomer).toHaveBeenCalledWith('user-A', ['orders.updated']);
      expect(mockRealtimeService.publishToCustomer).toHaveBeenCalledWith('user-B', ['orders.updated']);

      // Admin notified once
      expect(mockRealtimeService.publishToAdmins).toHaveBeenCalledTimes(1);
    });
  });
});
