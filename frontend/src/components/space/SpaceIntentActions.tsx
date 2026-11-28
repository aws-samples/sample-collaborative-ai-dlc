import { Link } from 'react-router';
import { Eye } from 'lucide-react';
import type { Intent } from '@/services/intents';
import { RowActions } from '@/components/RowActions';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { IntentRunActionItems, hasIntentRunActions } from '@/components/intent/IntentActionsMenu';
import { intentSectionPath } from '@/lib/intentSectionPreference';
import { intentRowTitle } from './IntentRow';

export interface SpaceIntentActionsProps {
  projectId: string;
  intent: Intent;
  /** Owner-only; the Space page resolves the role. */
  canDelete: boolean;
  /** Omitted for read-only readers (Viewers), as on the intent page. */
  onCancel?: (intent: Intent) => void;
  onDelete: (intent: Intent) => void;
  disabled?: boolean;
}

/**
 * The row menu of a Space intent list. The destructive items come from the
 * intent page's own menu builder, so "Close failed run", the refusal reasons
 * and the owner-only Delete read the same on both.
 */
export function SpaceIntentActions({
  projectId,
  intent,
  canDelete,
  onCancel,
  onDelete,
  disabled,
}: SpaceIntentActionsProps) {
  const runActions = {
    intent,
    onCancel: onCancel ? () => onCancel(intent) : undefined,
    onDelete: canDelete ? () => onDelete(intent) : undefined,
    variant: 'row' as const,
  };
  const showOverview = intent.status !== 'DRAFT';
  return (
    <RowActions label={`Actions for intent ${intentRowTitle(intent)}`} disabled={disabled}>
      {showOverview ? (
        <DropdownMenuItem asChild>
          <Link to={intentSectionPath(projectId, intent.id, 'overview')}>
            <Eye aria-hidden="true" />
            View overview
          </Link>
        </DropdownMenuItem>
      ) : null}
      {showOverview && hasIntentRunActions(runActions) ? <DropdownMenuSeparator /> : null}
      <IntentRunActionItems {...runActions} />
    </RowActions>
  );
}
