const CREDENTIAL_FAILURE_PATTERNS = [
  /\b(?:401|403)\b/,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bauthentication (?:failed|required|error)\b/i,
  /\binvalid (?:api[ -]?key|credential|token|bearer token)\b/i,
  /\b(?:api[ -]?key|credential|token|bearer token) (?:is )?(?:invalid|expired|missing|rejected)\b/i,
  /\baccess denied\b/i,
];

export const isCredentialFailure = (output = '') => {
  const text = String(output ?? '');
  return CREDENTIAL_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
};

// A 429 alone is transient throttling. Only explicit credit/billing exhaustion
// is actionable by replenishing or rotating the bound credential.
export const isCreditExhaustion = (output = '') => {
  const text = String(output ?? '');
  if (
    [
      /\b(?:insufficient|exhausted|depleted) credits?\b/i,
      /\b(?:out of|no remaining) credits?\b/i,
      /\bcredits? (?:have been |are |is )?(?:exhausted|depleted)\b/i,
      /\b(?:credit|spending|billing|monthly usage) limit (?:has been |is )?(?:reached|exceeded)\b/i,
      /\binsufficient_quota\b/i,
      /\bcredit balance (?:is )?(?:too low|insufficient)\b/i,
      /\bbilling_hard_limit_reached\b/i,
    ].some((pattern) => pattern.test(text))
  )
    return true;
  // Gemini uses the same "exceeded your current quota" introduction for
  // short-lived throttling. Its reset hint must not become billing guidance.
  if (
    /\b(?:rate[ _-]?limit|(?:requests?|tokens?)[ _-]?per[ _-]?(?:minute|second)|(?:retry|try again) in \d)/i.test(
      text,
    )
  )
    return false;
  return [
    /\bexceeded (?:your |the )?(?:current )?quota\b/i,
    /\b(?:quota(?: usage)?|usage) limit (?:has been |is )?(?:reached|exceeded)\b/i,
  ].some((pattern) => pattern.test(text));
};

export default isCredentialFailure;
