import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/services/api';
import {
  nativeIntentsService,
  type NativeIntent,
  type NativeExecution,
  type NativeRecovery,
  type NativeRecoveryRequest,
  type NativePromptRequest,
  nativePromptValid,
} from '@/services/nativeIntents';
import {
  clearNativeIntents,
  updateNativeIntentSummary,
  getNativeListing,
  useNativeListingVersion,
} from '@/hooks/useNativeIntents';
import {
  currentSessionEpoch,
  isSessionExpiryNotified,
  onSessionExpired,
} from '@/services/sessionExpiry';

export {
  nativePreparationLabels as labels,
  nativeExecutionLabels as executionLabels,
} from '@/lib/intentDiscovery';
export const harnesses = {
  claude: 'Claude Code',
  codex: 'Codex',
  kiro: 'Kiro',
  opencode: 'OpenCode',
};
export const activeExecution = new Set<NativeExecution['status']>([
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
      // Waiting runs remain cancellable after their publication is projected.
      intent.execution.status === 'WAITING_FOR_INPUT' ||
      intent.execution.status === 'AWAITING_USER' ||
      intent.execution.projectionStatus === 'pending'));
const accessFailure = (error: unknown): error is ApiError =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);
export const recoveryMessages: Record<NativeRecovery['reason'], string> = {
  SESSION_LOST: 'The saved AI-DLC session needs to be restored before this run can continue.',
  RESTORE_FAILED:
    'The session could not be restored. Your committed content remains available below.',
  CHECKPOINT_UNAVAILABLE:
    'A verified recovery checkpoint is unavailable. Your committed content remains available below.',
  DELIVERY_UNCERTAIN:
    'The last command may have executed. Inspect work and export its exact results; this command cannot be replayed through recovery.',
};
export const imageBlocked = (intent: NativeIntent) =>
  ['revoked', 'unapproved', 'unavailable'].includes(intent.execution?.imageStatus ?? '');
export const canRecover = (intent: NativeIntent) =>
  !imageBlocked(intent) &&
  intent.executionAvailable === true &&
  intent.execution?.status === 'RECOVERY_REQUIRED' &&
  intent.execution.revision !== undefined &&
  intent.execution.recovery?.canRecover === true;
// Fixed public responses from lambda/native-runtime-control/api.js. Never
// render arbitrary ApiError.message/body text, even for a recognized code.
const nativeActionErrors: Record<string, readonly [number, string]> = {
  NATIVE_PROMPT_INVALID: [400, 'Enter a nonblank prompt of at most 64 KiB without null characters'],
  NATIVE_PROMPT_CONFLICT: [
    409,
    'The prompt or native intent changed. Refresh before editing or starting',
  ],
  NATIVE_PROMPT_UNAVAILABLE: [503, 'Prompt saving could not be confirmed. Retry the same save'],
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
    if ((previous.value.promptRevision ?? 0) > (next.promptRevision ?? 0)) return previous;
    const previousRevision = previous.value.execution?.revision;
    const nextRevision = next.execution?.revision;
    if (previous.value.execution && !next.execution) return previous;
    if (previousRevision !== undefined && previous.value.execution) {
      // Once a server revision is known, timestamps and legacy responses cannot
      // roll back recovered ownership or re-enable an older recovery action.
      if (nextRevision === undefined || nextRevision < previousRevision) return previous;
      if (nextRevision === previousRevision) {
        return {
          value: {
            ...next,
            execution: { ...previous.value.execution, imageStatus: next.execution?.imageStatus },
          },
          accessRevision,
        };
      }
    } else if (nextRevision === undefined && detailTime(previous.value) > detailTime(next)) {
      return previous;
    }
  }
  return { value: next, accessRevision };
}

export function useNativeIntentAdapter(projectId: string, intentId: string) {
  useNativeListingVersion();
  const [loaded, setLoaded] = useState<LoadedIntent | null>(null);
  const accessRevision = nativeAccessRevision(projectId);
  // Hide revoked detail during render, before effects or any late promise run.
  const intent =
    loaded?.accessRevision === accessRevision && !isSessionExpiryNotified() ? loaded.value : null;
  useEffect(() => {
    if (intent) updateNativeIntentSummary(intent);
  }, [intent]);
  const polling = intent ? Boolean(needsPolling(intent)) : false;
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [acting, setActing] = useState<'start' | 'cancel' | 'recover' | null>(null);
  const actionInFlight = useRef<'start' | 'cancel' | 'recover' | null>(null);
  const startRequest = useRef<{ requestId: string; promptRevision?: number } | null>(null);
  const [startPending, setStartPending] = useState(false);
  const [startConflict, setStartConflict] = useState(false);
  const [promptDraft, setPromptDraft] = useState<{ text: string; expectedRevision: number } | null>(
    null,
  );
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [promptUncertain, setPromptUncertain] = useState(false);
  const promptRequest = useRef<NativePromptRequest | null>(null);
  const promptInFlight = useRef(false);
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
        setPromptDraft(null);
        promptRequest.current = null;
        setPromptUncertain(false);
        setSavingPrompt(false);
        promptInFlight.current = false;
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
    setPromptDraft(null);
    promptRequest.current = null;
    setPromptUncertain(false);
    setSavingPrompt(false);
    promptInFlight.current = false;
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
        setPromptDraft(null);
        promptRequest.current = null;
        setPromptUncertain(false);
        setSavingPrompt(false);
        promptInFlight.current = false;
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
      setStartConflict(false);
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
      (intent.status !== 'READY' ||
        intent.executionAvailable !== true ||
        intent.execution ||
        !intent.prompt.trim() ||
        promptDraft !== null ||
        promptInFlight.current ||
        startConflict)
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
        startRequest.current ??= {
          requestId: crypto.randomUUID(),
          ...(intent.promptRevision !== undefined ? { promptRevision: intent.promptRevision } : {}),
        };
        setStartPending(true);
        const { requestId, promptRevision } = startRequest.current;
        next =
          promptRevision === undefined
            ? await nativeIntentsService.start(projectId, intentId, requestId)
            : await nativeIntentsService.start(projectId, intentId, requestId, promptRevision);
      } else {
        next = await nativeIntentsService.cancel(projectId, intentId);
      }
      if (!current(requestGeneration, requestAccessRevision)) return;
      setLoaded((previous) => acceptDetail(previous, next, requestAccessRevision));
    } catch (err) {
      if (
        action === 'start' &&
        current(requestGeneration, requestAccessRevision) &&
        err instanceof ApiError &&
        err.status === 409 &&
        ['NATIVE_PROMPT_CONFLICT', 'NATIVE_EXECUTION_CONFLICT'].includes(String(err.body?.code))
      ) {
        startRequest.current = null;
        setStartPending(false);
        setStartConflict(true);
      }
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
  const editPrompt = (text: string) => {
    if (
      !intent ||
      intent.execution ||
      intent.promptRevision === undefined ||
      actionInFlight.current === 'start' ||
      promptInFlight.current ||
      promptUncertain
    )
      return;
    setPromptDraft((draft) => ({
      text,
      expectedRevision: draft?.expectedRevision ?? intent.promptRevision!,
    }));
  };
  const discardPrompt = () => {
    if (promptInFlight.current || promptUncertain) return;
    promptRequest.current = null;
    setPromptDraft(null);
  };
  const savePrompt = async () => {
    if (
      !intent ||
      intent.execution ||
      !promptDraft ||
      actionInFlight.current === 'start' ||
      promptInFlight.current ||
      !nativePromptValid(promptDraft.text)
    )
      return;
    const requestGeneration = generation.current;
    const requestAccessRevision = nativeAccessRevision(projectId);
    promptInFlight.current = true;
    setSavingPrompt(true);
    setError(null);
    promptRequest.current ??= {
      requestId: crypto.randomUUID(),
      expectedRevision: promptDraft.expectedRevision,
      prompt: promptDraft.text,
    };
    try {
      const next = await nativeIntentsService.savePrompt(
        projectId,
        intentId,
        promptRequest.current,
      );
      if (!current(requestGeneration, requestAccessRevision)) return;
      setLoaded((previous) => acceptDetail(previous, next, requestAccessRevision));
      promptRequest.current = null;
      setPromptDraft(null);
      setPromptUncertain(false);
      // The save transaction excludes EXECUTION and advances the prompt
      // revision. An older Start cannot subsequently admit the previous prompt.
      startRequest.current = null;
      setStartPending(false);
      setStartConflict(false);
    } catch (err) {
      if (!current(requestGeneration, requestAccessRevision)) return;
      // Only the command's explicit validation/CAS rejection ends this attempt.
      // Every uncertain result retries its immutable identity and body.
      if (
        err instanceof ApiError &&
        ((!promptUncertain && err.status === 400 && err.body?.code === 'NATIVE_PROMPT_INVALID') ||
          (err.status === 409 && err.body?.code === 'NATIVE_PROMPT_CONFLICT'))
      ) {
        promptRequest.current = null;
        setPromptUncertain(false);
      } else setPromptUncertain(true);
      handleFailure(
        err,
        nativeActionError(err, 'Prompt saving could not be confirmed. Retry the same save.'),
        requestGeneration,
        requestAccessRevision,
      );
    } finally {
      if (current(requestGeneration, requestAccessRevision)) {
        promptInFlight.current = false;
        setSavingPrompt(false);
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
  const acceptExecution = useCallback(
    (execution: NativeExecution) => {
      const revision = nativeAccessRevision(projectId);
      if (!current(generation.current, revision)) return;
      setLoaded((previous) =>
        previous?.accessRevision === revision
          ? acceptDetail(
              previous,
              {
                ...previous.value,
                execution: {
                  ...execution,
                  // Reply acknowledgements do not re-read image policy. Keep
                  // the last policy observation until the status owner does.
                  imageStatus: execution.imageStatus ?? previous.value.execution?.imageStatus,
                },
              },
              revision,
            )
          : previous,
      );
    },
    [projectId, current],
  );

  return {
    projectId,
    intentId,
    intent,
    error,
    preparing,
    acting,
    prepare,
    execute,
    refresh,
    publicationFailure,
    acceptExecution,
    promptDraft,
    savingPrompt,
    promptUncertain,
    startPending,
    startConflict,
    editPrompt,
    discardPrompt,
    savePrompt,
  };
}
export type NativeIntentAdapter = ReturnType<typeof useNativeIntentAdapter>;
