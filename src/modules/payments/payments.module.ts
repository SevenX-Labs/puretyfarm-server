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
 * `WalletModule` is imported to reuse the existing `WalletService` — the
 * wallet balance and ledger are never reimplemented here.
 *
 * `PAYMENT_PROVIDER` is bound to `PhonePeService` so `PaymentsService` depends
 * only on the `IPaymentProvider` abstraction. Swapping gateways means changing
 * this one binding.
 *
 * PayU DEPRECATION
 * ----------------
 * The PayU provider, hash service, client, callback controller and webhook
 * remain on disk under `providers/payu/` and `webhook/payu-webhook.*` but are
 * NO LONGER REGISTERED here. They are therefore completely inert: the
 * `/payments/payu/*` and `/payments/webhooks/payu` routes no longer exist, and
 * nothing in the active payment path can reach PayU code.
 *
 * They are kept, along with the PAYU_KEY / PAYU_SALT configuration, so the
 * cutover can be rolled back by re-registering the four PayU classes and
 * re-binding PAYMENT_PROVIDER — no code has to be rewritten. Delete them once
 * PhonePe has been validated in production. Historical PayU Payment rows are
 * untouched and still readable through the admin APIs.
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
