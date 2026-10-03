import * as crypto from 'crypto';
import * as argon2 from 'argon2';

/**
 * Generates a cryptographically secure 6-digit numeric OTP.
 * Uses crypto.randomInt() - NEVER Math.random().
 */
export function generateSecureOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Hashes a value using Argon2.
 */
export async function hashValue(value: string): Promise<string> {
  return await argon2.hash(value);
}

/**
 * Verifies a plain value against an Argon2 hash.
 */
export async function verifyHash(
  hash: string,
  plainValue: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plainValue);
  } catch {
    return false;
  }
}
