import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ProfileStorageService } from "./storage/profile-storage.service";
import { CustomerCreateProfileDto } from "./dto/customer/customer-create-profile.dto";
import { CustomerUpdateProfileDto } from "./dto/customer/customer-update-profile.dto";
import { validateAvatarFile } from "./utils/avatar-validator.util";
import { CustomerProfile, Prisma } from "@prisma/client";

export interface CombinedCustomerProfileResponse {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  gender: string;
  dateOfBirth: string;
  profileImageUrl: string | null;
  mobile: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: ProfileStorageService,
  ) {}

  /**
   * Creates a dedicated CustomerProfile for the given authenticated user.
   */
  async createCustomerProfile(
    userId: string,
    dto: CustomerCreateProfileDto,
  ): Promise<CombinedCustomerProfileResponse> {
    const existing = await this.prisma.customerProfile.findUnique({
      where: { userId },
    });

    if (existing) {
      throw new ConflictException("Customer profile already exists");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    const dob = this.validateAndParseDate(dto.dateOfBirth);

    try {
      const profile = await this.prisma.customerProfile.create({
        data: {
          userId,
          firstName: dto.firstName,
          lastName: dto.lastName,
          gender: dto.gender,
          dateOfBirth: dob,
        },
      });

      return this.formatProfileResponse(profile, user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("Customer profile already exists");
      }
      throw error;
    }
  }

  /**
   * Retrieves the combined customer profile for the authenticated user.
   */
  async getCustomerProfile(
    userId: string,
  ): Promise<CombinedCustomerProfileResponse> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId },
      include: { user: true },
    });

    if (!profile) {
      throw new NotFoundException(
        "Customer profile not found. Please create a profile first.",
      );
    }

    return this.formatProfileResponse(profile, profile.user);
  }

  /**
   * Updates customer profile fields (firstName, lastName, gender, dateOfBirth).
   */
  async updateCustomerProfile(
    userId: string,
    dto: CustomerUpdateProfileDto,
  ): Promise<CombinedCustomerProfileResponse> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId },
      include: { user: true },
    });

    if (!profile) {
      throw new NotFoundException("Customer profile not found");
    }

    const updateData: Prisma.CustomerProfileUpdateInput = {};

    if (dto.firstName !== undefined) updateData.firstName = dto.firstName;
    if (dto.lastName !== undefined) updateData.lastName = dto.lastName;
    if (dto.gender !== undefined) updateData.gender = dto.gender;
    if (dto.dateOfBirth !== undefined) {
      updateData.dateOfBirth = this.validateAndParseDate(dto.dateOfBirth);
    }

    const updated = await this.prisma.customerProfile.update({
      where: { userId },
      data: updateData,
      include: { user: true },
    });

    return this.formatProfileResponse(updated, updated.user);
  }

  /**
   * Updates customer avatar via validated multipart image upload using a safe 2-phase sequence:
   * 1. Validate new file.
   * 2. Upload new avatar to storage and obtain public URL.
   * 3. Update database record with new avatar URL.
   * 4. Only after database update succeeds, delete old avatar from storage.
   * 5. If upload fails, old avatar is kept.
   * 6. If DB update fails, clean up the newly uploaded avatar and keep old avatar.
   */
  async updateCustomerAvatar(
    userId: string,
    file?: Express.Multer.File,
  ): Promise<CombinedCustomerProfileResponse> {
    // 1. Validate new file
    validateAvatarFile(file);

    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId },
      include: { user: true },
    });

    if (!profile) {
      throw new NotFoundException("Customer profile not found");
    }

    const oldAvatarUrl = profile.profileImageUrl;

    // 2 & 3. Upload new avatar and obtain new public URL
    // If upload fails, old avatar is safely kept untouched
    const newProfileImageUrl = await this.storageService.uploadAvatar(
      userId,
      file!,
    );

    // 4. Update CustomerProfile.profileImageUrl in PostgreSQL
    let updated;
    try {
      updated = await this.prisma.customerProfile.update({
        where: { userId },
        data: { profileImageUrl: newProfileImageUrl },
        include: { user: true },
      });
    } catch (dbError) {
      // 7. Database update failed: clean up newly uploaded avatar to prevent orphans
      try {
        await this.storageService.deleteAvatar(newProfileImageUrl);
      } catch (cleanupError) {
        // Suppress cleanup error to surface root database error
      }
      throw dbError;
    }

    // 5. Only after database update succeeds, delete old avatar from storage
    if (oldAvatarUrl) {
      try {
        await this.storageService.deleteAvatar(oldAvatarUrl);
      } catch (deleteError) {
        // Non-fatal if old avatar deletion fails; new avatar is already live and persisted
      }
    }

    return this.formatProfileResponse(updated, updated.user);
  }

  /**
   * Removes avatar reference from profile and deletes physical object.
   */
  async removeCustomerAvatar(
    userId: string,
  ): Promise<CombinedCustomerProfileResponse> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId },
      include: { user: true },
    });

    if (!profile) {
      throw new NotFoundException("Customer profile not found");
    }

    if (profile.profileImageUrl) {
      await this.storageService.deleteAvatar(profile.profileImageUrl);

      const updated = await this.prisma.customerProfile.update({
        where: { userId },
        data: { profileImageUrl: null },
        include: { user: true },
      });

      return this.formatProfileResponse(updated, updated.user);
    }

    return this.formatProfileResponse(profile, profile.user);
  }

  private validateAndParseDate(dateStr: string): Date {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      throw new BadRequestException("Invalid dateOfBirth");
    }

    const now = new Date();
    if (date >= now) {
      throw new BadRequestException("dateOfBirth must be in the past");
    }

    return date;
  }

  private formatProfileResponse(
    profile: CustomerProfile,
    user: {
      mobile: string;
      email: string | null;
      emailVerified: boolean;
    },
  ): CombinedCustomerProfileResponse {
    return {
      id: profile.id,
      userId: profile.userId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      gender: profile.gender,
      dateOfBirth: profile.dateOfBirth.toISOString().split("T")[0],
      profileImageUrl: profile.profileImageUrl,
      mobile: user.mobile,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }
}
