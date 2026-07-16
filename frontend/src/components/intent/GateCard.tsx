import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GateAnswer, IntentGate } from '@/services/intents';
import { useIntent } from '@/contexts/IntentContext';
import QuestionEditor from '@/components/QuestionEditor';
import type { Question } from '@/services/questions';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Compass } from 'lucide-react';

// Map a v2 HUMAN# gate to the right editor, keyed by the intent collaboration
// scope. `question` gates render the structured QuestionEditor; approval and
// review-verdict gates render prompt + options. NOTE: the runtime currently
// only emits `question` gates — the other branches are forward-compat for the
// schema-valid kinds (lambda/shared/v2-process-keys.js HUMAN_TASK_KINDS).
// Engine-gate option → answer status (WP5 construction gates): reject-flavored
// options retire the gate as 'rejected'; approve-flavored as 'approved'; the
// rest (retry/skip/abort/autonomous/gated) are plain answers.
const engineGateStatusFor = (opt: string): GateAnswer['status'] =>
  /^(reject|request-changes)/i.test(opt)
    ? 'rejected'
    : /^(approve|accept-as-is)/i.test(opt)
      ? 'approved'
      : 'answered';

export interface GateCardProps {
  gate: IntentGate;
  projectId: string;
  intentId: string;
  userName: string;
  onAnswer: (gate: IntentGate, input: GateAnswer) => Promise<void>;
}

export function GateCard({ gate, projectId, intentId, userName, onAnswer }: GateCardProps) {
  const navigate = useNavigate();
  const { stageNameOf: gateStageNameOf, detail } = useIntent();
  // Steering (docs/v2-steering.md): an optional course correction riding the
  // answer — injected into the resumed agent conversation right after it, so
  // the human can redirect the agent's direction while answering.
  const [steering, setSteering] = useState('');
  // Free-text feedback for engine gates offering 'request-changes' (skeleton /
  // batch revision loops): sent as { decision, feedback } so the engine
  // re-runs the increment with it and re-asks.
  const [feedback, setFeedback] = useState('');
  const question = useMemo<Question | null>(() => {
    let parsed: Question['questions'];
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

  if (gate.kind === 'validation') {
    const stageArtifacts =
      detail?.artifacts.filter((a) => a.createdByStageInstanceId === gate.stageInstanceId) ?? [];
    return (
      <Card>
        <CardContent className="space-y-3 py-3">
          <div>
            <p className="text-sm font-medium">
              Review the results of {gateStageNameOf(gate.stageInstanceId ?? gate.humanTaskId)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              The agent finished this stage and produced {stageArtifacts.length} artifact
              {stageArtifacts.length === 1 ? '' : 's'}. Review them and approve or request changes.
            </p>
          </div>
          {stageArtifacts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {stageArtifacts.map((a) => (
                <Badge key={a.id} variant="secondary" className="text-[11px]">
                  {a.title || a.id}
                </Badge>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() =>
                navigate(`/space/${projectId}/intent/${intentId}/review/${gate.humanTaskId}`)
              }
            >
              Review stage
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (gate.kind === 'review-verdict') {
    const options = Array.isArray(gate.options)
      ? gate.options.filter((o): o is string => typeof o === 'string')
      : [];
    return (
      <Card>
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
    // A non-structured gate — the engine's construction gates (walking
    // skeleton / autonomy ladder / batch / halt-and-ask, docs/v2-parallel.md
    // WP5) arrive as kind 'approval' with a prompt and an options array; each
    // option submits `{ decision }` (the shape the orchestrator's parseChoice
    // consumes). Gates offering 'request-changes' carry the free-text feedback
    // below with the answer — the engine re-runs the increment with it and
    // re-asks (upstream stage-protocol §1), so a reject never kills the run.
    const options = Array.isArray(gate.options)
      ? gate.options.filter((o): o is string => typeof o === 'string')
      : [];
    const offersRevision = options.some((o) => /^request-changes/i.test(o));
    return (
      <Card>
        <CardContent className="space-y-2 py-3">
          {gate.unitSlug && (
            <Badge variant="outline" className="px-1.5 py-0 text-[9px] font-normal">
              unit {gate.unitSlug}
            </Badge>
          )}
          <p className="whitespace-pre-line text-sm">{gate.prompt || 'Approval required'}</p>
          {offersRevision && (
            <div className="space-y-1 rounded-md border border-dashed px-3 py-2">
              <Label
                htmlFor={`gate-feedback-${gate.humanTaskId}`}
                className="text-[11px] font-medium text-muted-foreground"
              >
                Request-changes feedback (optional)
              </Label>
              <Textarea
                id={`gate-feedback-${gate.humanTaskId}`}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="What should change before you can approve? Sent with 'request-changes' — the engine revises the increment with this feedback and asks again."
                rows={2}
                className="text-xs"
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {options.length > 0 ? (
              options.map((opt) => (
                <Button
                  key={opt}
                  size="sm"
                  variant={engineGateStatusFor(opt) === 'rejected' ? 'outline' : 'default'}
                  onClick={() =>
                    onAnswer(gate, {
                      answer: {
                        decision: opt,
                        ...(/^request-changes/i.test(opt) && feedback.trim()
                          ? { feedback: feedback.trim() }
                          : {}),
                      },
                      status: engineGateStatusFor(opt),
                    })
                  }
                >
                  {opt}
                </Button>
              ))
            ) : (
              <Button
                size="sm"
                onClick={() => onAnswer(gate, { answer: { approved: true }, status: 'approved' })}
              >
                Approve
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div>
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: intentId, projectId }}
        userName={userName}
        onAnswer={(structuredAnswer) =>
          onAnswer(gate, {
            answer: structuredAnswer,
            ...(steering.trim() ? { steering: steering.trim() } : {}),
          })
        }
      />
      {/* Optional course correction delivered WITH the answer — collapsed so
          the primary path (answer → submit) stays unambiguous. */}
      <details open className="mt-1.5 rounded-md border border-dashed px-3 py-2">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Compass className="h-3 w-3" />
          Add a note to the agent (optional)
        </summary>
        <Textarea
          value={steering}
          onChange={(e) => setSteering(e.target.value)}
          placeholder="Redirect the agent if it is heading the wrong way — e.g. 'Stop building the REST layer; integrate with the existing event bus instead.' Sent with your answer and overrides the agent's current plan."
          rows={2}
          className="mt-1.5 text-xs"
        />
      </details>
    </div>
  );
}
