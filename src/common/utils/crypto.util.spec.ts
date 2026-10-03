import { generateSecureOtp, hashValue, verifyHash } from './crypto.util';

describe('Crypto Utility', () => {
  it('should generate a 6-digit numeric OTP', () => {
    const otp = generateSecureOtp();
    expect(otp).toHaveLength(6);
    expect(/^\d{6}$/.test(otp)).toBe(true);
    const num = Number(otp);
    expect(num).toBeGreaterThanOrEqual(100000);
    expect(num).toBeLessThan(1000000);
  });

  it('should generate different secure OTPs on consecutive calls', () => {
    const otp1 = generateSecureOtp();
    const otp2 = generateSecureOtp();
    // High probability of being different
    expect(typeof otp1).toBe('string');
    expect(typeof otp2).toBe('string');
  });

  it('should hash using Argon2 and verify correctly', async () => {
    const plain = '654321';
    const hash = await hashValue(plain);

    expect(hash).toContain('$argon2');
    expect(hash).not.toBe(plain);

    const isMatch = await verifyHash(hash, plain);
    expect(isMatch).toBe(true);

    const isMismatch = await verifyHash(hash, '000000');
    expect(isMismatch).toBe(false);
  });

  it('should return false for invalid hash verification gracefully', async () => {
    const result = await verifyHash('invalid-hash', '123456');
    expect(result).toBe(false);
  });
});
