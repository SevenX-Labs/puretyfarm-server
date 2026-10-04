import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ValkeyModule } from './valkey/valkey.module';
import { validateEnv } from './config/env.validation';
import { ProfileModule } from './modules/profile/profile.module';
import { LocationsModule } from './modules/locations/locations.module';
import { AddressModule } from './modules/address/address.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PaymentsModule } from './modules/payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ValkeyModule,
    ProfileModule,
    LocationsModule,
    AddressModule,
    WalletModule,
    PaymentsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
