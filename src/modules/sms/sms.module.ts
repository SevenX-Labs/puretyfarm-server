import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Fast2SmsService } from "./fast2sms.service";

@Module({
  imports: [ConfigModule],
  providers: [Fast2SmsService],
  exports: [Fast2SmsService],
})
export class SmsModule {}
