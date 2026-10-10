import { BadRequestException } from '@nestjs/common';
import { avatarMulterOptions } from './avatar-upload.options';

describe('avatarMulterOptions (Multer boundary)', () => {
  it('F. enforces a 3 MB file-size limit at the Multer boundary', () => {
    expect(avatarMulterOptions.limits?.fileSize).toBe(3 * 1024 * 1024);
  });

  it('accepts allowed image MIME types via fileFilter', () => {
    for (const mimetype of ['image/jpeg', 'image/png', 'image/webp']) {
      const cb = jest.fn();
      avatarMulterOptions.fileFilter!(
        {} as any,
        { mimetype } as Express.Multer.File,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(null, true);
    }
  });

  it('rejects disallowed MIME types via fileFilter', () => {
    for (const mimetype of [
      'image/svg+xml',
      'image/gif',
      'application/pdf',
      'text/html',
      'application/zip',
    ]) {
      const cb = jest.fn();
      avatarMulterOptions.fileFilter!(
        {} as any,
        { mimetype } as Express.Multer.File,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(expect.any(BadRequestException), false);
    }
  });
});
