import { Test, TestingModule } from '@nestjs/testing';
import { ProfileStorageService } from './profile-storage.service';
import { ConfigService } from '@nestjs/config';

jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

jest.mock('@supabase/supabase-js', () => {
  const mockStorageFrom = {
    upload: jest.fn(),
    remove: jest.fn(),
    createSignedUrl: jest.fn(),
  };
  return {
    createClient: jest.fn().mockReturnValue({
      storage: {
        from: jest.fn().mockReturnValue(mockStorageFrom),
      },
    }),
  };
});

describe('ProfileStorageService (private bucket)', () => {
  let service: ProfileStorageService;
  let mockSupabaseStorage: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    const { createClient } = require('@supabase/supabase-js');
    const clientInstance = createClient('url', 'key');
    mockSupabaseStorage = clientInstance.storage.from('uploads');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileStorageService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'SUPABASE_URL') return 'https://test.supabase.co';
              if (key === 'SUPABASE_SECRET_KEY') return 'test-secret';
              if (key === 'SUPABASE_STORAGE_BUCKET') return 'uploads';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ProfileStorageService>(ProfileStorageService);
  });

  const jpegFile = {
    fieldname: 'avatar',
    originalname: '../../etc/passwd.jpg', // hostile name — must be ignored
    mimetype: 'image/jpeg',
    size: 1024,
    buffer: Buffer.from('test'),
  } as unknown as Express.Multer.File;

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('uploads to the private bucket and returns the OBJECT PATH (not a URL)', async () => {
    mockSupabaseStorage.upload.mockResolvedValue({ data: {}, error: null });

    const result = await service.uploadAvatar('u1', jpegFile);

    expect(result).toMatch(/^avatars\/customers\/u1-\d+\.jpg$/);
    expect(result).not.toMatch(/^https?:\/\//);
    // W. The client-supplied originalname must never leak into the path.
    expect(result).not.toContain('passwd');
    expect(result).not.toContain('..');
    // getPublicUrl must NOT be used (bucket stays private).
    expect(mockSupabaseStorage.getPublicUrl).toBeUndefined();

    const [uploadedPath] = mockSupabaseStorage.upload.mock.calls[0];
    expect(uploadedPath).toBe(result);
  });

  it('derives the extension from the validated MIME type', async () => {
    mockSupabaseStorage.upload.mockResolvedValue({ data: {}, error: null });

    const png = await service.uploadAvatar('u1', {
      ...jpegFile,
      mimetype: 'image/png',
    });
    expect(png).toMatch(/\.png$/);

    const webp = await service.uploadAvatar('u1', {
      ...jpegFile,
      mimetype: 'image/webp',
    });
    expect(webp).toMatch(/\.webp$/);
  });

  it('throws when the upload itself fails', async () => {
    mockSupabaseStorage.upload.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    await expect(service.uploadAvatar('u1', jpegFile)).rejects.toThrow(
      /Failed to upload avatar/,
    );
  });

  it('creates a signed URL for a valid object path', async () => {
    mockSupabaseStorage.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://test.supabase.co/signed?token=abc' },
      error: null,
    });

    const url = await service.createSignedUrl(
      'avatars/customers/u1-123.jpg',
      3600,
    );

    expect(url).toBe('https://test.supabase.co/signed?token=abc');
    expect(mockSupabaseStorage.createSignedUrl).toHaveBeenCalledWith(
      'avatars/customers/u1-123.jpg',
      3600,
    );
  });

  it('deletes by object path', async () => {
    mockSupabaseStorage.remove.mockResolvedValue({ data: {}, error: null });

    await service.deleteAvatar('avatars/customers/u1-123.jpg');

    expect(mockSupabaseStorage.remove).toHaveBeenCalledWith([
      'avatars/customers/u1-123.jpg',
    ]);
  });

  describe('W. rejects untrusted / client-controlled paths', () => {
    const hostile = [
      'secrets/private.key',
      '../avatars/customers/u1.jpg',
      'avatars/customers/../../etc/passwd',
      '',
    ];

    it('deleteAvatar refuses paths outside avatars/customers (and never calls remove)', async () => {
      for (const p of hostile) {
        if (p === '') {
          // empty is a silent no-op by contract
          await expect(service.deleteAvatar(p)).resolves.toBeUndefined();
        } else {
          await expect(service.deleteAvatar(p)).rejects.toThrow(
            /untrusted storage path/,
          );
        }
      }
      expect(mockSupabaseStorage.remove).not.toHaveBeenCalled();
    });

    it('createSignedUrl refuses untrusted paths', async () => {
      await expect(
        service.createSignedUrl('secrets/private.key', 3600),
      ).rejects.toThrow(/untrusted storage path/);
      expect(mockSupabaseStorage.createSignedUrl).not.toHaveBeenCalled();
    });
  });
});
