import { WorkflowPhaseDiagram, type DiagramStage } from './IntentPhaseDiagram';
import {
  WorkflowPhaseBreadcrumb,
  type IntentPhase,
  type StepState,
} from '@/components/layout/IntentPipelineBar';
import { humanizeStageId } from './documentHelpers';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { useOptionalAuth } from '@/contexts/AuthContext';
import {
  getNativeListing,
  nativeAccessDenied,
  useNativeListingVersion,
} from '@/hooks/useNativeIntents';
import {
  currentSessionEpoch,
  isSessionExpiryNotified,
  onSessionChanged,
} from '@/services/sessionExpiry';
import {
  nativeCompletionService,
  type NativeCompletionEvidence as Evidence,
  type NativeWorkflowDefinition,
} from '@/services/nativeCompletion';
import type { NativeRevisionTarget } from '@/services/nativeHistory';

const diagramStates: Record<StepState, DiagramStage['state']> = {
  done: 'SUCCEEDED',
  running: 'RUNNING',
  failed: 'FAILED',
  pending: 'PENDING',
  unknown: 'UNKNOWN',
};
interface Props {
  projectId: string;
  executionId: string;
  attemptId: string;
  target: NativeRevisionTarget;
  onAccessFailure: (error: unknown) => void;
}

export function NativeCompletionEvidence(props: Props) {
  useNativeListingVersion();
  const session = useSyncExternalStore(onSessionChanged, currentSessionEpoch);
  const auth = useOptionalAuth();
  const access = getNativeListing(props.projectId).accessRevision ?? 0;
  if (isSessionExpiryNotified()) return null;
  return (
    <Completion
      key={JSON.stringify([
        props.projectId,
        props.executionId,
        props.attemptId,
        props.target.publicationId,
        props.target.publicationSequence,
        auth?.user?.userId,
        session,
        access,
      ])}
      {...props}
    />
  );
}

function Completion(props: Props) {
  const observation = usePublicationCompletion(
    props.projectId,
    props.executionId,
    props.attemptId,
    props.target,
    props.onAccessFailure,
  );
  return <CompletionDetails observation={observation} target={props.target} />;
}

// Callers key the reader to the authorized member, intent, attempt and named publication.
export function usePublicationCompletion(
  projectId: string,
  executionId: string,
  attemptId: string | undefined,
  target: NativeRevisionTarget | null,
  onAccessFailure: Props['onAccessFailure'],
) {
  const publicationId = target?.publicationId;
  const publicationSequence = target?.publicationSequence;
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!attemptId || !publicationId || publicationSequence === undefined) return;
    let active = true;
    const epoch = currentSessionEpoch();
    const access = getNativeListing(projectId).accessRevision ?? 0;
    const current = () =>
      active &&
      epoch === currentSessionEpoch() &&
      !isSessionExpiryNotified() &&
      access === (getNativeListing(projectId).accessRevision ?? 0);
    void nativeCompletionService
      .read(projectId, executionId, attemptId, { publicationId, publicationSequence })
      .then((value) => {
        if (current()) setEvidence(value);
      })
      .catch((err) => {
        if (!current()) return;
        setError(true);
        if (nativeAccessDenied(err)) onAccessFailure(err);
      });
    return () => {
      active = false;
    };
  }, [
    projectId,
    executionId,
    attemptId,
    publicationId,
    publicationSequence,
    reload,
    onAccessFailure,
  ]);
  const refresh = () => {
    setEvidence(null);
    setError(false);
    setReload((n) => n + 1);
  };
  return { evidence, error, refresh };
}

type Observation = ReturnType<typeof usePublicationCompletion>;
export function CompletionDetails({
  observation: { evidence, error, refresh },
  target,
}: {
  observation: Observation;
  target: NativeRevisionTarget;
}) {
  const decision = evidence?.memberDecision;
  return (
    <section
      aria-label="Workflow completion evidence"
      className="space-y-2 rounded-md border p-3 text-sm"
    >
      <h3 className="font-medium">
        {evidence?.methodReport === 'complete' ? (
          'AI-DLC reported complete'
        ) : (
          <>
            Workflow completion:{' '}
            {evidence?.workflowCompletion === 'complete'
              ? 'complete'
              : evidence?.workflowCompletion === 'failed'
                ? 'failed'
                : 'not verified'}
          </>
        )}
      </h3>
      <p>
        Human approval is required only where the pinned AI-DLC workflow and selected plan define
        it. There is no additional platform approval gate.
      </p>
      {error ? (
        <>
          <p>
            Completion evidence is unavailable. Files, results and current replies remain available.
          </p>
          <Button variant="outline" onClick={refresh}>
            Retry evidence
          </Button>
        </>
      ) : !evidence ? (
        <p>Loading evidence for publication {target.publicationSequence}…</p>
      ) : (
        <>
          {evidence.policyStatus === 'protected_engine' ? (
            <ProtectedEvidence evidence={evidence} />
          ) : (
            <>
              <p>
                The effective selected plan, amendments and applicable requirements are not
                independently recorded.
                {evidence.policyStatus === 'unsupported' &&
                  ' This pinned package has no supported definition profile.'}{' '}
                Missing policy evidence does not mean approval is unnecessary.
              </p>
              <p>
                Required check and review outcomes, engine application of human decisions and a
                terminal workflow outcome are not independently recorded for these exact result
                bytes. Published logs, failures and review files remain agent-reported; their
                applicability and freshness are unverified. A stopped or cancelled runtime does not
                prove completion.
              </p>
            </>
          )}
          {decision ? (
            <div className="space-y-1">
              <h4 className="font-medium">Recorded member choice for this proposal</h4>
              <p>
                {decision.label} · {decision.presentedStage} · {decision.actorId} ·{' '}
                {new Date(decision.acceptedAt).toLocaleString()}
              </p>
              {decision.additionalText && (
                <p>
                  The answer also contains additional text; inspect the exact answer in History.
                </p>
              )}
              <p>
                Runtime delivery: {evidence.decisionDelivery}. Engine application: not recorded.
                This choice applies to publication {target.publicationSequence} only; it does not
                approve later changed bytes.
              </p>
              <p className="break-all text-xs">
                Command {decision.commandId} · Proposal {decision.interactionId}
              </p>
            </div>
          ) : (
            <p>
              No classified member gate selection is recorded for this publication. Free-text
              answers are available in History.
            </p>
          )}
          {evidence.definition && <Definition definition={evidence.definition} />}
          <Button variant="outline" onClick={refresh}>
            Refresh evidence
          </Button>
        </>
      )}
    </section>
  );
}

export function NativeWorkflowProgress({
  presentation,
  observation: { evidence, error },
}: {
  presentation: 'work' | 'overview';
  observation: Observation;
}) {
  const groups = new Map<string, IntentPhase>();
  const plan =
    evidence?.policyStatus === 'protected_engine' && evidence.effectivePlan !== 'not_recorded'
      ? evidence.effectivePlan
      : null;
  for (const stage of plan?.stages ?? []) {
    const group = groups.get(stage.phase) ?? { phase: stage.phase, steps: [], excluded: 0 };
    if (stage.action === 'SKIP') group.excluded++;
    else {
      const states: Record<string, StepState> = {
        completed: 'done',
        skipped: 'done',
        'in-progress': 'running',
        failed: 'failed',
        pending: 'pending',
        'not-started': 'pending',
      };
      group.steps.push({ stageId: stage.id, state: states[stage.state] ?? 'unknown' });
    }
    groups.set(stage.phase, group);
  }
  return (
    <div className="space-y-2">
      {plan ? (
        presentation === 'overview' ? (
          <WorkflowPhaseDiagram
            phaseNameOf={humanizeStageId}
            phases={[...groups.values()]
              .filter((group) => group.steps.length)
              .map((group) => ({
                phase: group.phase,
                total: group.steps.length,
                done: group.steps.filter((step) => step.state === 'done').length,
                rows: group.steps.map((step) => ({
                  stageId: step.stageId,
                  label: humanizeStageId(step.stageId),
                  stageInstanceId: null,
                  unitSlug: null,
                  state: diagramStates[step.state],
                })),
              }))}
          />
        ) : (
          <WorkflowPhaseBreadcrumb
            phases={[...groups.values()].filter((group) => group.steps.length)}
            scope={plan.scope}
            phaseNameOf={humanizeStageId}
          />
        )
      ) : (
        presentation === 'overview' && (
          <p className="text-sm text-muted-foreground">
            {error
              ? 'Workflow progress is unavailable.'
              : evidence
                ? 'No workflow plan is recorded for this revision.'
                : 'Loading workflow progress…'}
          </p>
        )
      )}

      {evidence?.methodReport === 'complete' && (
        <p role="status" className="text-sm font-medium">
          AI-DLC reported complete
        </p>
      )}
      {evidence?.workflowCompletion === 'complete' && (
        <p role="status" className="text-sm font-medium">
          Workflow completed{evidence.requiredChecks === 'failed' && ' with failed checks'}
          {evidence.finalReview === 'concerns' &&
            (evidence.requiredChecks === 'failed'
              ? ' and review concerns'
              : ' with review concerns')}
        </p>
      )}
      {evidence?.workflowCompletion === 'failed' && (
        <p role="status" className="text-sm font-medium text-destructive">
          Workflow failed
        </p>
      )}
    </div>
  );
}

function ProtectedEvidence({ evidence }: { evidence: Evidence }) {
  const plan = evidence.effectivePlan === 'not_recorded' ? null : evidence.effectivePlan;
  const decisions = evidence.engineApplication === 'not_recorded' ? [] : evidence.engineApplication;
  const unapplied = evidence.unappliedReplies ?? [];
  return (
    <div className="space-y-2">
      <p>
        Evidence is bound to publication {evidence.publicationSequence} and its exact files.
        {evidence.workflowCompletion === 'complete'
          ? evidence.requiredChecks === 'failed' || evidence.finalReview === 'concerns'
            ? ' The protected workflow engine recorded completion under the applied plan, with the failed checks or reviewer concerns shown below. The pinned workflow decides whether those block completion.'
            : ' The protected workflow engine recorded completion with the applied plan and its required evidence.'
          : evidence.workflowCompletion === 'failed'
            ? ' The protected workflow engine recorded a failed outcome.'
            : ' Verified workflow completion has not been established for this revision.'}
      </p>
      <p>
        Checks: {evidence.requiredChecks.replaceAll('_', ' ')}. Reviews:{' '}
        {evidence.finalReview.replaceAll('_', ' ')}. Human gates:{' '}
        {evidence.humanApproval.replaceAll('_', ' ')}.
      </p>
      {!!unapplied.length && (
        <div role="note" aria-label="Replies not applied as decisions" className="space-y-1">
          <p>
            {unapplied.length === 1
              ? 'A reply was accepted but not applied as a workflow decision: it did not answer a question the workflow engine had recorded. It answered, approved and selected nothing.'
              : `${unapplied.length} replies were accepted but not applied as workflow decisions: they did not answer a question the workflow engine had recorded. They answered, approved and selected nothing.`}{' '}
            Answer the question when it is shown as a form.
          </p>
          <ul className="space-y-1">
            {unapplied.map((reply) => (
              <li key={reply.commandId}>
                Turn {reply.sequence} · {reply.actorId}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="space-y-2">
        <summary>Inspect applied plan and outcomes</summary>
        {plan ? (
          <>
            <p>Selected plan: {plan.name ?? plan.scope}</p>
            <ul className="space-y-1">
              {plan.stages.map((stage) => (
                <li key={stage.id}>
                  {stage.id}: {stage.action.toLowerCase()} · {stage.state}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>The engine has not recorded an effective plan yet.</p>
        )}
        {!!evidence.checks?.length && (
          <ul className="space-y-1" aria-label="Observed checks">
            {evidence.checks.map((check, index) => (
              <li key={`${check.stage}-${check.sensor}-${index}`}>
                {check.stage}
                {check.unit ? ` / ${check.unit}` : ''} · {check.sensor}:{' '}
                {check.status.replaceAll('_', ' ')}
              </li>
            ))}
          </ul>
        )}
        {!!evidence.reviews?.length && (
          <ul className="space-y-1" aria-label="Independent reviews">
            {evidence.reviews.map((review, index) => (
              <li key={`${review.stage}-${index}`}>
                {review.stage}
                {review.unit ? ` / ${review.unit}` : ''} · {review.reviewer}:{' '}
                {review.status.replaceAll('_', ' ')} (
                {review.class === 'adversarial' ? 'required adversarial' : 'advisory'})
                {review.verdict && ` · Recorded verdict ${review.verdict}`}
                {' · Isolated job BUILD phase: '}
                {['ready', 'concerns'].includes(review.status) && review.buildPhaseMs !== undefined
                  ? `${review.buildPhaseMs} ms`
                  : 'unavailable'}
                {' · Reviewer token usage unavailable'}
              </li>
            ))}
          </ul>
        )}
        {!!decisions.length && (
          <ul className="space-y-1" aria-label="Applied member decisions">
            {decisions.map((decision) => (
              <li key={decision.commandId}>
                {decision.stage ?? 'Plan selection'} · {decision.actorId}: {decision.application}
              </li>
            ))}
          </ul>
        )}
        <p className="break-all text-xs">Files: {evidence.filesSha256}</p>
      </details>
    </div>
  );
}

function Definition({ definition }: { definition: NativeWorkflowDefinition }) {
  const [planId, setPlanId] = useState(definition.plans[0].id);
  const plan = definition.plans.find((p) => p.id === planId)!;
  return (
    <details className="space-y-2">
      <summary>Inspect pinned package defaults</summary>
      <p>
        This preview does not select a plan or establish this run’s applied requirements.
        Conditional inclusion, plan amendments, review overrides, ceremony and construction autonomy
        need protected application evidence.
      </p>
      <p className="break-all text-xs">
        {definition.protocol} · Source {definition.sourceCommit} · Package {definition.packageId}
      </p>
      <label className="block">
        Definition to inspect{' '}
        <select value={planId} onChange={(event) => setPlanId(event.target.value)}>
          {definition.plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
      </label>
      <p>
        Declared review cap: {plan.reviewCap ?? 'no cap'}. Initialization stages have no human gate.
        Other included stages declare a gate; construction ceremony/autonomy can affect its
        application. Skipped stages do not contribute requirements unless the plan is amended.
      </p>
      <ul className="space-y-2">
        {definition.stages.map((stage) => (
          <li key={stage.id}>
            <strong>{stage.name}</strong>:{' '}
            {plan.stages[stage.id] === 'SKIP' ? (
              'skipped by this default plan; requirements not applicable'
            ) : (
              <>
                {stage.execution === 'CONDITIONAL' ? 'conditional inclusion' : 'included'} · Human
                gate: {stage.phase === 'initialization' ? 'not required' : 'declared'}
                {' · '}Stage reviewer: {stage.reviewer ?? 'none'} ({stage.reviewClass ?? 'none'}),
                subject to the plan cap
                {' · '}Declared sensors:{' '}
                {stage.sensors.map((s) => `${s.id} (${s.severity}, ${s.fireOn})`).join(', ') ||
                  'none'}
                <p>{stage.condition}</p>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
