jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock('@nestjs/jwt', () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateCreditRequestDto } from './dto/customer/create-credit-request.dto';
import { ListTransactionsQueryDto } from './dto/customer/list-transactions-query.dto';
import { ListCreditRequestsQueryDto } from './dto/customer/list-credit-requests-query.dto';

describe('WalletController (Customer)', () => {
  let controller: WalletController;

  const mockService = {
    getWallet: jest.fn().mockResolvedValue({ balancePaise: 0 }),
    createCreditRequest: jest
      .fn()
      .mockResolvedValue({ id: 'req-1', status: 'PENDING' }),
    getTransactions: jest.fn().mockResolvedValue({ data: [] }),
    getCreditRequests: jest.fn().mockResolvedValue({ data: [] }),
  };

  const customerJwt = {
    sub: 'user-1',
    role: 'CUSTOMER',
    sessionId: 'session-1',
    type: 'access' as const,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletController],
      providers: [{ provide: WalletService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(WalletController);
  });

  it('is protected by JwtAuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', WalletController);
    expect(guards).toContain(JwtAuthGuard);
  });

  describe('getWallet uses JWT.sub', () => {
    it('passes user.sub to service', async () => {
      await controller.getWallet(customerJwt);
      expect(mockService.getWallet).toHaveBeenCalledWith('user-1');
    });
  });

  describe('createCreditRequest', () => {
    it('uses user.sub and passes idempotency key', async () => {
      const dto = { amount: 5000 };
      await controller.createCreditRequest(customerJwt, dto, 'key-123');
      expect(mockService.createCreditRequest).toHaveBeenCalledWith(
        'user-1',
        dto,
        'key-123',
      );
    });

    it('rejects missing Idempotency-Key header', async () => {
      await expect(
        controller.createCreditRequest(customerJwt, { amount: 5000 }, ''),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects null Idempotency-Key header', async () => {
      await expect(
        controller.createCreditRequest(
          customerJwt,
          { amount: 5000 },
          null as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getTransactions uses JWT.sub', () => {
    it('passes user.sub to service', async () => {
      await controller.getTransactions(customerJwt, {});
      expect(mockService.getTransactions).toHaveBeenCalledWith('user-1', {});
    });
  });

  describe('getCreditRequests uses JWT.sub', () => {
    it('passes user.sub to service', async () => {
      await controller.getCreditRequests(customerJwt, {});
      expect(mockService.getCreditRequests).toHaveBeenCalledWith('user-1', {});
    });
  });

  describe('DTO validation', () => {
    async function errorsFor(cls: any, payload: any) {
      return validate(plainToInstance(cls, payload));
    }

    it('CreateCreditRequestDto rejects non-integer amount', async () => {
      expect(
        (await errorsFor(CreateCreditRequestDto, { amount: 50.5 })).length,
      ).toBeGreaterThan(0);
    });

    it('CreateCreditRequestDto rejects zero amount', async () => {
      expect(
        (await errorsFor(CreateCreditRequestDto, { amount: 0 })).length,
      ).toBeGreaterThan(0);
    });

    it('CreateCreditRequestDto rejects negative amount', async () => {
      expect(
        (await errorsFor(CreateCreditRequestDto, { amount: -100 })).length,
      ).toBeGreaterThan(0);
    });

    it('CreateCreditRequestDto accepts valid integer paise', async () => {
      expect(
        await errorsFor(CreateCreditRequestDto, { amount: 5000 }),
      ).toHaveLength(0);
    });

    it('ListTransactionsQueryDto accepts empty query', async () => {
      expect(await errorsFor(ListTransactionsQueryDto, {})).toHaveLength(0);
    });

    it('ListTransactionsQueryDto rejects invalid type', async () => {
      expect(
        (await errorsFor(ListTransactionsQueryDto, { type: 'INVALID' })).length,
      ).toBeGreaterThan(0);
    });

    it('ListTransactionsQueryDto accepts valid type filter', async () => {
      expect(
        await errorsFor(ListTransactionsQueryDto, { type: 'CREDIT' }),
      ).toHaveLength(0);
    });

    it('ListCreditRequestsQueryDto rejects invalid status', async () => {
      expect(
        (await errorsFor(ListCreditRequestsQueryDto, { status: 'INVALID' }))
          .length,
      ).toBeGreaterThan(0);
    });

    it('ListCreditRequestsQueryDto accepts valid status filter', async () => {
      expect(
        await errorsFor(ListCreditRequestsQueryDto, { status: 'PENDING' }),
      ).toHaveLength(0);
    });
  });
});
