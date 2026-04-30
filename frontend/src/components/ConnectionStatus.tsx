interface Props {
  status: string;
}

export function ConnectionStatus({ status }: Props) {
  const statusConfig: Record<string, { color: string; label: string }> = {
    connected: { color: 'bg-green-500', label: 'Connected' },
    connecting: { color: 'bg-yellow-500', label: 'Connecting...' },
    disconnected: { color: 'bg-gray-500', label: 'Disconnected' },
    error: { color: 'bg-red-500', label: 'Connection Error' }
  };

  const config = statusConfig[status] || statusConfig.disconnected;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`w-2 h-2 rounded-full ${config.color}`} />
      <span className="text-gray-600">{config.label}</span>
    </div>
  );
}
