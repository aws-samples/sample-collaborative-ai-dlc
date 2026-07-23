import { useState } from 'react';
import { Check } from 'lucide-react';
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
  reauthorizationRequired?: boolean;
  missingScopes?: string[];
  onDisconnect: () => void;
}

// Button styling + label per provider.
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
      'px-4 py-2 bg-[#fc6d26] text-white rounded hover:bg-[#e24329] disabled:opacity-50 self-start',
    disabledClass:
      'px-4 py-2 bg-[#fc6d26] text-white rounded opacity-50 cursor-not-allowed self-start',
    connectedClass: 'text-green-600 text-sm',
  },
  bitbucket: {
    label: 'Bitbucket',
    connectClass:
      'px-4 py-2 bg-[#0052CC] text-white rounded hover:bg-[#0747A6] disabled:opacity-50 self-start',
    disabledClass:
      'px-4 py-2 bg-[#0052CC] text-white rounded opacity-50 cursor-not-allowed self-start',
    connectedClass: 'text-green-600 text-sm',
  },
};

export function GitConnectButton({
  provider,
  connected,
  reauthorizationRequired = false,
  missingScopes = [],
  onDisconnect,
}: GitConnectButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = PROVIDER_META[provider];
  const service = getGitProviderService(provider);

  const trackerId = trackerIdForGitProvider(provider);
  const { providers, loading: providersLoading, failed: providersFailed } = useTrackerProviders();
  // Only code hosts that also implement a tracker reuse tracker OAuth
  // configuration. Code-host-only providers validate their own OAuth setup
  // when starting the authorization flow.
  const configured = providersLoading
    ? null
    : providersFailed
      ? true
      : trackerId === null || (providers.find((p) => p.id === trackerId)?.configured ?? false);

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
        <span className={`inline-flex items-center gap-1 ${meta.connectedClass}`}>
          <Check className="w-4 h-4" /> {meta.label} Connected
        </span>
        <button
          type="button"
          onClick={handleDisconnect}
          disabled={loading}
          className="inline-flex items-center px-3 py-1 text-sm font-medium rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:hover:bg-red-950/40"
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
          credentials in <strong>Platform Admin → Source Control</strong>.
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
        {loading
          ? reauthorizationRequired
            ? 'Reauthorizing...'
            : 'Connecting...'
          : reauthorizationRequired
            ? `Reauthorize ${meta.label}`
            : `Connect ${meta.label}`}
      </button>
      {reauthorizationRequired && (
        <p className="text-xs text-amber-700 dark:text-amber-400 max-w-md">
          Reauthorization is required to grant
          {missingScopes.length > 0 ? ` ${missingScopes.join(', ')}` : ' the required'} permission.
        </p>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
