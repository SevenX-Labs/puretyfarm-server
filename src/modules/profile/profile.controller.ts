import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ProfileService } from "./profile.service";
import { CustomerCreateProfileDto } from "./dto/customer/customer-create-profile.dto";
import { CustomerUpdateProfileDto } from "./dto/customer/customer-update-profile.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { JwtPayload } from "../../common/interfaces/jwt-payload.interface";
import { avatarMulterOptions } from "./utils/avatar-upload.options";

@Controller(["api/v1/customer/profile", "customer/profile"])
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Post("create-profile")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createProfile(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CustomerCreateProfileDto,
  ) {
    return this.profileService.createCustomerProfile(user.sub, dto);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getMe(@CurrentUser() user: JwtPayload) {
    return this.profileService.getCustomerProfile(user.sub);
  }

  @Patch("update-profile")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CustomerUpdateProfileDto,
  ) {
    return this.profileService.updateCustomerProfile(user.sub, dto);
  }

  @Post("update-avatar")
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor("avatar", avatarMulterOptions))
  @HttpCode(HttpStatus.OK)
  async updateAvatar(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.profileService.updateCustomerAvatar(user.sub, file);
  }

  @Delete("remove-avatar")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async removeAvatar(@CurrentUser() user: JwtPayload) {
    return this.profileService.removeCustomerAvatar(user.sub);
  }
}
