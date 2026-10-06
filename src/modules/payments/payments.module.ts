import { Module, forwardRef } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { AdminPaymentsController } from './admin-payments.controller';
import { PayuCallbackController } from './payu-callback.controller';
import { PayuWebhookController } from './webhook/payu-webhook.controller';
import { PayuWebhookService } from './webhook/payu-webhook.service';
import { PayuService } from './providers/payu/payu.service';
import { PayuClient } from './providers/payu/payu.client';
import { PayuHashService } from './providers/payu/payu.hash.service';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { OrdersModule } from '../orders/orders.module';
import { PlansModule } from '../plans/plans.module';
import { OrderPaymentsController } from './order-payments.controller';

/**
 * One shared Payment module: customer APIs, admin APIs, the public PayU
 * callbacks and the single PayU webhook.
 *
 * `WalletModule` is imported to reuse the existing `WalletService` — the
 * wallet balance and ledger are never reimplemented here.
 *
 * `PAYMENT_PROVIDER` is bound to `PayuService` so `PaymentsService` depends
 * only on the `IPaymentProvider` abstraction. Adding a second gateway means
 * adding a provider class and changing this one binding.
 */
@Module({
  imports: [PrismaModule, AuthModule, forwardRef(() => WalletModule), OrdersModule, forwardRef(() => PlansModule)],
  controllers: [
    PaymentsController,
    AdminPaymentsController,
    PayuCallbackController,
    PayuWebhookController,
    OrderPaymentsController,
  ],
  providers: [
    PaymentsService,
    PayuWebhookService,
    PayuHashService,
    PayuClient,
    PayuService,
    { provide: PAYMENT_PROVIDER, useExisting: PayuService },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
