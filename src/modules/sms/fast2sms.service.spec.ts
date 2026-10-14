jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockReturnValue('sk_live_test_key'),
  })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Fast2SmsService } from './fast2sms.service';

describe('Fast2SmsService', () => {
  let service: Fast2SmsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        Fast2SmsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('sk_live_test_key'),
          },
        },
      ],
    }).compile();

    service = module.get<Fast2SmsService>(Fast2SmsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should send OTP successfully via Nexus OTP endpoint', async () => {
    const mockResponse = {
      success: true,
      message: 'OTP sent successfully.',
      request_id: 'req_123456',
    };

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue(mockResponse),
    } as any);

    const result = await service.sendOtp('+919876543210', '123456');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://apinexusotp.vercel.app/api/v1/otp/send',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk_live_test_key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone: '9876543210',
          otp: '123456',
        }),
      }),
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('req_123456');
  });

  it('should handle error response from Nexus OTP', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: jest
        .fn()
        .mockResolvedValue({ success: false, message: 'Invalid API key' }),
    } as any);

    const result = await service.sendOtp('+919876543210', '123456');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });
});
