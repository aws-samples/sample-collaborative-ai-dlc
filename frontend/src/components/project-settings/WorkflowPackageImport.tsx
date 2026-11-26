import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativePreparationLink } from '@/components/intent/NativePreparationLink';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  isNativePackageJobsDisabled,
  isWorkflowPackageRelease,
  isWorkflowSourceApiDisabled,
  workflowPackageImportRecovery,
  workflowSourcesService,
  type WorkflowPackageImportRequest,
  type WorkflowPackageJob,
  type WorkflowSource,
} from '@/services/workflowSources';

interface Props {
  projectId: string;
  source: WorkflowSource;
  suspended?: boolean;
}

const statusOf = (error: unknown) =>
  typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
const isRejected = (error: unknown) => {
  const status = statusOf(error);
  return (
    isNativePackageJobsDisabled(error) ||
    isWorkflowSourceApiDisabled(error) ||
    (typeof status === 'number' && status >= 400 && status < 500)
  );
};
const failureMessage = (error: unknown) => {
  switch (statusOf(error)) {
    case 400:
      return 'The import request was rejected. Check the release and reload workflow sources.';
    case 401:
    case 403:
      return 'Source access is unavailable. Reload workflow sources before continuing.';
    case 409:
      return 'This import or workflow source changed. Reload workflow sources before continuing.';
    case 404:
      return 'Import not found. Retry the same import after checking source access.';
    default:
      return 'Import status could not be confirmed. Check status or retry the same import.';
  }
};
const HARNESSES = { claude: 'Claude', codex: 'Codex', kiro: 'Kiro', opencode: 'OpenCode' };

export function WorkflowPackageImport(props: Props) {
  const { userId, isAuthenticated, isLoading } = useAuthSession();
  if (props.source.status !== 'active' || !userId || !isAuthenticated || isLoading) return null;
  // An old request can never update a new project/source/revision, including
  // leaving and returning to the same source while a response is in flight.
  return (
    <PackageImportForm
      key={JSON.stringify([userId, props.projectId, props.source.sourceId, props.source.revision])}
      {...props}
      userId={userId}
    />
  );
}

function PackageImportForm({
  projectId,
  source,
  userId,
  suspended = false,
}: Props & { userId: string }) {
  const id = useId();
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const context = useMemo(
    () => ({ userId, projectId, sourceId: source.sourceId, revision: source.revision }),
    [userId, projectId, source.sourceId, source.revision],
  );
  const [request, setRequest] = useState<WorkflowPackageImportRequest | null>(() =>
    workflowPackageImportRecovery.read(context),
  );
  const activeRequest = useRef(request);
  const restore = useRef(request);
  const [mode, setMode] = useState<'latest' | 'version'>(
    request && request.requestedRelease !== 'latest' ? 'version' : 'latest',
  );
  const [version, setVersion] = useState(
    request && request.requestedRelease !== 'latest' ? request.requestedRelease : '',
  );
  const [job, setJob] = useState<WorkflowPackageJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (action: 'submit' | 'status', original: WorkflowPackageImportRequest) => {
      const isCurrent = () => mounted.current && activeRequest.current === original;
      if (inFlight.current || !isCurrent() || suspended) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        let result: WorkflowPackageJob;
        if (action === 'submit') {
          try {
            result = await workflowSourcesService.createPackageImport(
              projectId,
              source.sourceId,
              original,
            );
          } catch (cause) {
            if (!isCurrent()) return;
            if (isRejected(cause)) throw cause;
            // POST may have committed even if its HTTP response was lost.
            // Recovery reads the original ID; it never submits a new latest.
            result = await workflowSourcesService.getPackageImport(
              projectId,
              source.sourceId,
              original.jobId,
            );
          }
        } else {
          result = await workflowSourcesService.getPackageImport(
            projectId,
            source.sourceId,
            original.jobId,
          );
        }
        if (!isCurrent()) return;
        if (
          result.jobId !== original.jobId ||
          result.sourceId !== source.sourceId ||
          result.requestedRelease !== original.requestedRelease
        ) {
          throw new Error('Import status did not match the request.');
        }
        setJob(result);
        setRejected(false);
      } catch (cause) {
        if (!isCurrent()) return;
        setJob(null);
        if (isNativePackageJobsDisabled(cause) || isWorkflowSourceApiDisabled(cause)) {
          setDisabled(true);
        } else {
          setRejected(isRejected(cause) && statusOf(cause) !== 404);
          setMessage(failureMessage(cause));
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [projectId, source.sourceId, suspended],
  );

  useEffect(() => {
    if (!restore.current || suspended) return;
    const original = restore.current;
    restore.current = null;
    void run('status', original);
  }, [run, suspended]);

  useEffect(() => {
    if (
      !request ||
      !job ||
      (job.state !== 'QUEUED' && job.state !== 'RUNNING') ||
      busy ||
      suspended ||
      disabled ||
      message
    ) {
      return;
    }
    const timer = window.setTimeout(() => void run('status', request), 3000);
    return () => window.clearTimeout(timer);
  }, [request, job, busy, suspended, disabled, message, run]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (activeRequest.current || inFlight.current || suspended || disabled) return;
    const requestedRelease = mode === 'latest' ? 'latest' : version.trim();
    if (
      !isWorkflowPackageRelease(requestedRelease) ||
      (mode === 'version' && requestedRelease === 'latest')
    ) {
      setMessage('Enter a release such as v2.9.0 or v2.10.0-preview.20260918.1.');
      return;
    }
    let jobId: string;
    try {
      jobId = crypto.randomUUID();
    } catch {
      setMessage('Could not create an import request ID. Reload this page and try again.');
      return;
    }
    const original = {
      jobId,
      expectedRevision: source.revision,
      requestedRelease,
    };
    // Persist before POST: a remount must retain the same key even when the
    // server committed a request whose response never reached this component.
    if (!workflowPackageImportRecovery.save(context, original)) {
      setMessage(
        'Could not retain the import request in this browser session. Enable session storage and try again.',
      );
      return;
    }
    activeRequest.current = original;
    setRequest(original);
    void run('submit', original);
  };

  const clearRequest = () => {
    if (inFlight.current || suspended) return;
    if (!workflowPackageImportRecovery.clear(context)) {
      setMessage('Could not clear the previous import request in this browser session.');
      return;
    }
    // A timer callback may already be queued before React removes its effect.
    // Invalidate it synchronously, before another request can use this form.
    activeRequest.current = null;
    setRequest(null);
    setJob(null);
    setMessage(null);
    setRejected(false);
    setClearing(false);
  };

  if (disabled) {
    return <p className="text-xs text-muted-foreground">Package imports are disabled.</p>;
  }
  const terminal = job?.state === 'SUCCEEDED' || job?.state === 'FAILED';
  const locked = suspended || busy || request !== null;

  return (
    <div className="space-y-3 border-t pt-3">
      <form className="space-y-2" onSubmit={submit}>
        <Label htmlFor={`${id}-release`}>Package release</Label>
        <select
          id={`${id}-release`}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={mode}
          disabled={locked}
          onChange={(event) => setMode(event.target.value === 'version' ? 'version' : 'latest')}
        >
          <option value="latest">Latest stable</option>
          <option value="version">Specific version</option>
        </select>
        {mode === 'version' && (
          <div className="space-y-1">
            <Label htmlFor={`${id}-version`}>Release version</Label>
            <Input
              id={`${id}-version`}
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="v2.9.0"
              maxLength={256}
              required
              disabled={locked}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Latest selects the highest stable release from this source. Importing verifies release
          files; it does not run a coding agent.
        </p>
        {!request && (
          <Button type="submit" size="sm" disabled={suspended || busy}>
            Import package
          </Button>
        )}
      </form>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      {request && (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {job?.state === 'SUCCEEDED'
              ? 'Download verified'
              : job?.state === 'FAILED'
                ? 'Package import failed. Check source access and release files before starting a new import.'
                : job?.state === 'RUNNING'
                  ? 'Importing package'
                  : job?.state === 'QUEUED'
                    ? 'Import queued'
                    : busy
                      ? 'Confirming import status'
                      : 'Import status unconfirmed'}
          </p>
          <p className="break-all text-xs text-muted-foreground">Import ID: {request.jobId}</p>
          {job?.state === 'SUCCEEDED' && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">Package preview</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt>Release</dt>
                <dd>{job.package.release}</dd>
                <dt>Commit</dt>
                <dd className="break-all">{job.package.commit}</dd>
                <dt>Included harnesses</dt>
                <dd>{job.package.harnesses.map((harness) => HARNESSES[harness]).join(', ')}</dd>
              </dl>
              <p className="text-xs text-muted-foreground">
                Download bytes verified. Signature not checked. Harness execution not qualified.
              </p>
              {!suspended && (
                <NativePreparationLink
                  projectId={projectId}
                  sourceId={source.sourceId}
                  packageJobId={job.jobId}
                  bindingRevision={source.revision}
                />
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {!terminal && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || suspended}
                onClick={() => void run('status', request)}
              >
                Check status
              </Button>
            )}
            {!job && !rejected && !busy && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={suspended}
                onClick={() => void run('submit', request)}
              >
                Retry same import
              </Button>
            )}
            {terminal && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || suspended}
                onClick={clearRequest}
              >
                Choose another release
              </Button>
            )}
            {!terminal && !clearing && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy || suspended}
                onClick={() => setClearing(true)}
              >
                Clear saved request
              </Button>
            )}
          </div>
          {!terminal && clearing && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                This clears the saved request in this browser session. An existing import may
                continue; this does not cancel it. You can then choose a release and submit a new
                import.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || suspended}
                  onClick={clearRequest}
                >
                  Clear and choose release
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || suspended}
                  onClick={() => setClearing(false)}
                >
                  Keep saved request
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
