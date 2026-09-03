import { AgentCredentialScopeCard } from '@/components/settings/AgentCredentialScopeCard';

export default function AccountSettings() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Account Settings</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Credentials used for your own agent activity.
          </p>
        </div>
        <AgentCredentialScopeCard scope="personal" />
      </div>
    </div>
  );
}
