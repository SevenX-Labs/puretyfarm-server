import { Test, TestingModule } from '@nestjs/testing';
import { ValkeyService } from './valkey.service';
import { ConfigService } from '@nestjs/config';

jest.mock('@nestjs/config', () => {
  return {
    ConfigService: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
    })),
  };
});

describe('ValkeyService', () => {
  let service: ValkeyService;
  let mockConfigService: { get: jest.Mock };

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValkeyService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<ValkeyService>(ValkeyService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw an error during onModuleInit if VALKEY_URL is missing', async () => {
    mockConfigService.get.mockReturnValue(undefined);
    delete process.env.VALKEY_URL;

    await expect(service.onModuleInit()).rejects.toThrow(
      'VALKEY_URL is not defined in configuration or environment variables',
    );
  });

  it('should throw error when calling get/set/delete before initialization', async () => {
    await expect(service.get('test')).rejects.toThrow(
      'Valkey client is not initialized',
    );
    await expect(service.set('test', 'value')).rejects.toThrow(
      'Valkey client is not initialized',
    );
    await expect(service.delete('test')).rejects.toThrow(
      'Valkey client is not initialized',
    );
  });

  it('should handle operations when client is initialized', async () => {
    const mockClient = {
      get: jest.fn().mockResolvedValue('val'),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      close: jest.fn(),
      ping: jest.fn().mockResolvedValue('PONG'),
    };

    (service as any).client = mockClient;

    expect(await service.get('mykey')).toBe('val');
    expect(mockClient.get).toHaveBeenCalledWith('mykey');

    expect(await service.set('mykey', 'myval')).toBe('OK');
    expect(mockClient.set).toHaveBeenCalledWith('mykey', 'myval');

    expect(await service.set('mykey', 'myval', 60)).toBe('OK');
    expect(mockClient.set).toHaveBeenCalledWith('mykey', 'myval', {
      expiry: { type: 'EX', count: 60 },
    });

    expect(await service.delete('mykey')).toBe(1);
    expect(mockClient.del).toHaveBeenCalledWith(['mykey']);

    await service.onModuleDestroy();
    expect(mockClient.close).toHaveBeenCalled();
    expect(service.getClient()).toBeNull();
  });
});
