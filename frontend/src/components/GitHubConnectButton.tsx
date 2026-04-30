import { useState } from 'react';
import { githubService } from '../services/github';

interface Props {
  connected: boolean;
  onDisconnect: () => void;
}

export function GitHubConnectButton({ connected, onDisconnect }: Props) {
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    setLoading(true);
    try {
      const { url } = await githubService.getAuthUrl();
      window.location.href = url;
    } catch {
      setLoading(false);
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
    <button
      onClick={handleConnect}
      disabled={loading}
      className="px-4 py-2 bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50"
    >
      {loading ? 'Connecting...' : 'Connect GitHub'}
    </button>
  );
}
