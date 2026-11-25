// Collapsed "Setup guide" toggle and panel shared by the admin source-control
// cards. The caller owns the open state, so a card can close its guide after a
// save.

import type { ReactNode } from 'react';
import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function SetupGuideToggle({ open, onOpenChange, children }: Props) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <BookOpen className="h-3.5 w-3.5" />
        Setup guide
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-lg bg-muted/40 p-3.5 text-xs text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  );
}
