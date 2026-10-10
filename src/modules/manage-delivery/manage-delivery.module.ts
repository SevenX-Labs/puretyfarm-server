import { Module } from '@nestjs/common';
import { ManageDeliveryService } from './manage-delivery.service';
import { ManageDeliveryController } from './manage-delivery.controller';
import { AdminManageDeliveryController } from './admin-manage-delivery.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  // PlansModule provides PlansService, whose `materializeOrdersForSchedule` is
  // the single source of dispatch-order pricing. Importing it keeps cadence
  // changes and resumes from re-implementing those rules.
  imports: [PrismaModule, AuthModule, PlansModule],
  controllers: [ManageDeliveryController, AdminManageDeliveryController],
  providers: [ManageDeliveryService],
  exports: [ManageDeliveryService],
})
export class ManageDeliveryModule {}
