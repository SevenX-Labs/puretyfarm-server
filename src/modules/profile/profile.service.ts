import {
  Injectable,
  Logger,
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

// Signed URLs for private avatars are short-lived; the DB only ever stores the
// permanent object path, never this URL.
export const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour

export interface CombinedCustomerProfileResponse {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  gender: string;
  dateOfBirth: string;
  // Temporary signed URL (or null). Derived from the stored profileImagePath
  // at read time — NEVER persisted.
  profileImageUrl: string | null;
  mobile: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

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

      return await this.buildProfileResponse(profile, user);
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

    return this.buildProfileResponse(profile, profile.user);
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

    return this.buildProfileResponse(updated, updated.user);
  }

  /**
   * Updates the customer avatar from a validated multipart image using a safe
   * ordering that never leaves the account without a working avatar:
   * 1. Validate the new file (defense in depth on top of the Multer limits).
   * 2. Upload the new object to the PRIVATE bucket -> get its storage PATH.
   *    If this fails, the old avatar + DB path are kept untouched.
   * 3. Persist the new PATH in PostgreSQL.
   *    If this fails, delete the just-uploaded object and keep the old avatar.
   * 4. Only after the DB commit, delete the OLD object. A failure here is
   *    logged but NOT rolled back — the new avatar is already live.
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

    const oldAvatarPath = profile.profileImagePath;

    // 2. Upload new avatar -> permanent storage PATH (not a URL).
    //    If upload fails, old avatar is safely kept untouched.
    const newAvatarPath = await this.storageService.uploadAvatar(userId, file!);

    // 3. Persist the new PATH in PostgreSQL.
    let updated;
    try {
      updated = await this.prisma.customerProfile.update({
        where: { userId },
        data: { profileImagePath: newAvatarPath },
        include: { user: true },
      });
    } catch (dbError) {
      // DB update failed: remove the orphaned new object, keep old avatar/path.
      try {
        await this.storageService.deleteAvatar(newAvatarPath);
      } catch {
        // Suppress cleanup error so the root DB error is surfaced.
      }
      throw dbError;
    }

    // 4. DB committed: delete the OLD object. Non-fatal on failure.
    if (oldAvatarPath && oldAvatarPath !== newAvatarPath) {
      try {
        await this.storageService.deleteAvatar(oldAvatarPath);
      } catch {
        this.logger.warn(
          `Avatar replaced for user ${userId}, but deleting the old object failed. New avatar is live; old object may need manual cleanup.`,
        );
      }
    }

    return this.buildProfileResponse(updated, updated.user);
  }

  /**
   * Removes the avatar: deletes the stored object (only the authenticated
   * user's own path) and clears the DB path. Returns profileImageUrl: null.
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

    if (profile.profileImagePath) {
      await this.storageService.deleteAvatar(profile.profileImagePath);

      const updated = await this.prisma.customerProfile.update({
        where: { userId },
        data: { profileImagePath: null },
        include: { user: true },
      });

      return this.buildProfileResponse(updated, updated.user);
    }

    return this.buildProfileResponse(profile, profile.user);
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

  /**
   * Builds the API response, turning the stored private object PATH into a
   * temporary signed URL exposed as `profileImageUrl`. The signed URL is never
   * written back to the database. If signing fails we return null rather than
   * failing the whole profile read.
   */
  private async buildProfileResponse(
    profile: CustomerProfile,
    user: {
      mobile: string;
      email: string | null;
      emailVerified: boolean;
    },
  ): Promise<CombinedCustomerProfileResponse> {
    let profileImageUrl: string | null = null;
    if (profile.profileImagePath) {
      try {
        profileImageUrl = await this.storageService.createSignedUrl(
          profile.profileImagePath,
          SIGNED_URL_EXPIRY_SECONDS,
        );
      } catch {
        this.logger.warn(
          `Failed to generate signed avatar URL for user ${profile.userId}`,
        );
        profileImageUrl = null;
      }
    }

    return {
      id: profile.id,
      userId: profile.userId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      gender: profile.gender,
      dateOfBirth: profile.dateOfBirth.toISOString().split("T")[0],
      profileImageUrl,
      mobile: user.mobile,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }
}
