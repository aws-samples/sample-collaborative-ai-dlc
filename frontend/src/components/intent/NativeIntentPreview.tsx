import { useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import {
  discoveryPath,
  nativeIntentStatusLabel,
  nativeIntentTitle,
  nativeWaitingStatus,
  type NativeDiscoveredIntent,
} from '@/lib/intentDiscovery';

export function NativeIntentPreview({
  items,
  projectId,
  projectName,
  selectedId,
}: {
  items: NativeDiscoveredIntent[];
  projectId: string;
  projectName?: string;
  selectedId?: string | null;
}) {
  const navigate = useNavigate();
  const recent = items.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latest = recent[0];
  if (!latest) return null;
  const selected = recent.find((item) => item.id === selectedId);
  const visible = selected && selected !== latest ? [selected, latest] : [latest];
  const statuses = new Set(visible.map(nativeWaitingStatus));
  const more: NativeDiscoveredIntent[] = [];
  for (const item of recent) {
    const status = nativeWaitingStatus(item);
    if (!status || item === latest || item === selected) continue;
    if (statuses.has(status)) more.push(item);
    else {
      statuses.add(status);
      visible.push(item);
    }
  }
  const row = (item: NativeDiscoveredIntent) => {
    const title = nativeIntentTitle(item);
    const status = nativeIntentStatusLabel(item);
    return (
      <button
        key={item.id}
        type="button"
        aria-current={item.id === selectedId ? 'page' : undefined}
        aria-label={`Native ${title}: ${status}${projectName ? ` (${projectName})` : ''}`}
        onClick={() => navigate(discoveryPath(projectId, { backend: 'native', intent: item }))}
        className="block w-full rounded-md py-1 text-left hover:bg-accent/50"
      >
        <span className="flex items-center gap-1.5">
          <Badge variant="outline" className="shrink-0 text-[9px]">
            Native
          </Badge>
          <span className="truncate">{title}</span>
        </span>
        <span className="block text-muted-foreground">{status}</span>
      </button>
    );
  };
  return (
    <>
      {projectName && <p className="truncate text-muted-foreground">{projectName}</p>}
      {visible.map(row)}
      {more.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {more.length} more waiting
          </summary>
          {more.map(row)}
        </details>
      )}
    </>
  );
}
