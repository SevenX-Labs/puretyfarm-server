import { Module, forwardRef } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { DeliveryBillingService } from './delivery-billing.service';

@Module({
  // WalletModule provides the only balance-changing path. forwardRef because
  // WalletModule -> PaymentsModule -> OrdersModule closes a cycle.
  imports: [PrismaModule, AuthModule, forwardRef(() => WalletModule)],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService, DeliveryBillingService],
  exports: [OrdersService, DeliveryBillingService],
})
export class OrdersModule {}
