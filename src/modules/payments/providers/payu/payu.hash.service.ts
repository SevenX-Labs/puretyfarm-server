import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { PayuCallbackPayload, PayuRequestHashInput } from './payu.types';

/**
 * The ONLY place in the codebase where a PayU SHA-512 formula is written.
 *
 * PAYU_SALT is read from configuration on demand and is never logged, returned,
 * persisted, or exposed on this class as a readable property.
 */
@Injectable()
export class PayuHashService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Reads the signing secret. Startup validation guarantees it exists; a
   * missing value here means the process was started outside the validated
   * ConfigModule, which is a server misconfiguration, not a client error.
   *
   * The returned value is never included in an exception message.
   */
  private getSalt(): string {
    const salt = this.configService.get<string>('PAYU_SALT');
    if (!salt) {
      throw new InternalServerErrorException(
        'Payment provider is not configured',
      );
    }
    return salt;
  }

  private sha512(input: string): string {
    return createHash('sha512').update(input, 'utf8').digest('hex');
  }

  /**
   * Forward (request) hash posted to Hosted Checkout:
   *
   *   sha512(key|txnid|amount|productinfo|firstname|email|
   *          udf1|udf2|udf3|udf4|udf5||||||SALT)
   *
   * The five trailing empty segments are PayU's reserved fields and must be
   * present even though they are always blank for this integration.
   */
  generateRequestHash(input: PayuRequestHashInput): string {
    const segments = [
      input.key,
      input.txnid,
      input.amount,
      input.productinfo,
      input.firstname,
      input.email,
      input.udf1 ?? '',
      input.udf2 ?? '',
      input.udf3 ?? '',
      input.udf4 ?? '',
      input.udf5 ?? '',
      '',
      '',
      '',
      '',
      '',
      this.getSalt(),
    ];
    return this.sha512(segments.join('|'));
  }

  /**
   * Reverse hash PayU returns in callbacks and webhooks:
   *
   *   sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|
   *          email|firstname|productinfo|amount|txnid|key)
   *
   * When PayU includes `additionalCharges`, that value is prepended to the
   * string before SALT. Both spellings PayU uses are accepted.
   *
   * Every value comes from the untrusted payload, which is the point: the hash
   * only matches if PayU signed these exact values with the shared salt, so a
   * tampered amount, txnid or status produces a mismatch.
   */
  generateReverseHash(payload: PayuCallbackPayload): string {
    const udf = (key: keyof PayuCallbackPayload): string => {
      const value = payload[key];
      return typeof value === 'string' ? value : '';
    };

    const segments = [
      this.getSalt(),
      payload.status ?? '',
      '',
      '',
      '',
      '',
      '',
      udf('udf5'),
      udf('udf4'),
      udf('udf3'),
      udf('udf2'),
      udf('udf1'),
      payload.email ?? '',
      payload.firstname ?? '',
      payload.productinfo ?? '',
      payload.amount ?? '',
      payload.txnid ?? '',
      payload.key ?? '',
    ];

    const additionalCharges =
      typeof payload.additionalCharges === 'string' &&
      payload.additionalCharges.length > 0
        ? payload.additionalCharges
        : typeof payload.additional_charges === 'string' &&
            payload.additional_charges.length > 0
          ? payload.additional_charges
          : null;

    const base = segments.join('|');
    return this.sha512(
      additionalCharges ? `${additionalCharges}|${base}` : base,
    );
  }

  /**
   * Verifies the `hash` field of an untrusted PayU payload against a hash
   * recomputed from the payload's own values.
   *
   * Returns false (never throws) for a missing, malformed or mismatched hash so
   * callers handle all rejection reasons on one path.
   */
  verifyReverseHash(payload: PayuCallbackPayload): boolean {
    const received = payload.hash;
    if (typeof received !== 'string' || received.length === 0) {
      return false;
    }
    return this.safeCompare(received, this.generateReverseHash(payload));
  }

  /**
   * Merchant post-service command hash:
   *
   *   sha512(key|command|var1|SALT)
   */
  generateCommandHash(key: string, command: string, var1: string): string {
    return this.sha512([key, command, var1, this.getSalt()].join('|'));
  }

  /**
   * Constant-time hex comparison. Lower-cased first because PayU is not
   * consistent about hash casing, then length-checked, because
   * `timingSafeEqual` throws on unequal buffer lengths.
   */
  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a.trim().toLowerCase(), 'utf8');
    const bufB = Buffer.from(b.trim().toLowerCase(), 'utf8');
    if (bufA.length !== bufB.length) {
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }
}
