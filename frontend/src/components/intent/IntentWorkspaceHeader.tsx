import type { ReactNode } from 'react';

export function IntentWorkspaceHeader({
  title,
  badges,
  actions,
}: {
  title: string;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <h1 className="text-lg font-bold tracking-tight truncate min-w-0">{title}</h1>
        {badges}
      </div>
      <div className="flex items-center gap-2 shrink-0">{actions}</div>
    </div>
  );
}
