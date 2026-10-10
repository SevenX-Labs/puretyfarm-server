import { BadRequestException } from '@nestjs/common';

export const MAX_AVATAR_SIZE = 3 * 1024 * 1024; // 3 MB
export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

type DetectedFormat = 'image/jpeg' | 'image/png' | 'image/webp' | null;

/**
 * Detects the real image format from the leading magic bytes.
 * Returns null when the buffer does not match a supported image signature.
 */
function detectImageFormat(buffer: Buffer): DetectedFormat {
  if (!buffer || buffer.length < 12) {
    return null;
  }

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return 'image/jpeg';

  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (isPng) return 'image/png';

  const isWebp =
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x45 && // E
    buffer[10] === 0x42 && // B
    buffer[11] === 0x50; // P
  if (isWebp) return 'image/webp';

  return null;
}

/**
 * Defense-in-depth avatar validation (also enforced at the Multer boundary):
 * - presence + 3 MB size cap
 * - MIME allowlist (JPEG/PNG/WEBP only)
 * - magic-byte signature check
 * - the declared MIME type MUST correspond to the detected magic bytes, so a
 *   file claiming image/jpeg but containing PNG bytes (or vice versa) is rejected
 */
export function validateAvatarFile(file?: Express.Multer.File): void {
  if (!file || !file.buffer) {
    throw new BadRequestException('Avatar file is required');
  }

  if (file.size > MAX_AVATAR_SIZE) {
    throw new BadRequestException('Avatar file size must not exceed 3 MB');
  }

  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new BadRequestException(
      'Unsupported file type. Allowed formats: JPEG, PNG, WEBP',
    );
  }

  const detected = detectImageFormat(file.buffer);
  if (!detected) {
    throw new BadRequestException(
      'File signature does not match a valid JPEG, PNG, or WEBP image',
    );
  }

  // The declared MIME type must match what the bytes actually are. This blocks
  // spoofed uploads (e.g. a PNG renamed/relabelled as image/jpeg).
  if (detected !== file.mimetype) {
    throw new BadRequestException(
      'File contents do not match the declared image type',
    );
  }
}
