import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { trackersService, type JiraPendingChoice } from '@/services/trackers';
import { OAuthCallbackShell } from '@/components/OAuthCallbackShell';
import { getTrackerProvider } from '@/lib/trackerProviders';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

type Status = 'loading' | 'choose' | 'finalizing' | 'success' | 'error';

export default function JiraCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<JiraPendingChoice | null>(null);
  const [chosenCloudId, setChosenCloudId] = useState<string | null>(null);

  const meta = getTrackerProvider('jira-cloud');

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    if (!code) {
      setStatus('error');
      setError('Missing authorization code');
      return;
    }

    fetch(
      `${API_BASE_URL}${meta.callbackPath}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? '')}`,
    )
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setStatus('success');
          setTimeout(() => navigate(-1), 1200);
          return;
        }
        if (data.pendingChoice) {
          setChoice(data.pendingChoice);
          setChosenCloudId(data.pendingChoice.resources[0]?.cloudId ?? null);
          setStatus('choose');
          return;
        }
        setStatus('error');
        setError(data.error || `Failed to connect ${meta.displayName}`);
      })
      .catch(() => {
        setStatus('error');
        setError(`Failed to connect ${meta.displayName}`);
      });
  }, [searchParams, navigate, meta.callbackPath, meta.displayName]);

  const handleConfirm = async () => {
    if (!choice || !chosenCloudId) return;
    setStatus('finalizing');
    try {
      await trackersService.finalizeJiraConnection(choice.ticket, chosenCloudId);
      setStatus('success');
      setTimeout(() => navigate(-1), 1200);
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
      <OAuthCallbackShell status="error" providerLabel={meta.displayName} errorMessage={error} />
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
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="px-4 py-2 border rounded text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!chosenCloudId}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-60"
            >
              Connect
            </button>
          </div>
        </div>
      )}
    </OAuthCallbackShell>
  );
}
