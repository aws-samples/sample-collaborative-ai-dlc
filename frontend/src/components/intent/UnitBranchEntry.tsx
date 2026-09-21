import { GitBranch } from 'lucide-react';
import type { UnitBranchItem } from '@/components/intent/CodeSection';
import { GitProviderIcon } from '@/components/icons/git-providers';
import { cn } from '@/lib/utils';

export function UnitBranchEntry({
  item,
  className,
  alignWithDocuments = false,
  showPullRequests = false,
}: {
  item: UnitBranchItem;
  className?: string;
  alignWithDocuments?: boolean;
  showPullRequests?: boolean;
}) {
  const rowClassName = cn(
    'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-muted/50',
    className,
  );
  const icon = (
    <>
      {alignWithDocuments && <span aria-hidden="true" className="w-4 shrink-0" />}
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </>
  );

  if (!item.branch) {
    return (
      <div
        className={rowClassName}
        data-testid={`unit-branch-${item.sectionIndex ?? 'unknown'}-${item.unitSlug}`}
      >
        {icon}
        <span className="truncate text-xs text-muted-foreground">
          Unavailable — branch not recorded
        </span>
      </div>
    );
  }

  if (item.targets.length === 0) {
    return (
      <div
        className={rowClassName}
        data-testid={`unit-branch-${item.sectionIndex ?? 'unknown'}-${item.unitSlug}`}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <code className="font-mono text-foreground" title={item.branch}>
            {item.branch}
          </code>
          {' — link unavailable'}
        </span>
      </div>
    );
  }

  return (
    <div
      className="space-y-0.5"
      data-testid={`unit-branch-${item.sectionIndex ?? 'unknown'}-${item.unitSlug}`}
    >
      {item.targets.map((target) => (
        <div key={target.repo} className={rowClassName}>
          {alignWithDocuments && <span aria-hidden="true" className="w-4 shrink-0" />}
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {target.url ? (
            <a
              href={target.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${target.repo} · ${item.branch}`}
              className="min-w-0 flex-1 truncate font-mono text-primary underline-offset-2 hover:underline"
            >
              {item.branch}
            </a>
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={`${target.repo} · ${item.branch} · link unavailable`}
            >
              <code className="font-mono text-foreground">{item.branch}</code>
              {' — link unavailable'}
            </span>
          )}
          {showPullRequests && target.prUrl && (
            <a
              href={target.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open PR${target.prNumber != null ? ` #${target.prNumber}` : ''} for ${target.repo}`}
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
            >
              <GitProviderIcon provider={target.provider} className="h-3 w-3" />
              Open PR{target.prNumber != null ? ` #${target.prNumber}` : ''}
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
