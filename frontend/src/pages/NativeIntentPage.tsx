import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '@/services/api';
import {
  nativeIntentsService,
  type NativeIntent,
  type NativeExecution,
  type NativeRecovery,
  type NativeRecoveryRequest,
} from '@/services/nativeIntents';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NativeIntentContent } from '@/components/intent/NativeIntentContent';
import {
  clearNativeIntents,
  getNativeListing,
  useNativeListingVersion,
} from '@/hooks/useNativeIntents';
import {
  currentSessionEpoch,
  isSessionExpiryNotified,
  onSessionExpired,
} from '@/services/sessionExpiry';

const labels = {
  DRAFT: 'Draft',
  PREPARING: 'Preparing workspace',
  READY: 'Workspace ready',
  FAILED: 'Preparation failed',
};
const harnesses = { claude: 'Claude Code', codex: 'Codex', kiro: 'Kiro', opencode: 'OpenCode' };
const executionLabels: Record<NativeExecution['status'], string> = {
  REQUESTED: 'Start requested',
  UPGRADING: 'Preparing agent execution',
  DISPATCHING: 'Starting agent',
  RUNNING: 'Agent running',
  RECOVERY_REQUIRED: 'Session recovery required',
  RECOVERING: 'Restoring session',
  WAITING_FOR_INPUT: 'Waiting for input',
  AWAITING_USER: 'Awaiting your reply',
  STOPPED: 'Agent stopped',
  FAILED: 'Execution failed',
  CANCEL_REQUESTED: 'Cancellation requested',
  CANCELLED: 'Execution cancelled',
};
const activeExecution = new Set<NativeExecution['status']>([
  'REQUESTED',
  'UPGRADING',
  'DISPATCHING',
  'RUNNING',
  'RECOVERY_REQUIRED',
  'RECOVERING',
  'CANCEL_REQUESTED',
]);
const needsPolling = (intent: NativeIntent) =>
  intent.status === 'PREPARING' ||
  (intent.execution &&
    (activeExecution.has(intent.execution.status) ||
      intent.execution.status === 'AWAITING_USER' ||
      intent.execution.projectionStatus === 'pending'));
const accessFailure = (error: unknown): error is ApiError =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);
const recoveryMessages: Record<NativeRecovery['reason'], string> = {
  SESSION_LOST: 'The saved AI-DLC session needs to be restored before this run can continue.',
  RESTORE_FAILED:
    'The session could not be restored. Your committed content remains available below.',
  CHECKPOINT_UNAVAILABLE:
    'A verified recovery checkpoint is unavailable. Your committed content remains available below.',
  DELIVERY_UNCERTAIN:
    'The last agent turn could not be verified. Recovery needs review before continuing.',
};
const canRecover = (intent: NativeIntent) =>
  intent.executionAvailable === true &&
  intent.execution?.status === 'RECOVERY_REQUIRED' &&
  intent.execution.revision !== undefined &&
  intent.execution.recovery?.canRecover === true;
// Fixed public responses from lambda/native-runtime-control/api.js. Never
// render arbitrary ApiError.message/body text, even for a recognized code.
const nativeActionErrors: Record<string, readonly [number, string]> = {
  NATIVE_PREPARATION_INVALID: [400, 'Invalid native preparation request'],
  NATIVE_PREPARATION_CONFLICT: [409, 'Native intent changed or its immutable request conflicts'],
  NATIVE_PREPARATION_UNAVAILABLE: [503, 'Native preparation is unavailable; retry safely'],
  NATIVE_PREPARATION_DISABLED: [503, 'Native preparation is disabled'],
  NATIVE_PREPARATION_PACKAGE_INVALID: [409, 'A matching completed package import is required'],
  WORKFLOW_SOURCE_INVALID: [409, 'Workflow source must be reverified'],
  WORKFLOW_SOURCE_CONFLICT: [409, 'Workflow source changed; reload before retrying'],
  WORKFLOW_SOURCE_UNAVAILABLE: [503, 'Workflow source service unavailable'],
  native_package_job_invalid: [409, 'Package import state is invalid'],
  native_package_job_unavailable: [503, 'Package import service unavailable'],
  NATIVE_EXECUTION_DISABLED: [503, 'Native execution is disabled'],
  NATIVE_EXECUTION_INVALID: [400, 'Invalid native execution request'],
  NATIVE_EXECUTION_CONFLICT: [409, 'Native execution changed; refresh its status'],
  NATIVE_EXECUTION_UNAVAILABLE: [503, 'Native execution is unavailable; retry the same request'],
  NATIVE_EXECUTION_CREDENTIAL_REQUIRED: [
    409,
    'No credential is configured for the selected harness',
  ],
  NATIVE_EXECUTION_REPOSITORY_REQUIRED: [409, 'A connected application repository is required'],
  NATIVE_EXECUTION_REPOSITORY_AMBIGUOUS: [
    409,
    'The first native execution requires one application repository',
  ],
  NATIVE_EXECUTION_SOURCE_CHANGED: [
    409,
    'The repository binding changed; verify it before starting',
  ],
  NATIVE_EXECUTION_NOT_READY: [409, 'Prepare the native workspace before starting'],
  NATIVE_EXECUTION_LEASE_LOST: [409, 'Native execution ownership changed; refresh its status'],
  NATIVE_EXECUTION_CANCELLED: [409, 'Native execution was cancelled'],
  NATIVE_EXECUTION_CONFIG_INVALID: [409, 'Native execution configuration is invalid'],
  NATIVE_EXECUTION_CONFIG_UNAVAILABLE: [503, 'Native execution configuration is unavailable'],
  NATIVE_EXECUTION_CONFIG_NOT_READY: [409, 'Prepare the native workspace before starting'],
  NATIVE_EXECUTION_CONFIG_PROMPT_REQUIRED: [409, 'Add a prompt before starting native execution'],
  NATIVE_EXECUTION_CONFIG_PROJECT_CHANGED: [409, 'The project changed; reload before starting'],
  NATIVE_EXECUTION_CONFIG_REPOSITORY_REQUIRED: [
    409,
    'Link one application repository in project source-control settings',
  ],
  NATIVE_EXECUTION_CONFIG_REPOSITORY_AMBIGUOUS: [
    409,
    'The first native milestone requires exactly one application repository',
  ],
  NATIVE_EXECUTION_CONFIG_REPOSITORY_INVALID: [
    409,
    'Verify the application repository provider and identity',
  ],
  NATIVE_EXECUTION_CONFIG_SOURCE_CONTROL_REQUIRED: [
    409,
    'Verify the application repository source-control binding before starting',
  ],
  NATIVE_EXECUTION_CONFIG_SOURCE_CONTROL_CHANGED: [
    409,
    'The application repository binding changed; reload before starting',
  ],
  NATIVE_EXECUTION_CONFIG_CREDENTIAL_REQUIRED: [
    409,
    'Configure a credential for the selected coding harness before starting',
  ],
  NATIVE_EXECUTION_CONFIG_CREDENTIAL_INVALID: [
    409,
    'The selected coding harness credential binding could not be verified',
  ],
};
function nativeActionError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const code = error.body?.code;
  if (typeof code !== 'string' || !Object.hasOwn(nativeActionErrors, code)) return fallback;
  const [status, message] = nativeActionErrors[code];
  return error.status === status && error.body?.error === message ? message : fallback;
}
const nativeAccessRevision = (projectId: string) => getNativeListing(projectId).accessRevision ?? 0;
const detailTime = (value: NativeIntent) =>
  Math.max(Date.parse(value.updatedAt), Date.parse(value.execution?.updatedAt ?? value.updatedAt));
type LoadedIntent = { value: NativeIntent; accessRevision: number };
function acceptDetail(
  previous: LoadedIntent | null,
  next: NativeIntent,
  accessRevision: number,
): LoadedIntent {
  if (previous?.accessRevision === accessRevision) {
    const previousRevision = previous.value.execution?.revision;
    const nextRevision = next.execution?.revision;
    if (previous.value.execution && !next.execution) return previous;
    if (previousRevision !== undefined) {
      // Once a server revision is known, timestamps and legacy responses cannot
      // roll back recovered ownership or re-enable an older recovery action.
      if (nextRevision === undefined || nextRevision < previousRevision) return previous;
      if (nextRevision === previousRevision) {
        return {
          value: { ...next, execution: previous.value.execution },
          accessRevision,
        };
      }
    } else if (nextRevision === undefined && detailTime(previous.value) > detailTime(next)) {
      return previous;
    }
  }
  return { value: next, accessRevision };
}

export default function NativeIntentPage() {
  const { projectId = '', intentId = '' } = useParams();
  useNativeListingVersion();
  return (
    <NativeWorkspace
      key={JSON.stringify([projectId, intentId, currentSessionEpoch()])}
      projectId={projectId}
      intentId={intentId}
    />
  );
}

function NativeWorkspace({ projectId, intentId }: { projectId: string; intentId: string }) {
  const [loaded, setLoaded] = useState<LoadedIntent | null>(null);
  const accessRevision = nativeAccessRevision(projectId);
  // Hide revoked detail during render, before effects or any late promise run.
  const intent =
    loaded?.accessRevision === accessRevision && !isSessionExpiryNotified() ? loaded.value : null;
  const polling = intent ? Boolean(needsPolling(intent)) : false;
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [acting, setActing] = useState<'start' | 'cancel' | 'recover' | null>(null);
  const actionInFlight = useRef<'start' | 'cancel' | 'recover' | null>(null);
  const startRequestId = useRef<string | null>(null);
  const recoveryRequest = useRef<NativeRecoveryRequest | null>(null);
  const generation = useRef(0);
  const epoch = useRef(currentSessionEpoch());
  const current = useCallback(
    (requestGeneration: number, requestAccessRevision: number) =>
      requestGeneration === generation.current &&
      epoch.current === currentSessionEpoch() &&
      !isSessionExpiryNotified() &&
      requestAccessRevision === nativeAccessRevision(projectId),
    [projectId],
  );
  useEffect(
    () =>
      onSessionExpired(() => {
        generation.current += 1;
        setLoaded(null);
        setPreparing(false);
        setActing(null);
        actionInFlight.current = null;
        setError('Your session expired. Sign in again to read this native intent.');
      }),
    [],
  );
  useEffect(() => {
    // Disabled project listings retain their presentation, but their 403 also
    // advances the access revision and must discard loaded detail and requests.
    if (!getNativeListing(projectId).denied && accessRevision === 0) return;
    generation.current += 1;
    setLoaded(null);
    setPreparing(false);
    setActing(null);
    actionInFlight.current = null;
    setError('Native intent access is no longer available. Refresh status to check access.');
  }, [projectId, accessRevision]);
  const handleFailure = useCallback(
    (err: unknown, fallback: string, requestGeneration: number, requestAccessRevision: number) => {
      if (!current(requestGeneration, requestAccessRevision)) return;
      if (accessFailure(err)) {
        // Also invalidate requests already in flight: their late success must
        // not restore details after an authoritative denial.
        generation.current += 1;
        clearNativeIntents(projectId, true);
        setLoaded(null);
        setPreparing(false);
        setActing(null);
        actionInFlight.current = null;
        setError('Native intent access is no longer available. Refresh status to check access.');
      } else {
        setError(fallback);
      }
    },
    [projectId, current],
  );
  const refresh = useCallback(async () => {
    const requestGeneration = generation.current;
    const requestAccessRevision = nativeAccessRevision(projectId);
    try {
      const next = await nativeIntentsService.get(projectId, intentId);
      if (!current(requestGeneration, requestAccessRevision)) return;
      setLoaded((previous) => acceptDetail(previous, next, requestAccessRevision));
      setError(null);
    } catch (err) {
      handleFailure(
        err,
        nativeActionError(
          err,
          'Status could not be refreshed. The last confirmed status is shown.',
        ),
        requestGeneration,
        requestAccessRevision,
      );
    }
  }, [projectId, intentId, handleFailure, current]);

  useEffect(() => {
    let active = true;
    const requestGeneration = generation.current;
    const requestAccessRevision = nativeAccessRevision(projectId);
    nativeIntentsService
      .get(projectId, intentId)
      .then((next) => {
        if (!active || !current(requestGeneration, requestAccessRevision)) return;
        setLoaded((previous) => acceptDetail(previous, next, requestAccessRevision));
        setError(null);
      })
      .catch((err) => {
        if (active)
          handleFailure(
            err,
            nativeActionError(err, 'This native intent could not be verified or loaded.'),
            requestGeneration,
            requestAccessRevision,
          );
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [projectId, intentId, handleFailure, current]);

  useEffect(() => {
    if (!polling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const requestGeneration = generation.current;
      const requestAccessRevision = nativeAccessRevision(projectId);
      try {
        const next = await nativeIntentsService.get(projectId, intentId);
        if (!active || !current(requestGeneration, requestAccessRevision)) return;
        setLoaded((previous) => acceptDetail(previous, next, requestAccessRevision));
        setError(null);
        // The effect stops on an accepted terminal state. A stale response
        // rejected by acceptDetail must not stop polling the newer execution.
      } catch (err) {
        if (!active || !current(requestGeneration, requestAccessRevision)) return;
        handleFailure(
          err,
          'Status could not be refreshed. The last confirmed status is shown; work may still be continuing.',
          requestGeneration,
          requestAccessRevision,
        );
        if (accessFailure(err)) return;
      }
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [polling, projectId, intentId, handleFailure, current]);

  const prepare = async () => {
    if (preparing) return;
    const requestGeneration = generation.current;
    const requestAccessRevision = nativeAccessRevision(projectId);
    setPreparing(true);
    setError(null);
    try {
      const next = await nativeIntentsService.prepare(projectId, intentId);
      if (!current(requestGeneration, requestAccessRevision)) return;
      setLoaded((previous) => acceptDetail(previous, next, requestAccessRevision));
    } catch (err) {
      handleFailure(
        err,
        nativeActionError(err, 'Preparation could not be confirmed. Retry the same intent.'),
        requestGeneration,
        requestAccessRevision,
      );
    } finally {
      if (current(requestGeneration, requestAccessRevision)) setPreparing(false);
    }
  };

  const execute = async (action: 'start' | 'cancel' | 'recover') => {
    if (!intent || actionInFlight.current) return;
    if (
      action === 'start' &&
      (intent.status !== 'READY' || intent.executionAvailable !== true || intent.execution)
    )
      return;
    if (action === 'recover' && !canRecover(intent)) return;
    actionInFlight.current = action;
    setActing(action);
    setError(null);
    const requestGeneration = generation.current;
    const requestAccessRevision = nativeAccessRevision(projectId);
    try {
      // Keep this identity after an uncertain response. The server owns durable
      // deduplication, including reloads and starts submitted by another member.
      let next: NativeIntent;
      if (action === 'recover') {
        const recoveryId = intent.execution!.recovery!.id;
        if (recoveryRequest.current?.recoveryId !== recoveryId)
          recoveryRequest.current = { requestId: crypto.randomUUID(), recoveryId };
        next = await nativeIntentsService.recover(projectId, intentId, recoveryRequest.current);
      } else if (action === 'start') {
        next = await nativeIntentsService.start(
          projectId,
          intentId,
          (startRequestId.current ??= crypto.randomUUID()),
        );
      } else {
        next = await nativeIntentsService.cancel(projectId, intentId);
      }
      if (!current(requestGeneration, requestAccessRevision)) return;
      setLoaded((previous) => acceptDetail(previous, next, requestAccessRevision));
    } catch (err) {
      handleFailure(
        err,
        nativeActionError(
          err,
          `${action === 'start' ? 'Start' : action === 'recover' ? 'Recovery' : 'Cancellation'} could not be confirmed. Refresh status or retry the same request.`,
        ),
        requestGeneration,
        requestAccessRevision,
      );
      if (action === 'recover' && current(requestGeneration, requestAccessRevision)) void refresh();
    } finally {
      if (current(requestGeneration, requestAccessRevision)) {
        actionInFlight.current = null;
        setActing(null);
      }
    }
  };
  const publicationFailure = useCallback(
    (err: unknown) => {
      handleFailure(
        err,
        'Published content is no longer accessible.',
        generation.current,
        nativeAccessRevision(projectId),
      );
    },
    [projectId, handleFailure],
  );

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-6xl space-y-5">
        <Link className="text-sm underline" to={`/space/${projectId}`}>
          Back to space
        </Link>
        <h1 className="text-xl font-semibold">{intent?.title || 'Native intent'}</h1>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!intent ? (
          <Button variant="outline" onClick={() => void refresh()}>
            Refresh status
          </Button>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Badge variant="outline">Native</Badge>
              <p role="status" className="font-medium">
                {intent.execution
                  ? intent.execution.status === 'DISPATCHING' &&
                    (intent.execution.responsePending === true ||
                      (intent.execution.turnSequence ?? 1) > 1)
                    ? 'Continuing agent'
                    : executionLabels[intent.execution.status]
                  : labels[intent.status]}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              {harnesses[intent.harness]} · {intent.package.source.repository} ·{' '}
              {intent.package.source.release}
            </p>
            {intent.execution && (
              <div className="space-y-1 text-sm text-muted-foreground">
                {intent.execution.model && <p>Model: {intent.execution.model}</p>}
                {intent.execution.repository.repository && (
                  <p className="break-all">
                    Repository: {intent.execution.repository.provider} ·{' '}
                    {intent.execution.repository.repository}
                    {intent.execution.repository.branch &&
                      ` · ${intent.execution.repository.branch}`}
                    {intent.execution.repository.commit &&
                      ` · ${intent.execution.repository.commit}`}
                  </p>
                )}
                <p>Started {new Date(intent.execution.startedAt).toLocaleString()}</p>
                {intent.execution.failureCode && <p>Failure: {intent.execution.failureCode}</p>}
              </div>
            )}
            <p className="text-sm">
              {intent.execution
                ? intent.execution.status === 'RECOVERING'
                  ? 'Restoring the saved AI-DLC session. You can leave this page and return to the same link.'
                  : intent.execution.status === 'RECOVERY_REQUIRED'
                    ? intent.execution.recovery
                      ? recoveryMessages[intent.execution.recovery.reason]
                      : 'Session recovery is required. Refresh status to check whether recovery is available.'
                    : intent.execution.status === 'WAITING_FOR_INPUT'
                      ? 'The workflow is waiting. Published files and its question appear below once available.'
                      : intent.execution.status === 'AWAITING_USER'
                        ? 'AI-DLC is waiting for your reply.'
                        : intent.execution.status === 'STOPPED'
                          ? 'The agent turn stopped. This does not establish that the workflow is complete.'
                          : intent.execution.status === 'CANCELLED'
                            ? 'Cancellation is confirmed. Any committed revision remains available below.'
                            : intent.execution.status === 'FAILED'
                              ? 'Execution reported an error. Any committed revision remains available below.'
                              : 'This run uses its own runtime and workspace. You can leave this page and return to the same link.'
                : intent.status === 'READY'
                  ? 'This run has its own verified workspace. The agent has not started.'
                  : intent.status === 'PREPARING'
                    ? 'Preparing and verifying a separate runtime and workspace for this run. You can leave this page and return to the same link.'
                    : intent.status === 'FAILED'
                      ? 'Preparation stopped with an error. The run identity and any created resources are retained for diagnosis and retry.'
                      : 'Prepare a separate workspace for this native intent before agent execution is enabled.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {intent.status !== 'READY' && (
                <Button onClick={() => void prepare()} disabled={preparing}>
                  {preparing
                    ? 'Requesting preparation…'
                    : intent.status === 'DRAFT'
                      ? 'Prepare workspace'
                      : 'Retry preparation'}
                </Button>
              )}
              <Button variant="outline" onClick={() => void refresh()}>
                Refresh status
              </Button>
              {canRecover(intent) && (
                <Button onClick={() => void execute('recover')} disabled={acting !== null}>
                  {acting === 'recover' ? 'Requesting recovery…' : 'Recover session'}
                </Button>
              )}
              <Button
                onClick={() => void execute('start')}
                disabled={
                  intent.status !== 'READY' ||
                  intent.executionAvailable !== true ||
                  Boolean(intent.execution) ||
                  acting !== null
                }
              >
                {acting === 'start' ? 'Requesting start…' : 'Start agent'}
              </Button>
              {intent.execution &&
                (activeExecution.has(intent.execution.status) ||
                  intent.execution.status === 'WAITING_FOR_INPUT' ||
                  intent.execution.status === 'AWAITING_USER') && (
                  <Button
                    variant="outline"
                    onClick={() => void execute('cancel')}
                    disabled={acting !== null || intent.execution.status === 'CANCEL_REQUESTED'}
                  >
                    {acting === 'cancel' ? 'Requesting cancellation…' : 'Cancel execution'}
                  </Button>
                )}
            </div>
            <div className="space-y-3 rounded-md border p-4">
              <p className="text-sm text-muted-foreground">
                File-question answers, approvals, artifact editing, unit pull requests and deletion
                are not enabled yet.
                {!intent.execution &&
                  intent.executionAvailable !== true &&
                  ' Agent execution is not enabled for this draft.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  'Answer question',
                  'Approve',
                  'Edit artifacts',
                  'Create unit PR',
                  'Delete intent',
                ].map((action) => (
                  <Button key={action} variant="outline" disabled>
                    {action}
                  </Button>
                ))}
              </div>
            </div>
            <NativeIntentContent
              intent={intent}
              onAccessFailure={publicationFailure}
              onRefresh={refresh}
            />
          </>
        )}
      </div>
    </div>
  );
}
