// Mirrors the user pool's password_policy in terraform/modules/auth/main.tf
// (and validate_password in scripts/install.sh); keep them in sync. Cognito
// stays authoritative: this only catches a bad password before the round trip.
export const PASSWORD_POLICY_HINT =
  'At least 12 characters, with lowercase and uppercase letters, a number, and a symbol.';

export function passwordPolicyError(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a symbol';
  return null;
}
