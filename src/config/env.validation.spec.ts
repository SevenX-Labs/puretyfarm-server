import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const base = {
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    DATABASE_URL: 'postgresql://localhost/db',
    VALKEY_URL: 'rediss://localhost:6379',
  };

  it('accepts a complete, valid configuration', () => {
    expect(() => validateEnv({ ...base })).not.toThrow();
  });

  it('throws when JWT_ACCESS_SECRET is missing', () => {
    const { JWT_ACCESS_SECRET, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(/JWT_ACCESS_SECRET is required/);
  });

  it('throws when access and refresh secrets are identical', () => {
    expect(() =>
      validateEnv({
        ...base,
        JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET,
      }),
    ).toThrow(/must be different/);
  });

  it('throws when a secret is too short', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /at least 16 characters/,
    );
  });

  it('throws when DATABASE_URL or VALKEY_URL is missing', () => {
    const { VALKEY_URL, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(/VALKEY_URL is required/);
  });
});
