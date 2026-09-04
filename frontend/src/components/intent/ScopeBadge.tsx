import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// Deterministic scope → color mapping so the same scope always renders the
// same hue across pages (Work header, Overview header, lists).
const SCOPE_PALETTE = [
  'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
] as const;

export function scopeColor(scope: string): string {
  let hash = 0;
  for (let i = 0; i < scope.length; i++) {
    hash = (hash * 31 + scope.charCodeAt(i)) | 0;
  }
  return SCOPE_PALETTE[Math.abs(hash) % SCOPE_PALETTE.length];
}

export function ScopeBadge({ scope, className }: { scope: string; className?: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn('text-xs font-semibold px-2.5 border-0', scopeColor(scope), className)}
      aria-label={`Scope: ${scope}`}
    >
      {scope}
    </Badge>
  );
}
