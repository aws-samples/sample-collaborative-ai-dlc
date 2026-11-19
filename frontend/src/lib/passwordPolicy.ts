// Mirrors the user pool's password_policy in terraform/modules/auth/main.tf,
// including Cognito's own definition of a symbol; keep them in sync. Cognito
// stays authoritative: this only catches a bad password before the round trip.
export const PASSWORD_POLICY_HINT =
  'At least 12 characters, with lowercase and uppercase letters, a number, and a symbol.';

// Cognito counts only these as special characters, plus a space that is
// neither leading nor trailing.
const COGNITO_SYMBOL = /[\^$*.[\]{}()?"!@#%&/\\,><':;|_~`=+\- ]/;

export function passwordPolicyError(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (password !== password.trim()) return 'Password must not start or end with a space';
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must include a number';
  if (!COGNITO_SYMBOL.test(password)) {
    return 'Password must include a symbol such as ! @ # $ % ^ & * - _ = + ?';
  }
  return null;
}
