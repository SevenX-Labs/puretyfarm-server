import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { IProfileStorageService } from "./profile-storage.interface";
import * as fs from "fs/promises";
import * as path from "path";

@Injectable()
export class ProfileStorageService implements IProfileStorageService {
  private readonly logger = new Logger(ProfileStorageService.name);
  private readonly supabaseClient?: SupabaseClient;
  private readonly bucketName?: string;
  private readonly localUploadDir = path.resolve(
    process.cwd(),
    "uploads",
    "avatars",
  );

  constructor(private readonly configService: ConfigService) {
    const supabaseUrl =
      this.configService?.get<string>("SUPABASE_URL") ||
      process.env.SUPABASE_URL;
    const supabaseKey =
      this.configService?.get<string>("SUPABASE_SECRET_KEY") ||
      process.env.SUPABASE_SECRET_KEY;
    const bucket =
      this.configService?.get<string>("SUPABASE_STORAGE_BUCKET") ||
      process.env.SUPABASE_STORAGE_BUCKET;

    if (supabaseUrl && supabaseKey && bucket) {
      this.supabaseClient = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false },
      });
      this.bucketName = bucket;
      this.logger.log(
        `Supabase Storage client initialized for bucket: "${bucket}"`,
      );
    } else {
      this.logger.warn(
        "Supabase credentials not fully configured; using local storage fallback",
      );
      this.ensureLocalUploadDir();
    }
  }

  private async ensureLocalUploadDir(): Promise<void> {
    try {
      await fs.mkdir(this.localUploadDir, { recursive: true });
    } catch (error) {
      this.logger.warn(`Failed to create local upload directory: ${error}`);
    }
  }

  async uploadAvatar(
    userId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    let ext = ".jpg";
    if (file.mimetype === "image/png") ext = ".png";
    else if (file.mimetype === "image/webp") ext = ".webp";
    else if (file.mimetype === "image/jpeg") ext = ".jpg";

    const filename = `${userId}-${Date.now()}${ext}`;

    if (this.supabaseClient && this.bucketName) {
      const storagePath = `avatars/customers/${filename}`;
      const { error } = await this.supabaseClient.storage
        .from(this.bucketName)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (error) {
        this.logger.error(`Supabase upload error: ${error.message}`);
        throw new Error(`Failed to upload avatar to Supabase: ${error.message}`);
      }

      const { data: publicUrlData } = this.supabaseClient.storage
        .from(this.bucketName)
        .getPublicUrl(storagePath);

      return publicUrlData.publicUrl;
    }

    // Local file fallback
    await this.ensureLocalUploadDir();
    const filePath = path.join(this.localUploadDir, filename);
    await fs.writeFile(filePath, file.buffer);
    return `/uploads/avatars/${filename}`;
  }

  async deleteAvatar(fileUrlOrKey: string): Promise<void> {
    if (!fileUrlOrKey) return;

    if (this.supabaseClient && this.bucketName) {
      const storagePath = this.extractStoragePath(fileUrlOrKey);
      if (storagePath) {
        const { error } = await this.supabaseClient.storage
          .from(this.bucketName)
          .remove([storagePath]);

        if (error) {
          this.logger.warn(
            `Failed to delete avatar from Supabase: ${error.message}`,
          );
        }
        return;
      }
    }

    // Local fallback cleanup
    try {
      const filename = path.basename(fileUrlOrKey);
      const filePath = path.join(this.localUploadDir, filename);
      await fs.unlink(filePath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        this.logger.warn(
          `Could not delete local avatar file ${fileUrlOrKey}: ${error.message}`,
        );
      }
    }
  }

  private extractStoragePath(fileUrlOrKey: string): string | null {
    if (!fileUrlOrKey) return null;
    if (this.bucketName) {
      const prefix = `/storage/v1/object/public/${this.bucketName}/`;
      const index = fileUrlOrKey.indexOf(prefix);
      if (index !== -1) {
        return fileUrlOrKey.slice(index + prefix.length);
      }
    }
    if (fileUrlOrKey.startsWith("avatars/")) {
      return fileUrlOrKey;
    }
    return null;
  }
}
