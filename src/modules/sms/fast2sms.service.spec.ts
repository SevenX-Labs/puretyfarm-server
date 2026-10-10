jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockReturnValue("test-api-key"),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Fast2SmsService } from "./fast2sms.service";

describe("Fast2SmsService", () => {
  let service: Fast2SmsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        Fast2SmsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue("test-api-key"),
          },
        },
      ],
    }).compile();

    service = module.get<Fast2SmsService>(Fast2SmsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should send OTP successfully via Fast2SMS Quick SMS API", async () => {
    const mockResponse = {
      return: true,
      request_id: "req_123456",
      message: ["SMS sent successfully."],
    };

    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue(mockResponse),
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
          route: "q",
          message: "Your Purety Farm verification code is 123456. Valid for 5 minutes.",
          numbers: "9876543210",
        }),
      }),
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("req_123456");
  });

  it("should handle error response from Fast2SMS", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      json: jest.fn().mockResolvedValue({ return: false, message: "Invalid key" }),
    } as any);

    const result = await service.sendOtp("+919876543210", "123456");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid key");
  });
});
