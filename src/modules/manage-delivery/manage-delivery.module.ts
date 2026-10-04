import { Module } from "@nestjs/common";
import { ManageDeliveryService } from "./manage-delivery.service";
import { ManageDeliveryController } from "./manage-delivery.controller";
import { PrismaModule } from "../../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ManageDeliveryController],
  providers: [ManageDeliveryService],
  exports: [ManageDeliveryService],
})
export class ManageDeliveryModule {}
