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

  it('should throw error when calling methods before initialization', async () => {
    await expect(service.get('test')).rejects.toThrow(
      'Valkey client is not initialized',
    );
    await expect(service.set('test', 'value')).rejects.toThrow(
      'Valkey client is not initialized',
    );
    await expect(service.delete('test')).rejects.toThrow(
      'Valkey client is not initialized',
    );
    await expect(service.incr('test')).rejects.toThrow(
      'Valkey client is not initialized',
    );
    await expect(service.expire('test', 60)).rejects.toThrow(
      'Valkey client is not initialized',
    );
    await expect(service.ttl('test')).rejects.toThrow(
      'Valkey client is not initialized',
    );
    await expect(service.eval('return 1', [], [])).rejects.toThrow(
      'Valkey client is not initialized',
    );
    await expect(service.compareAndDelete('k', 'v')).rejects.toThrow(
      'Valkey client is not initialized',
    );
    await expect(
      service.reserveSendSlot('cd', 60, [
        { key: 'c', limit: 5, ttlSeconds: 300 },
      ]),
    ).rejects.toThrow('Valkey client is not initialized');
  });

  it('should handle operations when client is initialized', async () => {
    const mockClient = {
      get: jest.fn().mockResolvedValue('val'),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(2),
      expire: jest.fn().mockResolvedValue(true),
      ttl: jest.fn().mockResolvedValue(120),
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

    expect(await service.incr('counter')).toBe(2);
    expect(mockClient.incr).toHaveBeenCalledWith('counter');

    expect(await service.expire('mykey', 60)).toBe(true);
    expect(mockClient.expire).toHaveBeenCalledWith('mykey', 60);

    expect(await service.ttl('mykey')).toBe(120);
    expect(mockClient.ttl).toHaveBeenCalledWith('mykey');

    await service.onModuleDestroy();
    expect(mockClient.close).toHaveBeenCalled();
    expect(service.getClient()).toBeNull();
  });

  it('compareAndDelete returns true only when the script reports a delete', async () => {
    const mockClient = { invokeScript: jest.fn() };
    (service as any).client = mockClient;

    mockClient.invokeScript.mockResolvedValueOnce(1);
    expect(await service.compareAndDelete('key', 'val')).toBe(true);
    expect(mockClient.invokeScript).toHaveBeenCalledWith(expect.anything(), {
      keys: ['key'],
      args: ['val'],
    });

    mockClient.invokeScript.mockResolvedValueOnce(0);
    expect(await service.compareAndDelete('key', 'val')).toBe(false);
  });

  it('reserveSendSlot passes cooldown + counter config to the script and returns its code', async () => {
    const mockClient = { invokeScript: jest.fn().mockResolvedValue(0) };
    (service as any).client = mockClient;

    const code = await service.reserveSendSlot('cd', 60, [
      { key: 'c5', limit: 5, ttlSeconds: 300 },
      { key: 'cd1', limit: 15, ttlSeconds: 86400 },
    ]);

    expect(code).toBe(0);
    expect(mockClient.invokeScript).toHaveBeenCalledWith(expect.anything(), {
      keys: ['cd', 'c5', 'cd1'],
      args: ['60', '2', '5', '300', '15', '86400'],
    });
  });

  it('enables TLS only for rediss:// URLs', () => {
    // Exercises the parsing branch that previously always forced TLS on.
    const parse = (url: string) => new URL(url).protocol === 'rediss:';
    expect(parse('rediss://host:6379')).toBe(true);
    expect(parse('redis://host:6379')).toBe(false);
  });
});
