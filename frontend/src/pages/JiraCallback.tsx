import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { trackersService } from '@/services/trackers';
import { OAuthCallbackShell } from '@/components/OAuthCallbackShell';
import { getTrackerProvider } from '@/lib/trackerProviders';

import { useOAuthReturnPath } from '@/hooks/useOAuthReturnPath';
import { useOAuthExchange } from '@/hooks/useOAuthExchange';
import { Button } from '@/components/ui/button';

type Status = 'loading' | 'choose' | 'finalizing' | 'success' | 'error';

export default function JiraCallback() {
  const navigate = useNavigate();
  const [finalState, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setChosenCloudId] = useState<string | null>(null);

  const meta = getTrackerProvider('jira-cloud');

  const { back, resume } = useOAuthReturnPath();
  const result = useOAuthExchange(meta.callbackPath, meta.displayName);
  const choice = result?.pendingChoice;
  // Same rule as the project picker: never preselect among several sites —
  // the first one is rarely the right one and Connect would silently bind it.
  // A single site is not a choice, so it is selected for the user.
  const chosenCloudId =
    selection ?? (choice?.resources.length === 1 ? choice.resources[0].cloudId : null);
  const status =
    finalState ?? (!result ? 'loading' : result.success ? 'success' : choice ? 'choose' : 'error');
  const leave = useCallback(
    () => navigate(resume ?? '/dashboard', { replace: true }),
    [resume, navigate],
  );

  useEffect(() => {
    if (status !== 'success') return;
    const timer = setTimeout(leave, 1200);
    return () => clearTimeout(timer);
  }, [status, leave]);

  const handleConfirm = async () => {
    if (!choice || !chosenCloudId) return;
    setStatus('finalizing');
    try {
      await trackersService.finalizeJiraConnection(choice.ticket, chosenCloudId);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to finalize');
    }
  };

  // Loading-state shell handles both initial fetch and the finalize step.
  if (status === 'loading' || status === 'finalizing') {
    return (
      <OAuthCallbackShell
        status="loading"
        providerLabel={meta.displayName}
        loadingMessage={status === 'finalizing' ? 'Finalizing...' : undefined}
      />
    );
  }

  if (status === 'success') {
    return <OAuthCallbackShell status="success" providerLabel={meta.displayName} />;
  }

  if (status === 'error') {
    return (
      <OAuthCallbackShell
        status="error"
        providerLabel={meta.displayName}
        errorMessage={error ?? result?.error}
        backTo={back}
      />
    );
  }

  // status === 'choose' — multi-site picker. Wrap in the shell so the visual
  // identity matches the other states.
  return (
    <OAuthCallbackShell status="custom" providerLabel={meta.displayName}>
      {choice && (
        <div className="text-left">
          <h2 className="text-lg font-semibold mb-1">Pick an Atlassian site</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Your account has access to multiple Atlassian sites. Choose which one to connect.
          </p>
          <div className="space-y-2 mb-4">
            {choice.resources.map((r) => (
              <label
                key={r.cloudId}
                className="flex items-start gap-3 p-3 rounded-md border cursor-pointer hover:bg-accent/30"
              >
                <input
                  type="radio"
                  name="cloudId"
                  value={r.cloudId}
                  checked={chosenCloudId === r.cloudId}
                  onChange={() => setChosenCloudId(r.cloudId)}
                  className="mt-1 accent-primary"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{r.name}</p>
                  {r.host && <p className="text-xs text-muted-foreground truncate">{r.host}</p>}
                </div>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              onClick={() => navigate(back, { replace: true })}
              variant="outline"
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleConfirm} disabled={!chosenCloudId}>
              Connect
            </Button>
          </div>
        </div>
      )}
    </OAuthCallbackShell>
  );
}
