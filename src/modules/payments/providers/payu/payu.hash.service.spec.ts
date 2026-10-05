// @nestjs/config ships ESM-only; mock it so the CommonJS test runner can load
// services that inject ConfigService. Behaviour is supplied per-test.
jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { createHash } from 'crypto';
import { InternalServerErrorException } from '@nestjs/common';
import { PayuHashService } from './payu.hash.service';

const KEY = 'testmerchantkey';
const SALT = 'testmerchantsalt';

const sha512 = (value: string) =>
  createHash('sha512').update(value, 'utf8').digest('hex');

describe('PayuHashService', () => {
  let service: PayuHashService;

  const config = {
    get: (name: string) => (name === 'PAYU_SALT' ? SALT : undefined),
  };

  beforeEach(() => {
    service = new PayuHashService(config as any);
  });

  // ── Request hash ──────────────────────────────────────────────────

  describe('generateRequestHash', () => {
    const input = {
      key: KEY,
      txnid: 'PFTEST0001',
      amount: '1000.00',
      productinfo: 'PuretyFarm Wallet Top-up',
      firstname: 'Asha',
      email: 'asha@example.com',
    };

    it('computes the documented forward formula', () => {
      // key|txnid|amount|productinfo|firstname|email|udf1..udf5|5 empties|SALT
      const expected = sha512(
        [
          KEY,
          'PFTEST0001',
          '1000.00',
          'PuretyFarm Wallet Top-up',
          'Asha',
          'asha@example.com',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          SALT,
        ].join('|'),
      );
      expect(service.generateRequestHash(input)).toBe(expected);
    });

    it('produces a 128-character lowercase hex digest', () => {
      expect(service.generateRequestHash(input)).toMatch(/^[0-9a-f]{128}$/);
    });

    it('changes when the amount changes', () => {
      const tampered = service.generateRequestHash({
        ...input,
        amount: '1.00',
      });
      expect(tampered).not.toBe(service.generateRequestHash(input));
    });

    it('changes when the transaction id changes', () => {
      expect(
        service.generateRequestHash({ ...input, txnid: 'PFTEST0002' }),
      ).not.toBe(service.generateRequestHash(input));
    });

    it('is deterministic for identical input', () => {
      expect(service.generateRequestHash(input)).toBe(
        service.generateRequestHash(input),
      );
    });

    it('does not leak the salt into the digest input ordering', () => {
      // A hash computed with a DIFFERENT salt must not match, proving the salt
      // actually participates.
      const other = new PayuHashService({
        get: (name: string) => (name === 'PAYU_SALT' ? 'othersalt' : undefined),
      } as any);
      expect(other.generateRequestHash(input)).not.toBe(
        service.generateRequestHash(input),
      );
    });

    it('fails loudly when the salt is not configured', () => {
      const unconfigured = new PayuHashService({
        get: () => undefined,
      } as any);
      expect(() => unconfigured.generateRequestHash(input)).toThrow(
        InternalServerErrorException,
      );
    });

    it('never includes the salt value in the configuration error', () => {
      const unconfigured = new PayuHashService({ get: () => undefined } as any);
      try {
        unconfigured.generateRequestHash(input);
        throw new Error('expected a throw');
      } catch (error) {
        expect(JSON.stringify((error as Error).message)).not.toContain(SALT);
      }
    });
  });

  // ── Reverse hash ──────────────────────────────────────────────────

  describe('generateReverseHash / verifyReverseHash', () => {
    const basePayload = {
      key: KEY,
      txnid: 'PFTEST0001',
      amount: '1000.00',
      productinfo: 'PuretyFarm Wallet Top-up',
      firstname: 'Asha',
      email: 'asha@example.com',
      status: 'success',
    };

    const signed = (payload: Record<string, unknown>): Record<string, any> => ({
      ...payload,
      hash: service.generateReverseHash(payload),
    });

    it('computes the documented reverse formula', () => {
      const expected = sha512(
        [
          SALT,
          'success',
          '',
          '',
          '',
          '',
          '',
          '', // udf5
          '', // udf4
          '', // udf3
          '', // udf2
          '', // udf1
          'asha@example.com',
          'Asha',
          'PuretyFarm Wallet Top-up',
          '1000.00',
          'PFTEST0001',
          KEY,
        ].join('|'),
      );
      expect(service.generateReverseHash(basePayload as any)).toBe(expected);
    });

    it('accepts a correctly signed payload', () => {
      expect(service.verifyReverseHash(signed(basePayload) as any)).toBe(true);
    });

    it('accepts an upper-cased hash (PayU is inconsistent about casing)', () => {
      const payload = signed(basePayload);
      payload.hash = payload.hash.toUpperCase();
      expect(service.verifyReverseHash(payload as any)).toBe(true);
    });

    it('rejects an outright incorrect hash', () => {
      expect(
        service.verifyReverseHash({ ...basePayload, hash: 'deadbeef' } as any),
      ).toBe(false);
    });

    it('rejects a missing hash', () => {
      expect(service.verifyReverseHash(basePayload as any)).toBe(false);
    });

    it('rejects a non-string hash', () => {
      expect(
        service.verifyReverseHash({ ...basePayload, hash: 12345 } as any),
      ).toBe(false);
    });

    it('rejects a tampered amount', () => {
      const payload = signed(basePayload);
      payload.amount = '1.00';
      expect(service.verifyReverseHash(payload as any)).toBe(false);
    });

    it('rejects a tampered transaction id', () => {
      const payload = signed(basePayload);
      payload.txnid = 'PFSOMEONEELSE';
      expect(service.verifyReverseHash(payload as any)).toBe(false);
    });

    it('rejects a tampered status (failure forged into success)', () => {
      const payload = signed({ ...basePayload, status: 'failure' });
      payload.status = 'success';
      expect(service.verifyReverseHash(payload as any)).toBe(false);
    });

    it('rejects a tampered email', () => {
      const payload = signed(basePayload);
      payload.email = 'attacker@example.com';
      expect(service.verifyReverseHash(payload as any)).toBe(false);
    });

    it('rejects a payload signed with the wrong salt', () => {
      const attacker = new PayuHashService({
        get: () => 'wrongsalt',
      } as any);
      const forged = {
        ...basePayload,
        hash: attacker.generateReverseHash(basePayload),
      };
      expect(service.verifyReverseHash(forged as any)).toBe(false);
    });

    it('includes udf fields in reverse order when present', () => {
      const withUdf = { ...basePayload, udf1: 'a', udf5: 'e' };
      const expected = sha512(
        [
          SALT,
          'success',
          '',
          '',
          '',
          '',
          '',
          'e',
          '',
          '',
          '',
          'a',
          'asha@example.com',
          'Asha',
          'PuretyFarm Wallet Top-up',
          '1000.00',
          'PFTEST0001',
          KEY,
        ].join('|'),
      );
      expect(service.generateReverseHash(withUdf as any)).toBe(expected);
      expect(service.verifyReverseHash(signed(withUdf) as any)).toBe(true);
    });

    it('prefixes additionalCharges when PayU sends it', () => {
      const payload = { ...basePayload, additionalCharges: '10.00' };
      const withoutPrefix = service.generateReverseHash(basePayload);
      expect(service.generateReverseHash(payload as any)).not.toBe(
        withoutPrefix,
      );
      expect(service.verifyReverseHash(signed(payload) as any)).toBe(true);
    });

    it('accepts the snake_case additional_charges spelling', () => {
      const payload = { ...basePayload, additional_charges: '10.00' };
      expect(service.verifyReverseHash(signed(payload) as any)).toBe(true);
    });

    it('rejects a payload where additionalCharges was stripped after signing', () => {
      const payload = signed({ ...basePayload, additionalCharges: '10.00' });
      delete (payload as Record<string, unknown>).additionalCharges;
      expect(service.verifyReverseHash(payload as any)).toBe(false);
    });
  });

  // ── Command hash ──────────────────────────────────────────────────

  describe('generateCommandHash', () => {
    it('computes key|command|var1|SALT', () => {
      expect(
        service.generateCommandHash(KEY, 'verify_payment', 'PFTEST0001'),
      ).toBe(sha512([KEY, 'verify_payment', 'PFTEST0001', SALT].join('|')));
    });

    it('differs per command', () => {
      expect(
        service.generateCommandHash(KEY, 'verify_payment', 'PFTEST0001'),
      ).not.toBe(
        service.generateCommandHash(
          KEY,
          'cancel_refund_transaction',
          'PFTEST0001',
        ),
      );
    });
  });

  // ── Secret containment ────────────────────────────────────────────

  it('exposes no readable property holding the salt', () => {
    // Guards against a future refactor caching the salt on the instance,
    // which would make it reachable from a serialised error or a log dump.
    const values = Object.values(service as unknown as Record<string, unknown>);
    expect(values).not.toContain(SALT);
    expect(JSON.stringify(service)).not.toContain(SALT);
  });
});
