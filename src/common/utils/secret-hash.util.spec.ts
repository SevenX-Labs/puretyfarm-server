import {
  hashSecret,
  verifySecret,
  isLegacySecretHash,
} from './secret-hash.util';
import { hashValue } from './crypto.util';

describe('secret-hash.util', () => {
  const OTP = '123456';
  const CONTEXT = 'customer-otp:+919876543210';

  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = 'test-access-secret-at-least-16-chars';
    delete process.env.OTP_HASH_SECRET;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('produces a prefixed hash that does not contain the secret', () => {
    const hash = hashSecret(OTP, CONTEXT);

    expect(hash.startsWith('h1:')).toBe(true);
    expect(hash).not.toContain(OTP);
  });

  it('is deterministic for the same value and context', () => {
    expect(hashSecret(OTP, CONTEXT)).toBe(hashSecret(OTP, CONTEXT));
  });

  it('verifies the matching value', async () => {
    await expect(
      verifySecret(hashSecret(OTP, CONTEXT), OTP, CONTEXT),
    ).resolves.toBe(true);
  });

  it('rejects a different value', async () => {
    await expect(
      verifySecret(hashSecret(OTP, CONTEXT), '654321', CONTEXT),
    ).resolves.toBe(false);
  });

  // The context binding is what stops a hash lifted from one subject's cache
  // entry from being replayed against another's.
  it('rejects the right value under a different context', async () => {
    const hash = hashSecret(OTP, CONTEXT);

    expect(hashSecret(OTP, 'customer-otp:+910000000000')).not.toBe(hash);
    await expect(
      verifySecret(hash, OTP, 'customer-otp:+910000000000'),
    ).resolves.toBe(false);
  });

  it('separates contexts that concatenate to the same string', () => {
    expect(hashSecret(OTP, 'ab')).not.toBe(hashSecret(OTP, 'a'));
    expect(hashSecret('b' + OTP, 'a')).not.toBe(hashSecret(OTP, 'ab'));
  });

  // Without the pepper the digest of a 6-digit OTP would be trivially
  // reversible from a cache dump, so a changed key must invalidate hashes.
  it('is keyed: a different pepper produces a different hash', () => {
    const withDerivedKey = hashSecret(OTP, CONTEXT);

    process.env.OTP_HASH_SECRET = 'a-dedicated-otp-pepper-value';
    const withDedicatedKey = hashSecret(OTP, CONTEXT);

    expect(withDedicatedKey).not.toBe(withDerivedKey);
  });

  it('fails closed when no pepper is configured', () => {
    delete process.env.JWT_ACCESS_SECRET;
    delete process.env.OTP_HASH_SECRET;

    expect(() => hashSecret(OTP, CONTEXT)).toThrow(
      'Secret hashing is not configured',
    );
  });

  it('rejects a hash in an unrecognised format', async () => {
    await expect(
      verifySecret('plain-text', 'plain-text', CONTEXT),
    ).resolves.toBe(false);
  });

  // Refresh tokens live for 90 days and an OTP can outlive a rolling deploy,
  // so hashes written by the previous Argon2 scheme must still verify.
  describe('legacy Argon2 hashes', () => {
    it('verifies a value against an Argon2 hash', async () => {
      const legacy = await hashValue(OTP);

      expect(isLegacySecretHash(legacy)).toBe(true);
      await expect(verifySecret(legacy, OTP, CONTEXT)).resolves.toBe(true);
      await expect(verifySecret(legacy, '654321', CONTEXT)).resolves.toBe(
        false,
      );
    });

    it('does not treat a current-scheme hash as legacy', () => {
      expect(isLegacySecretHash(hashSecret(OTP, CONTEXT))).toBe(false);
    });
  });
});
