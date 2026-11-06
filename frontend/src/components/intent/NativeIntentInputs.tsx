import { NativeApplicationSourcePicker } from './NativeApplicationSourcePicker';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { IntentSourcePicker } from '@/components/IntentSourcePicker';
import { AttachmentFilePicker } from './AttachmentFilePicker';
import {
  TrackerAttachmentImport,
  type TrackerAttachmentImportService,
} from './TrackerAttachmentImport';
import { Button } from '@/components/ui/button';
import {
  nativeIntentsService,
  type NativeIntent,
  type NativeInputOperation,
} from '@/services/nativeIntents';
import { attachmentType, uploadAttachmentFile } from '@/services/attachmentUploads';

export function NativeIntentInputs({
  intent,
  disabled,
  onBusyChange,
  onRefresh,
  onAccessFailure,
}: {
  intent: NativeIntent;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onRefresh: () => Promise<unknown>;
  onAccessFailure: (error: unknown) => void;
}) {
  const editable =
    !intent.execution && intent.inputRevision !== undefined && Boolean(intent.inputs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const current = useRef(intent);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    // A polling response cannot change an in-flight operation's selected source.
    if (!busy && (intent.inputRevision ?? 0) >= (current.current.inputRevision ?? 0))
      current.current = intent;
  }, [intent, busy]);
  const updateBusy = useCallback(
    (value: boolean) => {
      if (mounted.current) {
        setBusy(value);
        onBusyChange(value);
      }
    },
    [onBusyChange],
  );
  const mutate = useCallback(async (operation: NativeInputOperation) => {
    const before = current.current;
    const result = await nativeIntentsService.inputs(
      before.projectId,
      before.id,
      before.inputRevision!,
      operation,
    );
    if (mounted.current) current.current = result.intent;
    return result;
  }, []);
  const refresh = useCallback(() => {
    void onRefresh();
  }, [onRefresh]);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy || disabled) return;
    updateBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      if (mounted.current) {
        setError(
          'The input change could not be completed. Review the refreshed draft and retry or remove the input.',
        );
        onAccessFailure(failure);
      }
    } finally {
      await onRefresh();
      if (mounted.current) {
        updateBusy(false);
        setProgress(null);
      }
    }
  };
  const trackerService = useMemo<TrackerAttachmentImportService>(
    () => ({
      recordSkippedSelections: true,
      async trackerAttachments() {
        const result = await mutate({ operation: 'discover' });
        if (!result.discovery) throw new Error('Source attachment discovery is unavailable.');
        return result.discovery;
      },
      async importTrackerAttachment(_projectId, _intentId, id) {
        const result = await mutate({ operation: 'import', attachmentId: id });
        if (!result.importResult)
          throw new Error('Import could not be confirmed. Refresh the draft.');
        return result.importResult;
      },
    }),
    [mutate],
  );
  const files = intent.inputs;
  return (
    <section aria-label="Native inputs" className="space-y-4 rounded-md border p-4">
      <h2 className="font-medium">
        {intent.execution ? 'Captured inputs' : 'Inputs and application source'}
      </h2>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {editable && (
        <>
          <NativeSourcePicker
            intent={intent}
            disabled={disabled || busy}
            onChange={(operation) => void run(() => mutate(operation))}
          />
          <AttachmentFilePicker
            disabled={disabled || busy}
            onFiles={(selected) => {
              const chosen = Array.from(selected ?? []);
              void run(async () => {
                for (const file of chosen) {
                  const mimeType = attachmentType(file);
                  if (!mimeType || file.size < 1 || file.size > 5 * 1024 * 1024)
                    throw new Error('Unsupported attachment type or size');
                  const sha256 = Array.from(
                    new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
                  )
                    .map((byte) => byte.toString(16).padStart(2, '0'))
                    .join('');
                  const attachmentId = crypto.randomUUID();
                  const result = await mutate({
                    operation: 'upload',
                    attachmentId,
                    filename: file.name,
                    mimeType,
                    size: file.size,
                    sha256,
                  });
                  if (!result.upload) throw new Error('Upload allocation could not be confirmed');
                  await uploadAttachmentFile(result.upload, file, setProgress);
                  await mutate({ operation: 'complete', attachmentId });
                }
              });
            }}
          />
          {progress !== null && (
            <p role="status" className="text-xs">
              Uploading: {progress}%
            </p>
          )}
          {files?.source && (
            <TrackerAttachmentImport
              key={`${files.source.bindingId}:${files.source.resourceId}`}
              projectId={intent.projectId}
              intentId={intent.id}
              service={trackerService}
              autoImport={false}
              disabled={disabled}
              onAutoImportStarted={() => {}}
              onBusyChange={(value) => {
                updateBusy(value);
                if (!value) refresh();
              }}
              onImported={refresh}
            />
          )}
        </>
      )}
      <ul className="space-y-2 text-sm">
        {files?.attachments.map((file) => (
          <li key={file.attachmentId} className="flex flex-wrap items-center gap-2">
            <span>
              {file.filename} ({file.size} bytes){file.source ? ` — ${file.source.title}` : ''}
            </span>
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || busy}
                onClick={() =>
                  void run(() => mutate({ operation: 'remove', attachmentId: file.attachmentId }))
                }
              >
                Remove {file.filename}
              </Button>
            )}
            {intent.execution && file.sha256 && (
              <code className="w-full break-all text-xs">SHA-256 {file.sha256}</code>
            )}
          </li>
        ))}
        {files?.pendingUploads.map((file) => (
          <li key={file.attachmentId}>
            {file.filename}: upload not confirmed
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || busy}
                onClick={() =>
                  void run(() => mutate({ operation: 'complete', attachmentId: file.attachmentId }))
                }
              >
                Check upload
              </Button>
            )}
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || busy}
                onClick={() =>
                  void run(() => mutate({ operation: 'remove', attachmentId: file.attachmentId }))
                }
              >
                Remove pending upload
              </Button>
            )}
          </li>
        ))}
        {files?.imports.map((item) => (
          <li key={item.id}>
            Selected import: {item.status}. {item.reason}
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || busy}
                onClick={() =>
                  void run(() => mutate({ operation: 'exclude-import', attachmentId: item.id }))
                }
              >
                Exclude selected import
              </Button>
            )}
          </li>
        ))}
      </ul>
      {Boolean(files?.pendingUploads.length || files?.imports.length) && (
        <p role="status" className="text-sm">
          Start is blocked until each pending input is confirmed or explicitly removed.
        </p>
      )}
      {intent.inputRevision !== undefined && (
        <p className="text-xs text-muted-foreground">Input revision {intent.inputRevision}</p>
      )}
    </section>
  );
}

function NativeSourcePicker({
  intent,
  disabled,
  onChange,
}: {
  intent: NativeIntent;
  disabled: boolean;
  onChange: (operation: NativeInputOperation) => void;
}) {
  const { project } = useProjectCache(intent.projectId);
  const [pickTracker, setPickTracker] = useState(false);
  const trackerProject = project
    ? {
        ...project,
        trackers: project.trackers.filter((binding) =>
          ['github-issues', 'gitlab-issues', 'jira-cloud'].includes(binding.provider),
        ),
      }
    : null;
  const sourceValue = intent.applicationSource
    ? JSON.stringify([intent.applicationSource.provider, intent.applicationSource.repository])
    : '';
  return (
    <>
      <NativeApplicationSourcePicker
        repos={project?.repos}
        value={sourceValue}
        disabled={disabled || !project}
        onChange={(value) => {
          const [provider, repository] = JSON.parse(value);
          onChange({ operation: 'source', applicationSource: { provider, repository } });
        }}
      />
      {trackerProject && trackerProject.trackers.length > 0 && (
        <>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => setPickTracker(!pickTracker)}
          >
            Import tracker issue text
          </Button>
          <p className="text-xs text-muted-foreground">
            Import the issue and its discussion as a reference file. Your written request stays
            editable. Attachments are imported separately below; failed files require retry or
            explicit exclusion.
          </p>
          {pickTracker && !disabled && (
            <IntentSourcePicker
              project={trackerProject}
              selected={intent.inputs!.source}
              onSelect={(issue, binding) => {
                setPickTracker(false);
                onChange({
                  operation: 'tracker',
                  bindingId: binding.id,
                  resourceId: issue.resourceId,
                });
              }}
            />
          )}
        </>
      )}
    </>
  );
}
