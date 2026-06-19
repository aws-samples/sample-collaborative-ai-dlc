// Re-exports from the unified GitConnectButton for backward compatibility.
// New code should import GitConnectButton directly.
import { GitConnectButton } from './GitConnectButton';

interface Props {
  connected: boolean;
  onDisconnect: () => void;
}

export function GitLabConnectButton({ connected, onDisconnect }: Props) {
  return <GitConnectButton provider="gitlab" connected={connected} onDisconnect={onDisconnect} />;
}
