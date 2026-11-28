import { AgentCredentialScopeCard } from '@/components/settings/AgentCredentialScopeCard';
import { ChangePasswordCard } from '@/components/settings/ChangePasswordCard';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/contexts/AuthContext';
import type { User } from '@/services/auth';

function signedInAs(user: User) {
  const name = user.displayName?.trim();
  const email = user.email?.trim();
  if (name && email && name !== email) return `${name} · ${email}`;
  return name || email || user.username;
}

export default function AccountSettings() {
  const { user } = useAuth();
  // Federated (hybrid / sso-only) users' passwords belong to their identity
  // provider; only local Cognito accounts can change theirs here.
  const localAccount = user?.identitySource === 'cognito';
  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-6">
        <div className="space-y-2">
          <PageHeader
            title="Account settings"
            subtitle={
              localAccount
                ? 'Password and personal agent keys.'
                : `Your organization manages your sign-in password${user?.identityProvider ? ` through ${user.identityProvider}` : ''}. Personal agent keys.`
            }
          />
          {user ? (
            <p className="text-xs text-muted-foreground">
              Signed in as{' '}
              <span className="font-medium text-foreground" title={`User ID ${user.userId}`}>
                {signedInAs(user)}
              </span>
            </p>
          ) : null}
        </div>
        {localAccount && <ChangePasswordCard />}
        <AgentCredentialScopeCard scope="personal" />
      </div>
    </div>
  );
}
