import { useState } from 'react';
import {
  getGitProviderService,
  trackerIdForGitProvider,
  type GitProvider,
} from '../services/gitProvider';
import { ApiError } from '../services/api';
import { useTrackerProviders } from '@/hooks/useTrackerProviders';

export interface GitConnectButtonProps {
  provider: GitProvider;
  connected: boolean;
  onDisconnect: () => void;
}

// Button styling + label per provider. The git→tracker association lives in
// the gitProvider service (trackerIdForGitProvider) — not duplicated here.
const PROVIDER_META = {
  github: {
    label: 'GitHub',
    connectClass:
      'px-4 py-2 bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 self-start',
    disabledClass:
      'px-4 py-2 bg-gray-900 text-white rounded opacity-50 cursor-not-allowed self-start',
    connectedClass: 'text-green-600 text-sm',
  },
  gitlab: {
    label: 'GitLab',
    connectClass:
      'px-4 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50 self-start',
    disabledClass:
      'px-4 py-2 bg-orange-600 text-white rounded opacity-50 cursor-not-allowed self-start',
    connectedClass: 'text-green-600 text-sm',
  },
};

export function GitConnectButton({ provider, connected, onDisconnect }: GitConnectButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = PROVIDER_META[provider];
  const service = getGitProviderService(provider);

  // Operator-side OAuth-app config — disable the Connect button when the
  // deployment hasn't populated this provider's OAuth secret yet, with helper
  // text pointing the user at the Admin panel. The git provider and its
  // issue-tracker share one OAuth app, so config status is keyed by tracker id.
  const trackerId = trackerIdForGitProvider(provider);
  const { providers, loading: providersLoading, failed: providersFailed } = useTrackerProviders();
  // null while loading; true if the provider reports configured OR the fetch
  // itself failed (let the user try anyway rather than block on a transient blip).
  const configured = providersLoading
    ? null
    : providersFailed
      ? true
      : (providers.find((p) => p.id === trackerId)?.configured ?? false);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const { url } = await service.getAuthUrl();
      window.location.href = url;
    } catch (err) {
      setLoading(false);
      const serverMsg =
        err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : null;
      setError(serverMsg ?? `Could not start ${meta.label} connection. Please try again.`);
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      await service.disconnect();
      onDisconnect();
    } finally {
      setLoading(false);
    }
  };

  if (connected) {
    return (
      <div className="flex items-center gap-3">
        <span className={meta.connectedClass}>✓ {meta.label} Connected</span>
        <button
          onClick={handleDisconnect}
          disabled={loading}
          className="text-sm text-red-600 hover:underline disabled:opacity-50"
        >
          {loading ? 'Disconnecting...' : 'Disconnect'}
        </button>
      </div>
    );
  }

  if (configured === false) {
    return (
      <div className="flex flex-col gap-2">
        <button
          disabled
          title={`${meta.label} OAuth credentials are not configured for this deployment.`}
          className={meta.disabledClass}
        >
          Connect {meta.label}
        </button>
        <p className="text-xs text-gray-600 max-w-md">
          {meta.label} isn't configured for this deployment. Ask an administrator to add OAuth
          credentials in <strong>Admin → Tracker OAuth Apps</strong>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={handleConnect}
        disabled={loading || configured === null}
        className={meta.connectClass}
      >
        {loading ? 'Connecting...' : `Connect ${meta.label}`}
      </button>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
