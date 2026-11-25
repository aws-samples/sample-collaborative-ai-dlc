import { useState } from 'react';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { NativeExportSetupDialog } from '@/components/intent/NativeExportSetupDialog';
import { useReturnFocus } from '@/components/intent/useReturnFocus';
import {
  intentsService,
  type Intent,
  type NativeExportHarness,
  type NativeWorkflowExport,
} from '@/services/intents';

const NON_EXPORTABLE_STATUSES: ReadonlySet<Intent['status']> = new Set(['DRAFT', 'CREATED']);
const EXPORT_UNAVAILABLE_REASON = 'Not available before the workflow starts';
const EXPORT_HARNESSES: Array<{ value: NativeExportHarness; label: string }> = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'kiro', label: 'Kiro CLI' },
  { value: 'kiro-ide', label: 'Kiro IDE' },
  { value: 'opencode', label: 'OpenCode' },
];

export interface UseWorkspaceExportOptions {
  projectId: string;
  intentId: string;
  intent: Pick<Intent, 'status' | 'agentCli'>;
  projectName?: string | null;
  onError: (message: string) => void;
}

/**
 * "Download workspace" for every intent page: the confirmation (with the agent
 * tool the workspace is prepared for), the download itself, and the follow-up
 * setup dialog. Render `dialogs` once in the page; wire `open` and
 * `disabledReason` to the actions menu.
 */
export function useWorkspaceExport({
  projectId,
  intentId,
  intent,
  projectName,
  onError,
}: UseWorkspaceExportOptions) {
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [harness, setHarness] = useState<NativeExportHarness | undefined>();
  const [result, setResult] = useState<NativeWorkflowExport | null>(null);
  const returnFocus = useReturnFocus(confirming);
  const activeHarness = harness ?? intent.agentCli ?? undefined;

  const disabledReason = NON_EXPORTABLE_STATUSES.has(intent.status)
    ? EXPORT_UNAVAILABLE_REASON
    : exporting
      ? 'Preparing workspace…'
      : undefined;

  const run = async () => {
    setConfirming(false);
    setExporting(true);
    try {
      const exported = await intentsService.exportWorkflow(projectId, intentId, activeHarness);
      const download = document.createElement('a');
      download.href = exported.downloadUrl;
      download.download = exported.filename;
      download.rel = 'noopener';
      document.body.append(download);
      download.click();
      download.remove();
      if (exported.setup.showWorkspaceSetup || exported.warnings.length > 0) setResult(exported);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to export workflow');
    } finally {
      setExporting(false);
    }
  };

  const dialogs = (
    <>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!exporting) setConfirming(open);
        }}
      >
        <AlertDialogContent onCloseAutoFocus={returnFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Continue outside Collaborative AI-DLC?</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {intent.status === 'RUNNING'
                ? 'This download uses the latest completed workflow checkpoint and excludes the stage currently in progress. '
                : 'This download creates a point-in-time workspace. '}
              Work completed locally, including decisions, approvals, artifacts, and code changes,
              will not be synchronized back to this intent or included in its traceability history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="workspace-export-harness">Agent tool for the workspace</Label>
            <Select
              value={activeHarness ?? ''}
              onValueChange={(value) => setHarness(value as NativeExportHarness)}
              disabled={exporting}
            >
              <SelectTrigger id="workspace-export-harness" className="w-full sm:w-64">
                <SelectValue placeholder="Choose an agent tool" />
              </SelectTrigger>
              <SelectContent>
                {EXPORT_HARNESSES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={exporting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={exporting}
              onClick={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              {exporting ? 'Preparing workspace…' : 'Download workspace'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <NativeExportSetupDialog
        exportResult={result}
        projectName={projectName}
        onClose={() => setResult(null)}
      />
    </>
  );

  return { open: () => setConfirming(true), disabledReason, exporting, dialogs };
}
