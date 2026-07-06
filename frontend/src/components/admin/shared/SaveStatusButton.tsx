// Save button + inline result feedback ("Saved" / error message) used by every
// settings card on the Platform Admin page. Deduplicates the button/spinner/
// result-row block the old Admin page repeated per card.

import { Button } from '@/components/ui/button';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';

export type SaveResult = 'saved' | 'error' | null;

interface Props {
  onClick: () => void;
  disabled?: boolean;
  saving: boolean;
  label?: string;
  savingLabel?: string;
  result: SaveResult;
  savedMessage?: string;
  errorMessage?: string | null;
}

export function SaveStatusButton({
  onClick,
  disabled,
  saving,
  label = 'Save',
  savingLabel = 'Saving…',
  result,
  savedMessage = 'Saved',
  errorMessage,
}: Props) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <Button size="sm" onClick={onClick} disabled={saving || disabled} className="gap-1.5">
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {saving ? savingLabel : label}
      </Button>
      {result === 'saved' && (
        <span className="text-xs text-agent-success flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5" /> {savedMessage}
        </span>
      )}
      {result === 'error' && (
        <span className="text-xs text-destructive flex items-center gap-1">
          <XCircle className="h-3.5 w-3.5" /> {errorMessage || 'Failed to save'}
        </span>
      )}
    </div>
  );
}
