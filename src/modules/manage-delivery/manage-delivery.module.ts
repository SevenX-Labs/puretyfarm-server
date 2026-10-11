import { Module } from '@nestjs/common';
import { ManageDeliveryService } from './manage-delivery.service';
import { ManageDeliveryController } from './manage-delivery.controller';
import { AdminManageDeliveryController } from './admin-manage-delivery.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PlansModule } from '../plans/plans.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  // PlansModule provides PlansService, whose `materializeOrdersForSchedule` is
  // the single source of dispatch-order pricing. Importing it keeps cadence
  // changes and resumes from re-implementing those rules.
  // OrdersModule provides DeliveryBillingService, the single implementation of
  // per-delivery repricing and balance checks used by quantity changes.
  imports: [PrismaModule, AuthModule, PlansModule, OrdersModule],
  controllers: [ManageDeliveryController, AdminManageDeliveryController],
  providers: [ManageDeliveryService],
  exports: [ManageDeliveryService],
})
export class ManageDeliveryModule {}
