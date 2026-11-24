import { Activity } from 'lucide-react';
import { getLastIntentSection, intentSectionPath } from '@/lib/intentSectionPreference';
import { Fragment, type ReactNode } from 'react';
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
  selectedSections,
  sidebar = false,
}: {
  items: NativeDiscoveredIntent[];
  projectId: string;
  projectName?: string;
  selectedId?: string | null;
  selectedSections?: ReactNode;
  sidebar?: boolean;
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
      <Fragment key={item.id}>
        <button
          type="button"
          aria-current={item.id === selectedId ? 'page' : undefined}
          aria-label={`Native ${title}: ${status}${projectName ? ` (${projectName})` : ''}`}
          onClick={() =>
            navigate(
              sidebar && !nativeWaitingStatus(item) && item.status === 'READY'
                ? intentSectionPath(
                    projectId,
                    item.id,
                    getLastIntentSection(`native:${projectId}:${item.id}`),
                    'native',
                  )
                : discoveryPath(projectId, { backend: 'native', intent: item }),
            )
          }
          className="block w-full rounded-md py-1 text-left hover:bg-accent/50"
        >
          <span className="flex items-center gap-1.5">
            {sidebar ? (
              <Activity className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/50" />
            ) : (
              <Badge variant="outline" className="shrink-0 text-[9px]">
                Native
              </Badge>
            )}
            <span className="truncate">{title}</span>
          </span>
          <span
            className={
              sidebar
                ? 'block pl-5 text-[10px] text-sidebar-foreground/50'
                : 'block text-muted-foreground'
            }
          >
            {sidebar && projectName ? `${projectName} · ` : ''}
            <span>{status}</span>
          </span>
        </button>
        {item.id === selectedId && selectedSections}
      </Fragment>
    );
  };
  return (
    <>
      {!sidebar && projectName && <p className="truncate text-muted-foreground">{projectName}</p>}
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
