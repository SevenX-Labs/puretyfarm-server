import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { IProfileStorageService } from "./profile-storage.interface";
import * as fs from "fs/promises";
import * as path from "path";

// All customer avatars live under this server-controlled prefix. The client
// never supplies any part of the path, bucket, or filename.
const AVATAR_PREFIX = "avatars/customers";

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
      this.logger.warn(`Failed to create local upload directory: ${String(error)}`);
    }
  }

  private extensionFor(mimetype: string): string {
    if (mimetype === "image/png") return ".png";
    if (mimetype === "image/webp") return ".webp";
    return ".jpg"; // image/jpeg
  }

  /**
   * Builds the server-controlled storage path. The only client-derived input
   * is the already-validated MIME type (for the extension) — never the
   * original filename.
   */
  private buildObjectPath(userId: string, mimetype: string): string {
    const ext = this.extensionFor(mimetype);
    return `${AVATAR_PREFIX}/${userId}-${Date.now()}${ext}`;
  }

  // Rejects anything that is not a server-generated avatar path, so a client
  // can never trick delete/sign into touching an arbitrary object.
  private assertSafePath(objectPath: string): void {
    if (
      !objectPath ||
      !objectPath.startsWith(`${AVATAR_PREFIX}/`) ||
      objectPath.includes("..")
    ) {
      throw new Error("Refusing to operate on an untrusted storage path");
    }
  }

  async uploadAvatar(
    userId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    const objectPath = this.buildObjectPath(userId, file.mimetype);

    if (this.supabaseClient && this.bucketName) {
      const { error } = await this.supabaseClient.storage
        .from(this.bucketName)
        .upload(objectPath, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (error) {
        this.logger.error(`Supabase upload failed`);
        throw new Error(`Failed to upload avatar: ${error.message}`);
      }

      // Return the permanent OBJECT PATH only — never a public/signed URL.
      return objectPath;
    }

    // Local file fallback (dev without Supabase credentials). Still returns a
    // path in the same canonical shape so the rest of the app is agnostic.
    await this.ensureLocalUploadDir();
    const filename = path.basename(objectPath);
    const filePath = path.join(this.localUploadDir, filename);
    await fs.writeFile(filePath, file.buffer);
    return objectPath;
  }

  async deleteAvatar(objectPath: string): Promise<void> {
    if (!objectPath) return;
    this.assertSafePath(objectPath);

    if (this.supabaseClient && this.bucketName) {
      const { error } = await this.supabaseClient.storage
        .from(this.bucketName)
        .remove([objectPath]);

      if (error) {
        // Surface to caller; the service layer decides whether this is fatal.
        throw new Error(`Failed to delete avatar: ${error.message}`);
      }
      return;
    }

    // Local fallback cleanup
    try {
      const filename = path.basename(objectPath);
      const filePath = path.join(this.localUploadDir, filename);
      await fs.unlink(filePath);
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  async createSignedUrl(
    objectPath: string,
    expiresInSeconds: number,
  ): Promise<string> {
    this.assertSafePath(objectPath);

    if (this.supabaseClient && this.bucketName) {
      const { data, error } = await this.supabaseClient.storage
        .from(this.bucketName)
        .createSignedUrl(objectPath, expiresInSeconds);

      if (error || !data?.signedUrl) {
        throw new Error(
          `Failed to create signed URL: ${error?.message ?? "unknown error"}`,
        );
      }
      return data.signedUrl;
    }

    // Local fallback: expose a path the dev server can serve statically.
    return `/uploads/avatars/${path.basename(objectPath)}`;
  }
}
