import { Module, forwardRef } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { AdminPaymentsController } from './admin-payments.controller';
import { PhonePeRedirectController } from './phonepe-redirect.controller';
import { PhonePeWebhookController } from './webhook/phonepe-webhook.controller';
import { PhonePeWebhookService } from './webhook/phonepe-webhook.service';
import { PhonePeService } from './providers/phonepe/phonepe.service';
import { PhonePeClient } from './providers/phonepe/phonepe.client';
import { PhonePeAuthService } from './providers/phonepe/phonepe.auth.service';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { OrdersModule } from '../orders/orders.module';
import { PlansModule } from '../plans/plans.module';
import { OrderPaymentsController } from './order-payments.controller';

/**
 * One shared Payment module: customer APIs, admin APIs, the public PhonePe
 * browser return handler and the single PhonePe webhook.
 *
 * PhonePe is the active and sole online payment provider.
 */
@Module({
  imports: [PrismaModule, AuthModule, forwardRef(() => WalletModule), OrdersModule, forwardRef(() => PlansModule)],
  controllers: [
    PaymentsController,
    AdminPaymentsController,
    PhonePeRedirectController,
    PhonePeWebhookController,
    OrderPaymentsController,
  ],
  providers: [
    PaymentsService,
    PhonePeWebhookService,
    PhonePeAuthService,
    PhonePeClient,
    PhonePeService,
    { provide: PAYMENT_PROVIDER, useExisting: PhonePeService },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
