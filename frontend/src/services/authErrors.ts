export const SSO_ACCESS_DENIED_CODE = 'SSO_ACCESS_DENIED';
export const SSO_ACCESS_DENIED_MESSAGE =
  'Your enterprise account is not authorized to access AI-DLC. Ask your identity provider administrator to grant the required access and try again.';
export const SSO_LOGIN_TIMEOUT_MESSAGE =
  'Enterprise sign-in did not complete in time. Try signing in again.';

export class SsoAccessDeniedError extends Error {
  readonly code = SSO_ACCESS_DENIED_CODE;

  constructor(cause?: unknown) {
    super(SSO_ACCESS_DENIED_MESSAGE, cause === undefined ? undefined : { cause });
    this.name = 'SsoAccessDeniedError';
  }
}

export class SsoLoginTimeoutError extends Error {
  constructor(cause?: unknown) {
    super(SSO_LOGIN_TIMEOUT_MESSAGE, cause === undefined ? undefined : { cause });
    this.name = 'SsoLoginTimeoutError';
  }
}

const errorText = (error: unknown): string => {
  const values = [error];
  const seen = new Set<unknown>();
  const fragments: string[] = [];

  while (values.length > 0) {
    const value = values.shift();
    if (value == null || seen.has(value)) continue;
    seen.add(value);

    if (typeof value === 'string') {
      fragments.push(value);
      continue;
    }
    if (typeof value !== 'object') continue;

    const candidate = value as Record<string, unknown>;
    for (const key of ['code', 'name', 'message', 'error', 'error_description', 'cause']) {
      if (candidate[key] !== undefined) values.push(candidate[key]);
    }
  }

  return fragments.join(' ');
};

export const isSsoAccessDeniedError = (error: unknown): boolean => {
  if (error instanceof SsoAccessDeniedError) return true;
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === SSO_ACCESS_DENIED_CODE
  ) {
    return true;
  }

  const details = errorText(error);
  return /\bSSO_ACCESS_DENIED\b/i.test(details) || /\baccess_denied\b/i.test(details);
};

export const normalizeSsoLoginError = (error: unknown): Error => {
  if (isSsoAccessDeniedError(error)) return new SsoAccessDeniedError(error);
  return error instanceof Error ? error : new Error('Enterprise sign-in failed', { cause: error });
};
