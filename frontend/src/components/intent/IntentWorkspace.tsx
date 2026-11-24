import type { ReactNode } from 'react';

export function IntentWorkspace({
  title,
  badges,
  actions,
  children,
  graph = false,
}: {
  title: string;
  badges?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  graph?: boolean;
}) {
  return (
    <div className={graph ? 'h-full min-w-0' : 'space-y-6'} aria-label="Intent workspace">
      {!graph && (
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <h1 className="text-lg font-bold tracking-tight truncate min-w-0">{title}</h1>
            {badges}
          </div>
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        </header>
      )}
      {children}
    </div>
  );
}
