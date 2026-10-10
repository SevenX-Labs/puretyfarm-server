import { Module, forwardRef } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { AdminWalletController } from './admin-wallet.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  // forwardRef breaks the circular import that would otherwise exist:
  // PaymentsModule imports WalletModule to call WalletService; WalletModule
  // imports PaymentsModule so AdminWalletController can auto-initiate the
  // PayU refund after rejecting a credit request. Each side resolves the
  // other lazily.
  imports: [PrismaModule, AuthModule, forwardRef(() => PaymentsModule)],
  controllers: [WalletController, AdminWalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
