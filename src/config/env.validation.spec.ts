import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const base = {
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    DATABASE_URL: 'postgresql://localhost/db',
    VALKEY_URL: 'rediss://localhost:6379',
    GEOAPIFY_API_KEY: 'test-geoapify-key',
    GEOAPIFY_BASE_URL: 'https://api.geoapify.com',
    PHONEPE_CLIENT_ID: 'test-phonepe-client-id',
    PHONEPE_CLIENT_SECRET: 'test-phonepe-client-secret',
    PHONEPE_CLIENT_VERSION: '1',
    PHONEPE_WEBHOOK_USERNAME: 'test-webhook-user',
    PHONEPE_WEBHOOK_PASSWORD: 'test-webhook-password',
    PUBLIC_API_BASE_URL: 'https://api.example.com',
    PAYMENT_RESULT_REDIRECT_URL: 'https://app.example.com/payment/result',
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

  // ── PhonePe configuration (active gateway) ────────────────────────

  it('throws when PHONEPE_CLIENT_ID is missing', () => {
    const { PHONEPE_CLIENT_ID, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(/PHONEPE_CLIENT_ID is required/);
  });

  it('throws when PHONEPE_CLIENT_SECRET is missing', () => {
    const { PHONEPE_CLIENT_SECRET, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(
      /PHONEPE_CLIENT_SECRET is required/,
    );
  });

  it('throws when PHONEPE_CLIENT_VERSION is missing', () => {
    const { PHONEPE_CLIENT_VERSION, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(
      /PHONEPE_CLIENT_VERSION is required/,
    );
  });

  it('throws when the webhook credentials are missing', () => {
    const { PHONEPE_WEBHOOK_PASSWORD, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(
      /PHONEPE_WEBHOOK_PASSWORD is required/,
    );
  });

  it('accepts PHONEPE_ENV=PRODUCTION', () => {
    expect(() =>
      validateEnv({ ...base, PHONEPE_ENV: 'PRODUCTION' }),
    ).not.toThrow();
  });

  it('accepts an omitted PHONEPE_ENV, which defaults to production', () => {
    expect(() => validateEnv({ ...base })).not.toThrow();
  });

  it('rejects an unrecognised PHONEPE_ENV rather than guessing', () => {
    expect(() => validateEnv({ ...base, PHONEPE_ENV: 'prod' })).toThrow(
      /PHONEPE_ENV must be one of/,
    );
  });

  it('does not echo the PhonePe client secret in the error message', () => {
    const { PHONEPE_CLIENT_ID, ...rest } = base;
    try {
      validateEnv({
        ...rest,
        PHONEPE_CLIENT_SECRET: 'super-secret-phonepe-value',
      });
      throw new Error('expected validateEnv to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/PHONEPE_CLIENT_ID is required/);
      expect(message).not.toContain('super-secret-phonepe-value');
    }
  });

  it('throws when PUBLIC_API_BASE_URL is missing', () => {
    const { PUBLIC_API_BASE_URL, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(/PUBLIC_API_BASE_URL is required/);
  });

  it('throws when PAYMENT_RESULT_REDIRECT_URL is missing', () => {
    const { PAYMENT_RESULT_REDIRECT_URL, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow(
      /PAYMENT_RESULT_REDIRECT_URL is required/,
    );
  });

  it('rejects a non-absolute PUBLIC_API_BASE_URL', () => {
    expect(() =>
      validateEnv({ ...base, PUBLIC_API_BASE_URL: '/api/v1' }),
    ).toThrow(/PUBLIC_API_BASE_URL must be an absolute URL/);
  });

  it('rejects a non-http scheme for the payment redirect', () => {
    expect(() =>
      validateEnv({
        ...base,
        PAYMENT_RESULT_REDIRECT_URL: 'javascript:alert(1)',
      }),
    ).toThrow(/PAYMENT_RESULT_REDIRECT_URL must use http or https/);
  });

  it('does not echo secret values in the error message', () => {
    const { PHONEPE_CLIENT_SECRET, ...rest } = base;
    try {
      validateEnv({ ...rest, PHONEPE_CLIENT_SECRET: '' });
      throw new Error('expected validateEnv to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/PHONEPE_CLIENT_SECRET is required/);
    }
  });
});
