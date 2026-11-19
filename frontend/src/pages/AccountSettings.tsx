import { AgentCredentialScopeCard } from '@/components/settings/AgentCredentialScopeCard';
import { ChangePasswordCard } from '@/components/settings/ChangePasswordCard';
import { useAuth } from '@/contexts/AuthContext';

export default function AccountSettings() {
  const { user } = useAuth();
  // Federated (hybrid / sso-only) users' passwords belong to their identity
  // provider; only local Cognito accounts can change theirs here.
  const localAccount = user?.identitySource === 'cognito';
  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Account Settings</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {localAccount
              ? 'Your sign-in password and the credentials used for your own agent activity.'
              : 'Credentials used for your own agent activity.'}
          </p>
        </div>
        {localAccount && <ChangePasswordCard />}
        <AgentCredentialScopeCard scope="personal" />
      </div>
    </div>
  );
}
