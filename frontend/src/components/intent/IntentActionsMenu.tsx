import * as React from 'react';
import {
  Download,
  GitBranch,
  Loader2,
  MoreHorizontal,
  ScrollText,
  Settings2,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Intent } from '@/services/intents';
import { cn } from '@/lib/utils';

/** Mirrors lambda/intents/index.js handleCancelIntent: anything else is a 409. */
const CANCELLABLE_STATUSES: ReadonlySet<Intent['status']> = new Set([
  'WAITING',
  'CREATED',
  'FAILED',
]);
const RUNNING_REASON = 'The engine still reports this run as running.';

export interface IntentRunActionState {
  label: string;
  /** Why the backend would refuse it; null when the action is available. */
  disabledReason: string | null;
  /** The run has ended: nothing left to cancel (callers hide or show disabled). */
  finished: boolean;
}

/**
 * Cancel as the backend accepts it (lambda/intents handleCancelIntent):
 * WAITING/CREATED/FAILED; RUNNING refused while the engine holds the run;
 * ended runs have nothing to cancel. A FAILED run is only closed, so the
 * item says so. Every project member may cancel; the same rule on every menu.
 */
export function intentCancelAction(status: Intent['status']): IntentRunActionState {
  const label = status === 'FAILED' ? 'Close failed run' : 'Cancel run';
  if (CANCELLABLE_STATUSES.has(status)) return { label, disabledReason: null, finished: false };
  if (status === 'RUNNING') return { label, disabledReason: RUNNING_REASON, finished: false };
  if (status === 'DRAFT')
    return { label, disabledReason: 'Nothing has started yet.', finished: false };
  return { label, disabledReason: 'This run has already finished.', finished: true };
}

/**
 * Delete as the backend accepts it (handleDeleteIntent): owners only, and
 * never while RUNNING (409 — the live orchestrator still owns the run).
 */
export function intentDeleteAction(
  status: Intent['status'],
  { canDelete }: { canDelete: boolean },
): (IntentRunActionState & { allowed: true }) | { allowed: false } {
  if (!canDelete) return { allowed: false };
  return {
    allowed: true,
    label: 'Delete intent',
    disabledReason: status === 'RUNNING' ? RUNNING_REASON : null,
    finished: false,
  };
}

export interface CancelConfirmationCopy {
  title: string;
  description: string;
  keep: string;
  confirm: string;
}

/** The AlertDialog copy for a cancel, shared by every menu that offers it. */
export function cancelConfirmationCopy(
  intent: Pick<Intent, 'status' | 'title'>,
): CancelConfirmationCopy {
  const title = intent.title?.trim() || 'this intent';
  const { label } = intentCancelAction(intent.status);
  return intent.status === 'FAILED'
    ? {
        title: 'Close this failed run?',
        description: `The failed run "${title}" will be closed and its pending questions retired. History and documents are preserved.`,
        keep: 'Keep run',
        confirm: label,
      }
    : {
        title: 'Cancel this run?',
        description: `"${title}" will stop and its pending questions will be retired. History and documents are preserved.`,
        keep: 'Keep run',
        confirm: label,
      };
}

/** A menu item whose disabled reason reads under the label. */
function ReasonedItem({
  icon,
  label,
  disabledReason,
  destructive = false,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  disabledReason: string | null;
  destructive?: boolean;
  onSelect: (event: Event) => void;
}) {
  return (
    <DropdownMenuItem
      disabled={disabledReason !== null}
      aria-description={disabledReason ?? undefined}
      onSelect={onSelect}
      className={cn(destructive && !disabledReason && 'text-destructive focus:text-destructive')}
    >
      {icon}
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {disabledReason ? (
          <span className="text-xs text-muted-foreground">{disabledReason}</span>
        ) : null}
      </span>
    </DropdownMenuItem>
  );
}

export interface IntentRunActionItemsProps {
  intent: Pick<Intent, 'status'>;
  /** Omit to leave Cancel out of this menu. */
  onCancel?: (event: Event) => void;
  /** Owner-only — the caller resolves the role and omits it otherwise. */
  onDelete?: (event: Event) => void;
  /**
   * `page`: the intent's own menu — the header shows the status, so an ended
   * or draft run hides Cancel and a RUNNING one hides Delete; only the
   * RUNNING Cancel stays, disabled with its reason (the run looks stoppable).
   * `row`: a list row — every item stays visible, disabled with its reason,
   * so rows of different statuses carry the same menu.
   */
  variant: 'page' | 'row';
}

function runActionItems({ intent, onCancel, onDelete, variant }: IntentRunActionItemsProps) {
  const cancel = onCancel ? intentCancelAction(intent.status) : null;
  const remove = onDelete ? intentDeleteAction(intent.status, { canDelete: true }) : null;
  const page = variant === 'page';
  return {
    cancel: cancel && !(page && (cancel.finished || intent.status === 'DRAFT')) ? cancel : null,
    remove: remove?.allowed && !(page && remove.disabledReason !== null) ? remove : null,
  };
}

/**
 * The destructive items (Cancel / Close failed run, Delete intent) with one
 * label and one eligibility rule for every menu that offers them.
 */
export function IntentRunActionItems(props: IntentRunActionItemsProps) {
  const { cancel, remove } = runActionItems(props);
  return (
    <>
      {cancel && props.onCancel ? (
        <ReasonedItem
          icon={<XCircle aria-hidden="true" />}
          label={cancel.label}
          disabledReason={cancel.disabledReason}
          onSelect={props.onCancel}
        />
      ) : null}
      {remove && props.onDelete ? (
        <ReasonedItem
          icon={<Trash2 aria-hidden="true" />}
          label={remove.label}
          disabledReason={remove.disabledReason}
          destructive
          onSelect={props.onDelete}
        />
      ) : null}
    </>
  );
}

/** Whether `IntentRunActionItems` renders anything for these props. */
export function hasIntentRunActions(props: IntentRunActionItemsProps): boolean {
  const { cancel, remove } = runActionItems(props);
  return cancel !== null || remove !== null;
}

export interface IntentActionsMenuProps {
  intent: Pick<Intent, 'status' | 'title'>;
  onConfiguration?: () => void;
  onReshape?: () => void;
  /** When set, "Reshape remaining stages" is shown disabled with this reason. */
  reshapeDisabledReason?: string;
  onExport?: () => void;
  /** When set, "Download workspace" is shown disabled with this reason. */
  exportDisabledReason?: string;
  onAudit?: () => void;
  /**
   * Enabled for WAITING/CREATED/FAILED and confirmed in an AlertDialog; shown
   * disabled with the reason while RUNNING (stalled included); hidden once the
   * run has ended.
   */
  onCancel?: () => void | Promise<void>;
  /** Rendered unless RUNNING; confirmed in a destructive AlertDialog. Callers gate on ownership. */
  onDelete?: () => void | Promise<void>;
  /** Consumer-specific `IntentActionsMenu.Item`s placed before the destructive group. */
  extraItems?: React.ReactNode;
  align?: 'start' | 'end';
  className?: string;
}

type Confirmation = 'cancel' | 'delete';

export function IntentActionsMenu({
  intent,
  onConfiguration,
  onReshape,
  reshapeDisabledReason,
  onExport,
  exportDisabledReason,
  onAudit,
  onCancel,
  onDelete,
  extraItems,
  align = 'end',
  className,
}: IntentActionsMenuProps) {
  const [confirming, setConfirming] = React.useState<Confirmation | null>(null);
  const [busy, setBusy] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const pendingAction = React.useRef<(() => void) | null>(null);

  // Items run once the menu has unmounted and focus is back on the trigger:
  // a dialog opened from a still-mounted menu item has no element to return
  // focus to, and (modal menus) the menu's aria-hidden cleanup would undo the
  // dialog's own.
  const afterClose = (action: () => void) => () => {
    pendingAction.current = action;
  };
  const focusTriggerAndRunPending = (event: Event) => {
    event.preventDefault();
    triggerRef.current?.focus();
    const action = pendingAction.current;
    pendingAction.current = null;
    action?.();
  };
  const returnFocusToTrigger = (event: Event) => {
    event.preventDefault();
    triggerRef.current?.focus();
  };

  const hasPrimary = Boolean(onConfiguration || onReshape || onExport || onAudit || extraItems);
  const runActions: IntentRunActionItemsProps = {
    intent,
    onCancel: onCancel ? afterClose(() => setConfirming('cancel')) : undefined,
    onDelete: onDelete ? afterClose(() => setConfirming('delete')) : undefined,
    variant: 'page',
  };
  const hasDestructive = hasIntentRunActions(runActions);
  if (!hasPrimary && !hasDestructive) return null;

  const title = intent.title?.trim() || 'this intent';

  const runConfirmed = async () => {
    const action = confirming === 'cancel' ? onCancel : onDelete;
    if (!action) return;
    setBusy(true);
    try {
      await action();
    } catch {
      // The caller owns error reporting (it rendered the handler); the dialog just closes.
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const confirmation: CancelConfirmationCopy | null =
    confirming === 'cancel'
      ? cancelConfirmationCopy(intent)
      : confirming === 'delete'
        ? {
            title: 'Delete this intent?',
            description: `"${title}" and all of its documents, questions, discussions and run history will be permanently removed. This cannot be undone.`,
            keep: 'Keep intent',
            confirm: 'Delete intent',
          }
        : null;

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Intent actions"
            className={cn('h-8 w-8 text-muted-foreground', className)}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          className="min-w-56"
          onCloseAutoFocus={focusTriggerAndRunPending}
        >
          {onConfiguration ? (
            <DropdownMenuItem onSelect={afterClose(onConfiguration)}>
              <Settings2 aria-hidden="true" />
              Intent configuration
            </DropdownMenuItem>
          ) : null}
          {onReshape ? (
            <DropdownMenuItem
              onSelect={afterClose(onReshape)}
              disabled={Boolean(reshapeDisabledReason)}
            >
              <GitBranch aria-hidden="true" />
              <span className="flex min-w-0 flex-col">
                <span>Reshape remaining stages</span>
                {reshapeDisabledReason ? (
                  <span className="text-xs text-muted-foreground">{reshapeDisabledReason}</span>
                ) : null}
              </span>
            </DropdownMenuItem>
          ) : null}
          {onExport ? (
            <DropdownMenuItem
              onSelect={afterClose(onExport)}
              disabled={Boolean(exportDisabledReason)}
            >
              <Download aria-hidden="true" />
              <span className="flex min-w-0 flex-col">
                <span>Download workspace</span>
                {exportDisabledReason ? (
                  <span className="text-xs text-muted-foreground">{exportDisabledReason}</span>
                ) : null}
              </span>
            </DropdownMenuItem>
          ) : null}
          {onAudit ? (
            <DropdownMenuItem onSelect={afterClose(onAudit)}>
              <ScrollText aria-hidden="true" />
              Audit
            </DropdownMenuItem>
          ) : null}
          {extraItems}
          {hasPrimary && hasDestructive ? <DropdownMenuSeparator /> : null}
          {hasDestructive ? <IntentRunActionItems {...runActions} /> : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(null);
        }}
      >
        {confirmation ? (
          <AlertDialogContent onCloseAutoFocus={returnFocusToTrigger}>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmation.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirmation.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>{confirmation.keep}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={(event) => {
                  event.preventDefault();
                  void runConfirmed();
                }}
              >
                {busy ? <Loader2 aria-hidden="true" className="motion-safe:animate-spin" /> : null}
                {confirmation.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
  );
}

IntentActionsMenu.Item = DropdownMenuItem;
