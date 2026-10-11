import * as crypto from 'crypto';
import * as argon2 from 'argon2';

/**
 * Fast, keyed hashing for short-lived machine-generated secrets: one-time
 * passwords and refresh tokens.
 *
 * Why not Argon2 (see crypto.util.ts) for these?
 * Argon2 is deliberately slow and memory-hard because a *password* is
 * low-entropy, long-lived and attackable offline at the attacker's own pace.
 * Neither value hashed here has that shape:
 *
 * - An OTP is 6 random digits that live in Valkey for 5 minutes behind a
 *   5-attempt counter and a per-mobile send limit. Its resistance to guessing
 *   comes from those limits, not from the hash cost — nobody gets 10^6 tries.
 * - A refresh token is a signed JWT carrying >=256 bits of entropy. There is
 *   no dictionary to run against it.
 *
 * What both cases do need is that a *database or cache dump alone* must not
 * yield usable credentials. An unkeyed digest would allow that for the OTP
 * (10^6 candidates is a one-second rainbow table), so the digest is keyed with
 * a server-side pepper that lives only in the environment, and bound to a
 * caller-supplied context (the mobile number, the user id) so a hash lifted
 * from one subject cannot be replayed against another.
 *
 * Cost, measured on the dev machine: ~0.03ms here versus ~150ms for Argon2 at
 * its library defaults (64 MiB, t=3, p=4) — and the Argon2 call also pins a
 * libuv thread and 64 MiB for its duration, which is what starved concurrent
 * database work in the OTP flow.
 *
 * Admin passwords keep using Argon2. They are exactly the low-entropy,
 * long-lived, human-chosen case it is built for.
 */

// Hash format marker, so a stored value is self-describing and the scheme can
// be rotated later without guessing what produced an existing row.
const PREFIX = 'h1:';

// Argon2 encodes its parameters in the hash itself and always starts with this.
const ARGON2_PREFIX = '$argon2';

const HKDF_INFO = 'puretyfarm/secret-hash/v1';

let cachedKey: Buffer | null = null;
let cachedPepper: string | null = null;

/**
 * Derives the HMAC key from the pepper.
 *
 * `OTP_HASH_SECRET` is optional: when it is absent the key is derived from
 * `JWT_ACCESS_SECRET` (which startup validation already requires) through
 * HKDF with a fixed, purpose-specific `info` string. HKDF's domain separation
 * is what makes that reuse safe — the derived key cannot be used to sign or
 * verify JWTs, and vice versa — so no deployment has to add a new secret
 * before this code can run.
 */
function getKey(): Buffer {
  const pepper =
    process.env.OTP_HASH_SECRET?.trim() ||
    process.env.JWT_ACCESS_SECRET?.trim();

  if (!pepper) {
    // Startup validation enforces JWT_ACCESS_SECRET; never fall back to an
    // unkeyed digest, which would make a cache dump brute-forceable.
    throw new Error('Secret hashing is not configured');
  }

  // Re-derive if the environment changed under us (tests do this).
  if (cachedKey && cachedPepper === pepper) {
    return cachedKey;
  }

  cachedKey = Buffer.from(
    crypto.hkdfSync('sha256', pepper, Buffer.alloc(0), HKDF_INFO, 32),
  );
  cachedPepper = pepper;
  return cachedKey;
}

function digest(value: string, context: string): string {
  // The context is length-prefixed so that ('ab', 'c') and ('a', 'bc') cannot
  // produce the same message.
  const mac = crypto.createHmac('sha256', getKey());
  mac.update(`${context.length}:${context}:${value}`, 'utf8');
  return mac.digest('base64url');
}

/**
 * Hashes a short-lived secret, bound to `context` (e.g. the normalized mobile
 * number for a login OTP, or the user id for an email OTP). Pass the same
 * context to `verifySecret`.
 */
export function hashSecret(value: string, context: string): string {
  return PREFIX + digest(value, context);
}

/**
 * Verifies a value against a hash produced by `hashSecret`, in constant time.
 *
 * Argon2 hashes are still accepted so that credentials issued by the previous
 * scheme keep working: refresh tokens live for 90 days, and an OTP issued
 * seconds before a rolling deploy must remain verifiable. Those hashes are
 * replaced with the new format whenever the credential is rotated or reissued.
 */
export async function verifySecret(
  storedHash: string,
  value: string,
  context: string,
): Promise<boolean> {
  if (storedHash.startsWith(ARGON2_PREFIX)) {
    try {
      return await argon2.verify(storedHash, value);
    } catch {
      return false;
    }
  }

  if (!storedHash.startsWith(PREFIX)) {
    return false;
  }

  const expected = Buffer.from(hashSecret(value, context), 'utf8');
  const actual = Buffer.from(storedHash, 'utf8');
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * True when `storedHash` was produced by the superseded Argon2 scheme. Callers
 * that can cheaply re-hash the credential use this to upgrade it in place.
 */
export function isLegacySecretHash(storedHash: string): boolean {
  return storedHash.startsWith(ARGON2_PREFIX);
}
