import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  intentsService,
  type IntentDetail,
  type IntentGate,
  type StageState,
} from '@/services/intents';
import { workflowsService, type CompiledWorkflow } from '@/services/workflows';
import { useIntentEvents, type IntentEvent } from '@/hooks/useIntentEvents';
import { useAuth } from '@/contexts/AuthContext';
import QuestionEditor from '@/components/QuestionEditor';
import type { Question } from '@/services/questions';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { DiscussionPanel } from '@/components/discussion/DiscussionPanel';
import { useDiscussions } from '@/components/discussion/DiscussionProvider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Loader2, CheckCircle2, XCircle, MessageCircleQuestion, Circle, Play } from 'lucide-react';

// Stage-state visual config, mirroring the agent-status color tokens.
const STAGE_STYLE: Record<StageState, { label: string; cls: string; Icon: typeof Circle }> = {
  PENDING: { label: 'Pending', cls: 'bg-muted text-muted-foreground', Icon: Circle },
  RUNNING: {
    label: 'Running',
    cls: 'bg-agent-running/15 text-agent-running border-agent-running/30',
    Icon: Loader2,
  },
  WAITING_FOR_HUMAN: {
    label: 'Waiting',
    cls: 'bg-agent-waiting/15 text-agent-waiting border-agent-waiting/30',
    Icon: MessageCircleQuestion,
  },
  SUCCEEDED: {
    label: 'Succeeded',
    cls: 'bg-agent-success/15 text-agent-success border-agent-success/30',
    Icon: CheckCircle2,
  },
  FAILED: {
    label: 'Failed',
    cls: 'bg-agent-error/15 text-agent-error border-agent-error/30',
    Icon: XCircle,
  },
  SKIPPED: { label: 'Skipped', cls: 'bg-muted/50 text-muted-foreground opacity-60', Icon: Circle },
};

function StageBadge({ state }: { state: StageState }) {
  const { label, cls, Icon } = STAGE_STYLE[state] ?? STAGE_STYLE.PENDING;
  return (
    <Badge variant="outline" className={cn('gap-1 text-[10px]', cls)}>
      <Icon className={cn('h-3 w-3', state === 'RUNNING' && 'animate-spin')} />
      {label}
    </Badge>
  );
}

export default function IntentView() {
  const { projectId, intentId } = useParams<{ projectId: string; intentId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userName = user?.displayName || user?.email || '';
  // Discussions are provided by AppShell's DiscussionProvider; on this route it
  // resolves an intent scope. `isOpen` drives the inline thread panel below.
  const discussions = useDiscussions();

  const [detail, setDetail] = useState<IntentDetail | null>(null);
  const [compiled, setCompiled] = useState<CompiledWorkflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // DRAFT define-form state.
  const [prompt, setPrompt] = useState('');
  const [branch, setBranch] = useState('');

  // Live agent.question gates accumulated by humanTaskId (D3 multi-gate). Seeded
  // from the assembled detail, then upserted on each agent.question event.
  const [liveGates, setLiveGates] = useState<Map<string, IntentGate>>(new Map());
  // Live streamed output appended per stage instance (replayed from detail first).
  const outputBufRef = useRef<Map<string, string>>(new Map());
  const [, forceRender] = useState(0);

  const load = useCallback(async () => {
    if (!projectId || !intentId) return;
    try {
      const dto = await intentsService.get(projectId, intentId);
      setDetail(dto);
      if (dto.intent.status === 'DRAFT') {
        setPrompt(dto.intent.prompt ?? '');
        setBranch(dto.intent.branch ?? '');
      }
      // Seed the gate map + output buffers from durable state.
      setLiveGates(new Map(dto.gates.map((g) => [g.humanTaskId, g])));
      const buf = new Map<string, string>();
      for (const o of dto.outputs) {
        const key = o.stageInstanceId ?? 'intent';
        buf.set(key, (buf.get(key) ?? '') + o.content);
      }
      outputBufRef.current = buf;
      // Compiled workflow drives the phase/stage tree (best-effort).
      if (dto.intent.workflowId) {
        workflowsService
          .compiled(dto.intent.workflowId, dto.intent.workflowVersion ?? undefined)
          .then(setCompiled)
          .catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load intent');
    } finally {
      setLoading(false);
    }
  }, [projectId, intentId]);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime: refetch on lifecycle transitions; accumulate questions + output live.
  const onEvent = useCallback(
    (evt: IntentEvent) => {
      if (evt.action === 'agent.question' && evt.humanTaskId) {
        setLiveGates((prev) => {
          const next = new Map(prev);
          const existing = next.get(evt.humanTaskId!);
          next.set(evt.humanTaskId!, {
            humanTaskId: evt.humanTaskId!,
            stageInstanceId: evt.stageInstanceId ?? null,
            kind: 'question',
            status: 'pending',
            prompt: null,
            options: null,
            questions:
              typeof evt.questions === 'string'
                ? evt.questions
                : JSON.stringify(evt.questions ?? null),
            answer: null,
            answeredBy: null,
            answeredAt: null,
            createdAt: existing?.createdAt ?? null,
          });
          return next;
        });
        return;
      }
      if (evt.action === 'agent.output' && evt.content) {
        const key = evt.stageInstanceId ?? 'intent';
        outputBufRef.current.set(key, (outputBufRef.current.get(key) ?? '') + evt.content);
        forceRender((n) => n + 1);
        return;
      }
      // Stage/execution/metric/note transitions → refetch the assembled DTO.
      if (
        evt.action === 'agent.stage' ||
        evt.action === 'agent.execution' ||
        evt.action === 'agent.workspace' ||
        evt.action === 'agent.metric' ||
        evt.action === 'agent.note'
      ) {
        load();
      }
    },
    [load],
  );
  useIntentEvents(projectId ?? '', intentId ?? '', onEvent);

  const handleStart = async () => {
    if (!projectId || !intentId) return;
    setStarting(true);
    setError(null);
    try {
      // Persist any prompt edit before starting is out of scope here — the
      // create flow captured it; Start just kicks the run.
      await intentsService.start(projectId, intentId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start intent');
    } finally {
      setStarting(false);
    }
  };

  const handleAnswerGate = useCallback(
    async (gate: IntentGate, answer: unknown) => {
      if (!projectId || !intentId) return;
      await intentsService.answerGate(projectId, intentId, gate.humanTaskId, { answer });
      await load();
    },
    [projectId, intentId, load],
  );

  // Merge the compiled plan's stages with the live STAGE# rows so plan stages
  // with no row yet render as PENDING (keyed by stageId).
  const stageRows = useMemo(() => {
    const byStageId = new Map(detail?.stages.map((s) => [s.stageId, s]) ?? []);
    const planStageIds = compiled?.graph.nodes.map((n) => n.stageId) ?? [];
    const ordered = planStageIds.length
      ? planStageIds
      : (detail?.stages.map((s) => s.stageId ?? '') ?? []);
    return ordered.map((stageId) => {
      const row = byStageId.get(stageId);
      return {
        stageId,
        phase:
          row?.phase ?? compiled?.graph.nodes.find((n) => n.stageId === stageId)?.phasePath ?? null,
        state: (row?.state ?? 'PENDING') as StageState,
        stageInstanceId: row?.stageInstanceId ?? null,
        runtimeError: row?.runtimeError ?? null,
      };
    });
  }, [detail, compiled]);

  const pendingGates = useMemo(
    () => [...liveGates.values()].filter((g) => g.status === 'pending'),
    [liveGates],
  );

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
  const isDraft = intent.status === 'DRAFT';
  const isActive = intent.status === 'RUNNING' || intent.status === 'WAITING';

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
        </div>
      </div>

      {error && (
        <div className="rounded border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* DRAFT: define + Start */}
      {isDraft ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Define & start</CardTitle>
            <p className="text-sm text-muted-foreground">
              Review the prompt and kick off the run. Stages execute per the workflow's plan.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="intent-prompt">Prompt</Label>
              <Textarea
                id="intent-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                className="mt-1.5"
                placeholder="Describe the intent for the agents to work on…"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="intent-branch">Branch</Label>
                <Input
                  id="intent-branch"
                  value={branch}
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
                  onAnswer={handleAnswerGate}
                />
              ))}
            </div>
          )}

          {/* Phase / stage tree */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Stages</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {stageRows.map((s) => (
                <div
                  key={s.stageId}
                  className={cn(
                    'flex items-center gap-3 rounded-md border px-3 py-2 text-sm',
                    s.stageId === intent.currentStage && 'border-primary/40 bg-primary/[0.03]',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{s.stageId}</span>
                    {s.phase && (
                      <span className="ml-2 text-[11px] text-muted-foreground">{s.phase}</span>
                    )}
                    {s.runtimeError && (
                      <span className="block text-[11px] text-agent-error">{s.runtimeError}</span>
                    )}
                  </span>
                  <StageBadge state={s.state} />
                </div>
              ))}
              {stageRows.length === 0 && (
                <p className="text-sm text-muted-foreground">No stages resolved yet.</p>
              )}
            </CardContent>
          </Card>

          {/* Metrics */}
          {detail.metrics.length > 0 && <MetricsPanel detail={detail} />}

          {/* Streamed output */}
          <OutputPanel buffers={outputBufRef.current} />

          {/* Artifacts */}
          {detail.artifacts.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Artifacts ({detail.artifacts.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {detail.artifacts.map((a) => (
                  <details key={a.id} className="rounded border px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium">
                      {a.title || a.id}
                      {a.artifactType && (
                        <Badge variant="secondary" className="ml-2 text-[10px]">
                          {a.artifactType}
                        </Badge>
                      )}
                      {/* Per-artifact discussion thread. */}
                      <DiscussButton
                        entityType="artifact"
                        entityId={a.id}
                        entityTitle={a.title || a.id}
                        className="ml-1 align-middle"
                      />
                    </summary>
                    {a.content && (
                      <div className="prose prose-sm dark:prose-invert max-w-none mt-2">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.content}</ReactMarkdown>
                      </div>
                    )}
                  </details>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Discussion thread — opened by any DiscussButton (intent or artifact).
          Renders as a right-side sheet hosting the shared DiscussionPanel. */}
      {discussions?.isOpen && (
        <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l bg-background shadow-xl">
          <DiscussionPanel />
        </div>
      )}
    </div>
  );
}

// Map a v2 HUMAN# gate to the QuestionEditor's Question shape, keyed by the
// intent collaboration scope.
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
  onAnswer: (gate: IntentGate, answer: unknown) => Promise<void>;
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

  if (!question) {
    // A non-structured gate (approval): fall back to a simple prompt.
    return (
      <Card className={cn(isActiveGate && 'border-agent-waiting/40')}>
        <CardContent className="py-3">
          <p className="text-sm">{gate.prompt || 'Approval required'}</p>
          <Button size="sm" className="mt-2" onClick={() => onAnswer(gate, { approved: true })}>
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
        onAnswer={(structuredAnswer) => onAnswer(gate, structuredAnswer)}
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

function OutputPanel({ buffers }: { buffers: Map<string, string> }) {
  const all = [...buffers.entries()].filter(([, v]) => v.trim().length > 0);
  if (all.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Agent output</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {all.map(([key, content]) => (
          <div key={key}>
            <p className="text-[11px] text-muted-foreground mb-1">{key}</p>
            <pre className="max-h-80 overflow-auto rounded bg-muted/50 p-3 text-xs whitespace-pre-wrap break-words">
              {content}
            </pre>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
