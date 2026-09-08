const CREDENTIAL_FAILURE_PATTERNS = [
  /\b(?:401|403)\b/,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bauthentication (?:failed|required|error)\b/i,
  /\binvalid (?:api[ -]?key|credential|token|bearer token)\b/i,
  /\b(?:api[ -]?key|credential|token|bearer token) (?:is )?(?:invalid|expired|missing|rejected)\b/i,
  /\baccess denied\b/i,
];

// An EXPIRED temporary credential, distinguished from a rejected or rotated one.
//
// v1 ships no refresh mechanism: a Bedrock IAM-role credential lives 3600s (the
// hard role-chaining ceiling) and a stage that outlives it fails. Measured stage
// durations are p50 5 min / p90 10 min / p99 20 min against that hour, so this is
// rare — but it is the evidence that gates ever building refresh, which is why it
// gets its OWN reason instead of being folded into credential_invalid
// (specs/bedrock-iam-role-credential-mode: req-expiry-failure-legible,
// req-expiry-tripwire, dec-v1-no-refresh).
//
// Checked BEFORE isCredentialFailure, whose generic "token is expired" pattern
// would otherwise swallow these.
const EXPIRED_CREDENTIAL_PATTERNS = [
  /\bExpiredToken(?:Exception)?\b/,
  /\bsecurity token included in the request is expired\b/i,
  /\bthe provided token has expired\b/i,
  /\b(?:credentials?|session|token)s? (?:has |have )?expired\b/i,
  /\bexpired (?:credentials?|session token|security token)\b/i,
];

export const isCredentialFailure = (output = '') => {
  const text = String(output ?? '');
  return CREDENTIAL_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
};

export const isExpiredCredentialFailure = (output = '') => {
  const text = String(output ?? '');
  return EXPIRED_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
};

export default isCredentialFailure;
