import { useState } from 'react';
import { getGitProviderService } from '../services/gitProvider';
import { ApiError } from '../services/api';

interface Props {
  provider: 'github' | 'gitlab';
  connected: boolean;
  onDisconnect: () => void;
}

const PROVIDER_META = {
  github: {
    label: 'GitHub',
    connectClass:
      'px-4 py-2 bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 self-start',
    connectedClass: 'text-green-600 text-sm',
  },
  gitlab: {
    label: 'GitLab',
    connectClass:
      'px-4 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50 self-start',
    connectedClass: 'text-green-600 text-sm',
  },
};

export function GitConnectButton({ provider, connected, onDisconnect }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = PROVIDER_META[provider];
  const service = getGitProviderService(provider);

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

  return (
    <div className="flex flex-col gap-2">
      <button onClick={handleConnect} disabled={loading} className={meta.connectClass}>
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
