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

function Completion({ projectId, executionId, attemptId, target, onAccessFailure }: Props) {
  const { publicationId, publicationSequence } = target;
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
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
  const decision = evidence?.memberDecision;
  return (
    <section
      aria-label="Workflow completion evidence"
      className="space-y-2 rounded-md border p-3 text-sm"
    >
      <h3 className="font-medium">Workflow completion: not verified</h3>
      <p>
        Human approval is required only where the pinned AI-DLC workflow and selected plan define
        it. There is no additional platform approval gate.
      </p>
      {error ? (
        <>
          <p>
            Completion evidence is unavailable. Files, results and current replies remain available.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setError(false);
              setReload((n) => n + 1);
            }}
          >
            Retry evidence
          </Button>
        </>
      ) : !evidence ? (
        <p>Loading evidence for publication {target.publicationSequence}…</p>
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
            Required check and review outcomes, engine application of human decisions and a terminal
            workflow outcome are not independently recorded for these exact result bytes. Published
            logs, failures and review files remain agent-reported; their applicability and freshness
            are unverified. A stopped or cancelled runtime does not prove completion.
          </p>
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
          <Button
            variant="outline"
            onClick={() => {
              setEvidence(null);
              setReload((n) => n + 1);
            }}
          >
            Refresh evidence
          </Button>
        </>
      )}
    </section>
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
