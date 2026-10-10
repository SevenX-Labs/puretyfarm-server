import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Fast2SmsService } from "./fast2sms.service";

jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

describe("Fast2SmsService", () => {
  let service: Fast2SmsService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === "FAST2SMS_OTP_API_KEY") return "test-api-key";
      return null;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        Fast2SmsService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<Fast2SmsService>(Fast2SmsService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should send OTP successfully via Fast2SMS API", async () => {
    const fetchSpy = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      json: async () => ({ return: true, request_id: "req-12345", message: ["SMS sent successfully."] }),
    } as any);

    const result = await service.sendOtp("+919876543210", "123456");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.fast2sms.com/dev/bulkV2",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "test-api-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          route: "otp",
          variables_values: "123456",
          numbers: "9876543210",
        }),
      })
    );
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("req-12345");

    fetchSpy.mockRestore();
  });

  it("should handle error response from Fast2SMS", async () => {
    const fetchSpy = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ return: false, status_code: 996, message: "Verification required" }),
    } as any);

    const result = await service.sendOtp("+919876543210", "123456");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Verification required");

    fetchSpy.mockRestore();
  });
});
