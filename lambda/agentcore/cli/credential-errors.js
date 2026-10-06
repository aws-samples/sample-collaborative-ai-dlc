const CREDENTIAL_FAILURE_PATTERNS = [
  /\b(?:401|403)\b/,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bauthentication (?:failed|required|error)\b/i,
  /\binvalid (?:api[ -]?key|credential|token|bearer token)\b/i,
  /\b(?:api[ -]?key|credential|token|bearer token) (?:is )?(?:invalid|expired|missing|rejected)\b/i,
  // AWS phrasing, e.g. Kiro's "The bearer token included in the request is invalid".
  /\b(?:bearer|security) token included in the request is invalid\b/i,
  /\baccess denied\b/i,
];

export const isCredentialFailure = (output = '') => {
  const text = String(output ?? '');
  return CREDENTIAL_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
};

export default isCredentialFailure;
