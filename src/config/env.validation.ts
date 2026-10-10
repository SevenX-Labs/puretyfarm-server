/**
 * Startup environment validation.
 *
 * Runs once when ConfigModule boots. If a required secret is missing or
 * misconfigured the application fails to start instead of silently falling
 * back to an insecure default. No secret values are ever logged here.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];

  const requireNonEmpty = (key: string): string => {
    const value = config[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`${key} is required and must be a non-empty string`);
      return '';
    }
    return value;
  };

  const accessSecret = requireNonEmpty('JWT_ACCESS_SECRET');
  const refreshSecret = requireNonEmpty('JWT_REFRESH_SECRET');

  // Access and refresh tokens MUST be signed with different secrets so that a
  // leaked access secret cannot be used to forge refresh tokens (and vice versa).
  if (accessSecret && refreshSecret && accessSecret === refreshSecret) {
    errors.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
  }

  // Enforce a minimum length so obviously weak secrets are rejected early.
  const MIN_SECRET_LENGTH = 16;
  if (accessSecret && accessSecret.length < MIN_SECRET_LENGTH) {
    errors.push(
      `JWT_ACCESS_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  if (refreshSecret && refreshSecret.length < MIN_SECRET_LENGTH) {
    errors.push(
      `JWT_REFRESH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  requireNonEmpty('DATABASE_URL');
  requireNonEmpty('VALKEY_URL');

  // Geoapify reverse-geocoding credentials. Required so the server fails fast
  // at boot rather than at the first /locations/detect call. The key value is
  // never logged.
  requireNonEmpty('GEOAPIFY_API_KEY');
  requireNonEmpty('GEOAPIFY_BASE_URL');

  // PhonePe merchant credentials (the ACTIVE payment gateway). Required so a
  // misconfigured deployment fails at boot rather than when a customer tries
  // to pay. The secrets are read here only to assert presence, and are never
  // logged, persisted, or returned in any API response.
  requireNonEmpty('PHONEPE_CLIENT_ID');
  requireNonEmpty('PHONEPE_CLIENT_SECRET');
  requireNonEmpty('PHONEPE_CLIENT_VERSION');

  // PhonePe webhook credentials, as configured against the webhook URL in the
  // PhonePe dashboard. PhonePe authenticates each webhook by setting the
  // Authorization header to SHA256(username:password), so without these the
  // webhook endpoint cannot authenticate anything and would reject every
  // event. Required at boot for exactly that reason.
  requireNonEmpty('PHONEPE_WEBHOOK_USERNAME');
  requireNonEmpty('PHONEPE_WEBHOOK_PASSWORD');

  // PhonePe environment selector. Optional: the provider defaults to
  // PRODUCTION, so an unset value never silently points live traffic at the
  // sandbox. Validated only when present, so a typo cannot do so either.
  const phonePeEnv = config['PHONEPE_ENV'];
  if (phonePeEnv !== undefined) {
    const allowed = ['PRODUCTION', 'SANDBOX', 'UAT', 'PREPROD'];
    if (
      typeof phonePeEnv !== 'string' ||
      !allowed.includes(phonePeEnv.trim().toUpperCase())
    ) {
      errors.push(`PHONEPE_ENV must be one of: ${allowed.join(', ')}`);
    }
  }

  // PayU removed - PhonePe is the single active online payment gateway.

  // Public base URL of THIS API. Used to build the gateway's browser return
  // URL server-side (PhonePe `redirectUrl`, formerly PayU `surl`/`furl`) so a
  // client can never redirect a payment result anywhere of its choosing.
  const apiBaseUrl = requireNonEmpty('PUBLIC_API_BASE_URL');

  // Frontend page the customer's browser is redirected to after the gateway
  // returns them. Must be absolute so the 302 cannot be turned into an open
  // redirect by a relative path.
  const resultRedirectUrl = requireNonEmpty('PAYMENT_RESULT_REDIRECT_URL');

  const requireAbsoluteHttpUrl = (key: string, value: string): void => {
    if (!value) return;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      errors.push(`${key} must be an absolute URL`);
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push(`${key} must use http or https`);
    }
  };

  requireAbsoluteHttpUrl('PUBLIC_API_BASE_URL', apiBaseUrl);
  requireAbsoluteHttpUrl('PAYMENT_RESULT_REDIRECT_URL', resultRedirectUrl);

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return config;
}
