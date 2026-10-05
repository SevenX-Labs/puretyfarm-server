jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { InternalServerErrorException } from '@nestjs/common';
import { PayuHashService } from './payu.hash.service';
import {
  PayuService,
  paiseToRupeeString,
  rupeeStringToPaise,
} from './payu.service';
import { PAYU_CHECKOUT_URL } from './payu.constants';
import { PaymentTransactionStatus } from '../../payments.constants';

const KEY = 'testmerchantkey';
const SALT = 'testmerchantsalt';
const API_BASE = 'https://api.example.com';

const env: Record<string, string> = {
  PAYU_KEY: KEY,
  PAYU_SALT: SALT,
  PUBLIC_API_BASE_URL: API_BASE,
};

describe('money conversion', () => {
  describe('paiseToRupeeString', () => {
    it.each([
      [100, '1.00'],
      [1, '0.01'],
      [50_000, '500.00'],
      [100_000, '1000.00'],
      [100_001, '1000.01'],
      [99, '0.99'],
      [123_456, '1234.56'],
    ])('converts %i paise to %s', (paise, expected) => {
      expect(paiseToRupeeString(paise)).toBe(expected);
    });

    it('never produces floating-point artefacts', () => {
      // 0.1 + 0.2 style drift is impossible because the conversion is integer
      // arithmetic plus string padding.
      for (let paise = 0; paise <= 1000; paise += 7) {
        expect(paiseToRupeeString(paise)).toMatch(/^\d+\.\d{2}$/);
      }
    });

    it('rejects a non-integer amount', () => {
      expect(() => paiseToRupeeString(10.5)).toThrow(
        InternalServerErrorException,
      );
    });

    it('rejects a negative amount', () => {
      expect(() => paiseToRupeeString(-100)).toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('rupeeStringToPaise', () => {
    it.each([
      ['1.00', 100],
      ['1', 100],
      ['1.5', 150],
      ['0.01', 1],
      ['1000.00', 100_000],
      ['1234.56', 123_456],
      [' 500.00 ', 50_000],
    ])('parses %s into %i paise', (amount, expected) => {
      expect(rupeeStringToPaise(amount)).toBe(expected);
    });

    it.each([
      ['1.005'],
      ['abc'],
      [''],
      ['-1.00'],
      ['1,000.00'],
      ['1e3'],
      ['Infinity'],
    ])('rejects the malformed amount %s', (amount) => {
      expect(rupeeStringToPaise(amount)).toBeNull();
    });

    it('round-trips every conversion', () => {
      for (const paise of [1, 99, 100, 50_000, 100_000, 123_456]) {
        expect(rupeeStringToPaise(paiseToRupeeString(paise))).toBe(paise);
      }
    });
  });
});

describe('PayuService', () => {
  let service: PayuService;
  let hashService: PayuHashService;
  let client: { verifyPayment: jest.Mock; refund: jest.Mock };

  const config = { get: (name: string) => env[name] };

  beforeEach(() => {
    hashService = new PayuHashService(config as any);
    client = { verifyPayment: jest.fn(), refund: jest.fn() };
    service = new PayuService(config as any, hashService, client as any);
  });

  // ── createPayment ─────────────────────────────────────────────────

  describe('createPayment', () => {
    const input = {
      transactionId: 'PFTEST0001',
      amountPaise: 100_000,
      productInfo: 'PuretyFarm Wallet Top-up',
      customerFirstName: 'Asha',
      customerEmail: 'asha@example.com',
      customerPhone: '9876543210',
    };

    it('targets the production hosted-checkout endpoint', async () => {
      const result = await service.createPayment(input);
      expect(result.endpoint).toBe(PAYU_CHECKOUT_URL);
      expect(result.endpoint).toBe('https://secure.payu.in/_payment');
      expect(result.method).toBe('POST');
    });

    it('returns every field PayU hosted checkout requires', async () => {
      const { fields } = await service.createPayment(input);
      for (const key of [
        'key',
        'txnid',
        'amount',
        'productinfo',
        'firstname',
        'email',
        'phone',
        'surl',
        'furl',
        'hash',
      ]) {
        expect(fields[key]).toBeDefined();
      }
    });

    it('converts paise to the rupee-decimal amount', async () => {
      const { fields } = await service.createPayment(input);
      expect(fields.amount).toBe('1000.00');
    });

    it('builds surl and furl from PUBLIC_API_BASE_URL, not from the client', async () => {
      const { fields } = await service.createPayment(input);
      expect(fields.surl).toBe(`${API_BASE}/api/v1/payments/payu/success`);
      expect(fields.furl).toBe(`${API_BASE}/api/v1/payments/payu/failure`);
    });

    it('computes a hash that the reverse verification path would accept', async () => {
      const { fields } = await service.createPayment(input);
      expect(fields.hash).toBe(
        hashService.generateRequestHash({
          key: KEY,
          txnid: input.transactionId,
          amount: '1000.00',
          productinfo: input.productInfo,
          firstname: input.customerFirstName,
          email: input.customerEmail,
        }),
      );
    });

    it('never returns the salt in any field', async () => {
      const { fields } = await service.createPayment(input);
      expect(JSON.stringify(fields)).not.toContain(SALT);
      expect(Object.values(fields)).not.toContain(SALT);
    });

    it('strips pipe characters that would shift hash segments', async () => {
      const { fields } = await service.createPayment({
        ...input,
        customerFirstName: 'As|ha',
      });
      expect(fields.firstname).toBe('As ha');
      expect(fields.firstname).not.toContain('|');
    });

    it('fails when PUBLIC_API_BASE_URL is absent rather than emitting a relative callback', async () => {
      const broken = new PayuService(
        {
          get: (n: string) =>
            n === 'PUBLIC_API_BASE_URL' ? undefined : env[n],
        } as any,
        hashService,
        client as any,
      );
      await expect(broken.createPayment(input)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('fails when PAYU_KEY is absent', async () => {
      const broken = new PayuService(
        { get: (n: string) => (n === 'PAYU_KEY' ? undefined : env[n]) } as any,
        hashService,
        client as any,
      );
      await expect(broken.createPayment(input)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // ── verifyPayment ─────────────────────────────────────────────────

  describe('verifyPayment', () => {
    const base = {
      key: KEY,
      txnid: 'PFTEST0001',
      amount: '1000.00',
      productinfo: 'PuretyFarm Wallet Top-up',
      firstname: 'Asha',
      email: 'asha@example.com',
      status: 'success',
      mihpayid: 'PAYU123456',
    };

    const sign = (payload: Record<string, unknown>): Record<string, any> => ({
      ...payload,
      hash: hashService.generateReverseHash(payload),
    });

    it('reports a correctly signed payload as valid and normalises it', async () => {
      const result = await service.verifyPayment(sign(base));
      expect(result.signatureValid).toBe(true);
      expect(result.transactionId).toBe('PFTEST0001');
      expect(result.providerPaymentId).toBe('PAYU123456');
      expect(result.amountPaise).toBe(100_000);
      expect(result.status).toBe(PaymentTransactionStatus.SUCCESS);
      expect(result.rawStatus).toBe('success');
    });

    it('reports an invalid signature without throwing', async () => {
      const result = await service.verifyPayment({ ...base, hash: 'bad' });
      expect(result.signatureValid).toBe(false);
    });

    it('reports an invalid signature for a tampered amount', async () => {
      const payload = sign(base);
      payload.amount = '1.00';
      const result = await service.verifyPayment(payload);
      expect(result.signatureValid).toBe(false);
      // The normalised amount still reflects what was CLAIMED, so the caller
      // can log the discrepancy; it is simply never trusted.
      expect(result.amountPaise).toBe(100);
    });

    it('maps PayU statuses onto the internal lifecycle', async () => {
      const cases: [string, PaymentTransactionStatus | null][] = [
        ['success', PaymentTransactionStatus.SUCCESS],
        ['SUCCESS', PaymentTransactionStatus.SUCCESS],
        ['failure', PaymentTransactionStatus.FAILED],
        ['pending', PaymentTransactionStatus.PROCESSING],
        ['in progress', PaymentTransactionStatus.PROCESSING],
        ['refunded', PaymentTransactionStatus.REFUNDED],
      ];
      for (const [raw, expected] of cases) {
        const result = await service.verifyPayment(
          sign({ ...base, status: raw }),
        );
        expect(result.status).toBe(expected);
      }
    });

    it('maps an unknown status to null rather than guessing success', async () => {
      const result = await service.verifyPayment(
        sign({ ...base, status: 'something-new' }),
      );
      expect(result.status).toBeNull();
      expect(result.rawStatus).toBe('something-new');
    });

    it('returns a null amount for a malformed amount string', async () => {
      const result = await service.verifyPayment(
        sign({ ...base, amount: 'abc' }),
      );
      expect(result.amountPaise).toBeNull();
    });

    it('extracts failure details from a failed payload', async () => {
      const result = await service.verifyPayment(
        sign({
          ...base,
          status: 'failure',
          error: 'E401',
          error_Message: 'Card declined',
        }),
      );
      expect(result.failureCode).toBe('E401');
      expect(result.failureMessage).toBe('Card declined');
    });

    it('strips the hash and card data from the persistable payload', async () => {
      const result = await service.verifyPayment(
        sign({ ...base, cardnum: '4111111111111111', ccname: 'ASHA' }),
      );
      expect(result.sanitisedPayload.hash).toBeUndefined();
      expect(result.sanitisedPayload.key).toBeUndefined();
      expect(result.sanitisedPayload.cardnum).toBeUndefined();
      expect(result.sanitisedPayload.ccname).toBeUndefined();
      expect(JSON.stringify(result.sanitisedPayload)).not.toContain(SALT);
      // Useful diagnostics survive.
      expect(result.sanitisedPayload.txnid).toBe('PFTEST0001');
      expect(result.sanitisedPayload.status).toBe('success');
    });

    it('drops nested objects from a forged payload', async () => {
      const result = await service.verifyPayment({
        ...base,
        nested: { a: 1 },
        list: [1, 2, 3],
      });
      expect(result.sanitisedPayload.nested).toBeUndefined();
      expect(result.sanitisedPayload.list).toBeUndefined();
    });

    it('handles a completely empty payload', async () => {
      const result = await service.verifyPayment({});
      expect(result.signatureValid).toBe(false);
      expect(result.transactionId).toBeNull();
      expect(result.status).toBeNull();
    });
  });

  // ── refundPayment ─────────────────────────────────────────────────

  describe('refundPayment', () => {
    it('asks the client for a refund with a rupee amount and a stable token', async () => {
      client.refund.mockResolvedValue({
        accepted: true,
        requestId: '9988',
        message: 'Refund Request Queued',
      });

      const result = await service.refundPayment({
        transactionId: 'PFTEST0001',
        providerPaymentId: 'PAYU123456',
        amountPaise: 100_000,
        reason: 'rejected',
      });

      expect(client.refund).toHaveBeenCalledWith({
        providerPaymentId: 'PAYU123456',
        refundToken: 'RFND-PFTEST0001',
        amountRupees: '1000.00',
      });
      expect(result.accepted).toBe(true);
      expect(result.providerRefundId).toBe('9988');
    });

    it('derives the same refund token on a repeat attempt so PayU dedupes it', async () => {
      client.refund.mockResolvedValue({
        accepted: true,
        requestId: '1',
        message: null,
      });
      const args = {
        transactionId: 'PFTEST0001',
        providerPaymentId: 'PAYU123456',
        amountPaise: 100_000,
        reason: 'rejected',
      };
      await service.refundPayment(args);
      await service.refundPayment(args);
      const [first, second] = client.refund.mock.calls;
      expect(first[0].refundToken).toBe(second[0].refundToken);
    });

    it('propagates a provider rejection as accepted=false', async () => {
      client.refund.mockResolvedValue({
        accepted: false,
        requestId: null,
        message: 'Refund not allowed',
      });
      const result = await service.refundPayment({
        transactionId: 'PFTEST0001',
        providerPaymentId: 'PAYU123456',
        amountPaise: 100_000,
        reason: 'rejected',
      });
      expect(result.accepted).toBe(false);
      expect(result.message).toBe('Refund not allowed');
    });
  });

  // ── fetchAuthoritativeStatus ──────────────────────────────────────

  describe('fetchAuthoritativeStatus', () => {
    it('reads the nested transaction_details entry', async () => {
      client.verifyPayment.mockResolvedValue({
        status: 1,
        transaction_details: {
          PFTEST0001: {
            status: 'success',
            mihpayid: 'PAYU123456',
            amt: '1000.00',
          },
        },
      });

      const result = await service.fetchAuthoritativeStatus('PFTEST0001');
      expect(result.status).toBe(PaymentTransactionStatus.SUCCESS);
      expect(result.providerPaymentId).toBe('PAYU123456');
      expect(result.amountPaise).toBe(100_000);
    });

    it('returns nulls when PayU knows nothing about the transaction', async () => {
      client.verifyPayment.mockResolvedValue({
        status: 1,
        transaction_details: {},
      });
      const result = await service.fetchAuthoritativeStatus('PFUNKNOWN');
      expect(result.status).toBeNull();
      expect(result.amountPaise).toBeNull();
    });

    it('handles a numeric amount from PayU', async () => {
      client.verifyPayment.mockResolvedValue({
        transaction_details: {
          PFTEST0001: { status: 'success', amount: 1000 },
        },
      });
      const result = await service.fetchAuthoritativeStatus('PFTEST0001');
      expect(result.amountPaise).toBe(100_000);
    });
  });
});
