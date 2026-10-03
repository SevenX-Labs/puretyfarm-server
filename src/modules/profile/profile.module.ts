import { Module } from "@nestjs/common";
import { ProfileService } from "./profile.service";
import { ProfileController } from "./profile.controller";
import { ProfileStorageService } from "./storage/profile-storage.service";
import { PrismaModule } from "../../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ProfileController],
  providers: [ProfileService, ProfileStorageService],
  exports: [ProfileService, ProfileStorageService],
})
export class ProfileModule {}
