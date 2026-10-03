import { Module } from "@nestjs/common";
import { LocationsService } from "./locations.service";
import { LocationsController } from "./locations.controller";
import { GeoapifyService } from "./geoapify/geoapify.service";
import { PrismaModule } from "../../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [LocationsController],
  providers: [LocationsService, GeoapifyService],
  exports: [LocationsService, GeoapifyService],
})
export class LocationsModule {}
