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

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return config;
}
