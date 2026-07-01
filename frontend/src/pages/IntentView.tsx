import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  intentsService,
  type GateAnswer,
  type IntentDetail,
  type IntentGate,
} from '@/services/intents';
import { useIntent } from '@/contexts/IntentContext';
import { useAuth } from '@/contexts/AuthContext';
import QuestionEditor from '@/components/QuestionEditor';
import type { Question } from '@/services/questions';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { IntentStageList } from '@/components/intent/IntentStageList';
import { IntentGraph } from '@/components/intent/IntentGraph';
import { KnowledgeGraph } from '@/components/intent/KnowledgeGraph';
import { ArtifactViewer } from '@/components/intent/ArtifactViewer';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { List, Loader2, Play, Workflow, XCircle } from 'lucide-react';

// The v2 intent page — main-pane content only. All fetch/realtime/output state
// lives in IntentProvider (mounted by AppShell, shared with the right-hand
// IntentActivityPanel where output/timeline/discussions render).
export default function IntentView() {
  const {
    projectId,
    intentId,
    detail,
    loading,
    error: loadError,
    pendingGates,
    reload,
    answerGate,
  } = useIntent();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userName = user?.displayName || user?.email || '';

  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'graph'>('list');

  // Start (DRAFT) and restart (FAILED / stranded CREATED) share the /start
  // endpoint, which re-enters the pipeline and clears a prior failureReason.
  const handleStart = async () => {
    if (!projectId || !intentId) return;
    setStarting(true);
    setActionError(null);
    try {
      await intentsService.start(projectId, intentId);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start intent');
    } finally {
      setStarting(false);
    }
  };

  if (!projectId || !intentId) return <div className="p-6">Intent not found</div>;
  if (loading && !detail) {
    return (
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }
  if (!detail) return <div className="p-6">Intent not found</div>;

  const intent = detail.intent;
  const error = actionError ?? loadError;
  const isDraft = intent.status === 'DRAFT';
  const isActive = intent.status === 'RUNNING' || intent.status === 'WAITING';
  const isFailed = intent.status === 'FAILED';
  // Pre-stage progress: before any stage row exists, init-ws lifecycle events
  // are the only signal the run is doing something (they stream into the
  // sidebar Timeline); this strip keeps the main pane from looking dead.
  const noStageRowsYet = detail.stages.length === 0;
  // Stalled detection: a CREATED run whose hand-off never reached a live
  // orchestrator strands here (init-ws should flip it to RUNNING within
  // seconds). After >2 min untouched, offer a restart instead of spinning.
  const lastTouch = intent.updatedAt ?? intent.createdAt;
  const isStalled =
    intent.status === 'CREATED' &&
    !!lastTouch &&
    Date.now() - new Date(lastTouch).getTime() > 120_000;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate(`/project/${projectId}`)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Project
          </button>
          <h1 className="text-lg font-bold tracking-tight truncate">{intent.title || 'Intent'}</h1>
          <Badge variant="outline" className="text-[10px]">
            {intent.status}
          </Badge>
          {isActive && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse"
              aria-label="live"
            />
          )}
          {/* Intent-level discussion thread. */}
          <DiscussButton entityType="intent" entityTitle={intent.title || 'Intent'} />
        </div>
        <div className="text-xs text-muted-foreground">
          {intent.workflowId} · v{intent.workflowVersion} · {intent.scope}
          {isActive && intent.currentStage && (
            <>
              {' · '}
              <span className="text-foreground">{intent.currentStage}</span>
            </>
          )}
          {intent.source && (
            <>
              {' · '}
              {intent.source.resourceUrl ? (
                <a
                  href={intent.source.resourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:no-underline"
                >
                  from {intent.source.resourceId}
                </a>
              ) : (
                <span>from {intent.source.resourceId}</span>
              )}
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* FAILED (or a stalled CREATED hand-off): show the reason + offer a restart
          (re-runs init-ws + the plan; the /start endpoint accepts both states). */}
      {(isFailed || isStalled) && (
        <div className="rounded border border-agent-error/30 bg-agent-error/10 px-3 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-medium text-agent-error">
                <XCircle className="h-4 w-4" />
                {isFailed ? 'Run failed' : 'Run stalled — never started'}
              </div>
              {isFailed && intent.failureReason && (
                <p className="mt-1 break-words font-mono text-[12px] text-agent-error/90">
                  {intent.failureReason}
                </p>
              )}
              {isStalled && (
                <p className="mt-1 text-[12px] text-agent-error/90">
                  Workspace setup never completed. Restart to re-run it.
                </p>
              )}
            </div>
            <Button
              onClick={handleStart}
              disabled={starting}
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
            >
              {starting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {starting ? 'Restarting…' : 'Restart'}
            </Button>
          </div>
        </div>
      )}

      {/* DRAFT: review + Start. The prompt is read-only — there is no update
          endpoint, so an editable field would silently discard changes. */}
      {isDraft ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Review & start</CardTitle>
            <p className="text-sm text-muted-foreground">
              Review the prompt and kick off the run. Stages execute per the workflow's plan.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Prompt</Label>
              <div className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {intent.prompt || '—'}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Set when the intent was created — create a new intent to change it.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="intent-branch">Branch</Label>
                <Input
                  id="intent-branch"
                  value={intent.branch ?? ''}
                  disabled
                  className="mt-1.5 font-mono text-sm"
                />
              </div>
              <div>
                <Label>Repositories</Label>
                <p className="mt-2 text-sm text-muted-foreground truncate">
                  {(intent.repos ?? []).join(', ') || '—'}
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleStart} disabled={starting} className="gap-1.5">
                {starting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {starting ? 'Starting…' : 'Start'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Pending human gates (D3: one editor per pending gate) */}
          {pendingGates.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold">Open questions ({pendingGates.length})</h2>
              {pendingGates.map((gate) => (
                <GateCard
                  key={gate.humanTaskId}
                  gate={gate}
                  isActiveGate={gate.humanTaskId === intent.pendingHumanTaskId}
                  projectId={projectId}
                  intentId={intentId}
                  userName={userName}
                  onAnswer={answerGate}
                />
              ))}
            </div>
          )}

          {/* Workspace setup indicator — init-ws creates no stage row, so without
              this the screen looks idle while repos clone + the anchor is created. */}
          {noStageRowsYet && isActive && (
            <div className="flex items-center gap-2 rounded-md border border-agent-running/30 bg-agent-running/[0.06] px-3 py-2 text-sm text-agent-running">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Setting up workspace (cloning repositories, preparing the run)…
            </div>
          )}

          {/* Stage pipeline — list (default) or topological graph, one shared
              drill-down selection. `id` anchors artifact→stage jump links. */}
          <Card id="intent-stages" className="scroll-mt-4">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">Stages</CardTitle>
                <ToggleGroup
                  type="single"
                  value={view}
                  onValueChange={(v) => v && setView(v as 'list' | 'graph')}
                  className="h-7"
                >
                  <ToggleGroupItem value="list" aria-label="List view" className="h-7 gap-1 px-2">
                    <List className="h-3.5 w-3.5" />
                    <span className="text-xs">List</span>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="graph" aria-label="Graph view" className="h-7 gap-1 px-2">
                    <Workflow className="h-3.5 w-3.5" />
                    <span className="text-xs">Graph</span>
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </CardHeader>
            <CardContent>{view === 'list' ? <IntentStageList /> : <IntentGraph />}</CardContent>
          </Card>

          {/* Knowledge graph — the Neptune subgraph the agents traverse:
              artifacts + typed relations, questions, discussions, and the
              project knowledge injected into every stage. Process lives above
              (stages); this is the OUTPUT view. */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Knowledge graph</CardTitle>
              <p className="text-xs text-muted-foreground">
                What the agents produced and drew on — artifacts and their relations, questions,
                discussions, and project knowledge.
              </p>
            </CardHeader>
            <CardContent>
              <KnowledgeGraph />
            </CardContent>
          </Card>

          {/* Metrics */}
          {detail.metrics.length > 0 && <MetricsPanel detail={detail} />}

          {/* Artifacts */}
          {detail.artifacts.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Artifacts ({detail.artifacts.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {detail.artifacts.map((a) => (
                  <ArtifactViewer key={a.id} artifact={a} />
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// Map a v2 HUMAN# gate to the right editor, keyed by the intent collaboration
// scope. `question` gates render the structured QuestionEditor; approval and
// review-verdict gates render prompt + options. NOTE: the runtime currently
// only emits `question` gates — the other branches are forward-compat for the
// schema-valid kinds (lambda/shared/v2-process-keys.js HUMAN_TASK_KINDS).
function GateCard({
  gate,
  isActiveGate,
  projectId,
  intentId,
  userName,
  onAnswer,
}: {
  gate: IntentGate;
  isActiveGate: boolean;
  projectId: string;
  intentId: string;
  userName: string;
  onAnswer: (gate: IntentGate, input: GateAnswer) => Promise<void>;
}) {
  const question = useMemo<Question | null>(() => {
    let parsed: Question['questions'] = [];
    try {
      parsed = gate.questions ? JSON.parse(gate.questions) : [];
    } catch {
      parsed = [];
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return {
      id: gate.humanTaskId,
      agent: gate.stageInstanceId ?? 'agent',
      questions: parsed,
      sprintId: '',
      createdAt: gate.createdAt ?? '',
    };
  }, [gate]);

  if (gate.kind === 'review-verdict') {
    const options = Array.isArray(gate.options)
      ? gate.options.filter((o): o is string => typeof o === 'string')
      : [];
    return (
      <Card className={cn(isActiveGate && 'border-agent-waiting/40')}>
        <CardContent className="space-y-2 py-3">
          <p className="text-sm font-medium">{gate.prompt || 'Review verdict required'}</p>
          <div className="flex flex-wrap gap-2">
            {options.length > 0 ? (
              options.map((opt) => (
                <Button
                  key={opt}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onAnswer(gate, {
                      answer: opt,
                      status: /reject/i.test(opt) ? 'rejected' : 'answered',
                    })
                  }
                >
                  {opt}
                </Button>
              ))
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={() => onAnswer(gate, { answer: 'approve', status: 'approved' })}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAnswer(gate, { answer: 'reject', status: 'rejected' })}
                >
                  Reject
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!question) {
    // A non-structured gate (approval): fall back to a simple prompt.
    return (
      <Card className={cn(isActiveGate && 'border-agent-waiting/40')}>
        <CardContent className="py-3">
          <p className="text-sm">{gate.prompt || 'Approval required'}</p>
          <Button
            size="sm"
            className="mt-2"
            onClick={() => onAnswer(gate, { answer: { approved: true }, status: 'approved' })}
          >
            Approve
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={cn(isActiveGate && 'ring-1 ring-agent-waiting/40 rounded-lg')}>
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: intentId, projectId }}
        userName={userName}
        onAnswer={(structuredAnswer) => onAnswer(gate, { answer: structuredAnswer })}
      />
    </div>
  );
}

function MetricsPanel({ detail }: { detail: IntentDetail }) {
  // Sum the latest known numeric fields across samples (best-effort display).
  const totals = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const m of detail.metrics) {
      for (const [k, v] of Object.entries(m.metrics ?? {})) {
        if (typeof v === 'number') acc[k] = (acc[k] ?? 0) + v;
      }
    }
    return acc;
  }, [detail.metrics]);
  const entries = Object.entries(totals);
  if (entries.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Metrics</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {entries.map(([k, v]) => (
          <div key={k} className="rounded border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{k}</p>
            <p className="text-sm font-medium">{v.toLocaleString()}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
