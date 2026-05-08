import { useState } from 'react';
import { githubService } from '../services/github';
import { ApiError } from '../services/api';

interface Props {
  connected: boolean;
  onDisconnect: () => void;
}

export function GitHubConnectButton({ connected, onDisconnect }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const { url } = await githubService.getAuthUrl();
      window.location.href = url;
    } catch (err) {
      setLoading(false);
      const serverMsg = err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : null;
      setError(serverMsg ?? 'Could not start GitHub connection. Please try again.');
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      await githubService.disconnect();
      onDisconnect();
    } finally {
      setLoading(false);
    }
  };

  if (connected) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-green-600 text-sm">✓ GitHub Connected</span>
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
      <button
        onClick={handleConnect}
        disabled={loading}
        className="px-4 py-2 bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 self-start"
      >
        {loading ? 'Connecting...' : 'Connect GitHub'}
      </button>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
