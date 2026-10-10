import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { ALLOWED_MIME_TYPES, MAX_AVATAR_SIZE } from './avatar-validator.util';

/**
 * Multer options for the single avatar upload field.
 *
 * Enforces the 3 MB cap at the framework boundary (first line of defense) and
 * rejects obviously-wrong MIME types before the buffer is ever handed to the
 * service. The service still runs full magic-byte validation as defense in
 * depth. Files are kept in memory (no disk) so the client never influences any
 * on-disk path.
 */
export const avatarMulterOptions: MulterOptions = {
  limits: { fileSize: MAX_AVATAR_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(
        new BadRequestException(
          'Unsupported file type. Allowed formats: JPEG, PNG, WEBP',
        ),
        false,
      );
      return;
    }
    cb(null, true);
  },
};
