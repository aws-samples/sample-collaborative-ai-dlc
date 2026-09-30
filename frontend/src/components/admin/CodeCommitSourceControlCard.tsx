import { useEffect, useState } from 'react';
import { CodeCommitIcon } from '@/components/icons/git-providers';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { api } from '@/services/api';
import type { CodeCommitStatus } from '@/services/gitProvider';

// Admin card for CodeCommit. Nothing to configure: there is no OAuth app and no
// secret. What an operator needs to know is which platform execution roles a
// tenant must trust, so they can be shared ahead of a connection and checked
// against a tenant's trust policy when a bind fails.
export function CodeCommitSourceControlCard() {
  const [status, setStatus] = useState<CodeCommitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<CodeCommitStatus>('/codecommit/status')
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SettingsCard
      icon={<CodeCommitIcon />}
      title="AWS CodeCommit"
      badge={<ConfigStatusBadge ok={status?.configured ?? false} notOkTone="warning" />}
      description="IAM role access to CodeCommit repositories. No OAuth app: each space connects a role from the repository account that trusts the platform principals below."
    >
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : !status ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : status.principals.length === 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          The deployment did not publish its platform principals (CODECOMMIT_PLATFORM_PRINCIPALS);
          spaces cannot connect CodeCommit until it does.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Platform principals a tenant role must trust (rendered into the trust policy shown by
            the connect flow):
          </p>
          <ul className="space-y-1">
            {status.principals.map((arn) => (
              <li key={arn} className="font-mono text-[11px] break-all select-all">
                {arn}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Every call is narrowed to one repository with a session policy (GitPull/GitPush and the
            pull request API); the tenant role policy only sets the outer bound.
          </p>
        </div>
      )}
    </SettingsCard>
  );
}
