import { Test, TestingModule } from "@nestjs/testing";
import { ProfileStorageService } from "./profile-storage.service";
import { ConfigService } from "@nestjs/config";

jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

jest.mock("@supabase/supabase-js", () => {
  const mockStorageFrom = {
    upload: jest.fn(),
    getPublicUrl: jest.fn(),
    remove: jest.fn(),
  };
  return {
    createClient: jest.fn().mockReturnValue({
      storage: {
        from: jest.fn().mockReturnValue(mockStorageFrom),
      },
    }),
  };
});

describe("ProfileStorageService", () => {
  let service: ProfileStorageService;
  let configService: any;
  let mockSupabaseStorage: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    const { createClient } = require("@supabase/supabase-js");
    const clientInstance = createClient("url", "key");
    mockSupabaseStorage = clientInstance.storage.from("uploads");

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileStorageService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === "SUPABASE_URL") return "https://test.supabase.co";
              if (key === "SUPABASE_SECRET_KEY") return "test-secret";
              if (key === "SUPABASE_STORAGE_BUCKET") return "uploads";
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ProfileStorageService>(ProfileStorageService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should upload avatar to Supabase and return public URL", async () => {
    mockSupabaseStorage.upload.mockResolvedValue({ data: {}, error: null });
    mockSupabaseStorage.getPublicUrl.mockReturnValue({
      data: {
        publicUrl:
          "https://test.supabase.co/storage/v1/object/public/uploads/avatars/customers/u1-123.jpg",
      },
    });

    const file = {
      fieldname: "avatar",
      originalname: "test.jpg",
      mimetype: "image/jpeg",
      size: 1024,
      buffer: Buffer.from("test"),
    } as Express.Multer.File;

    const url = await service.uploadAvatar("u1", file);

    expect(url).toContain("https://test.supabase.co");
    expect(mockSupabaseStorage.upload).toHaveBeenCalled();
  });

  it("should delete avatar from Supabase using public URL", async () => {
    mockSupabaseStorage.remove.mockResolvedValue({ data: {}, error: null });

    const publicUrl =
      "https://test.supabase.co/storage/v1/object/public/uploads/avatars/customers/u1-123.jpg";

    await service.deleteAvatar(publicUrl);

    expect(mockSupabaseStorage.remove).toHaveBeenCalledWith([
      "avatars/customers/u1-123.jpg",
    ]);
  });
});
