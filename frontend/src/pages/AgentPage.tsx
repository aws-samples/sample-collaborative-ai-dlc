import { useSprint } from '@/contexts/SprintContext';
import { useAgentStatus } from '@/hooks/useAgentStatus';
import { useSprintEvents } from '@/hooks/useSprintEvents';
import { useQuestionAnchor } from '@/hooks/useQuestionAnchor';
import { questionAnchorId } from '@/lib/questionAnchor';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import { AgentStreamPanel } from '@/components/AgentStreamPanel';
import { TimelinePanel } from '@/components/TimelinePanel';
import { Bot, ArrowLeft, MessageCircleQuestion } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DiscussButton } from '@/components/discussion';

// v1 projects are read-only: the v1 execution engine has been retired, so this
// page keeps the stream panel and invocation timeline for past runs but no
// write affordances (no agent starts, cancels, or answers).
export default function AgentPage() {
  const {
    sprint,
    timelineEvents,
    questions,
    projectId,
    sprintId,
    reload,
    loading: sprintLoading,
  } = useSprint();

  // Read-only status/output of the last agent run (GET endpoints only). The
  // hook self-restores the sprint's current execution and its stored output.
  const agentStatus = useAgentStatus({
    executionArn: null,
    executionId: null,
    projectId,
    sprintId,
    sprintAgentStatus: sprint?.currentAgentStatus,
  });
  useSprintEvents(
    sprintId,
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const pendingQuestions = questions
    .filter((q) => !q.structuredAnswer)
    .toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Scroll to a question referenced by a #question-{id} URL hash (timeline links)
  useQuestionAnchor(questions.length > 0);

  const badgeStatus =
    agentStatus.status?.status === 'RUNNING'
      ? 'running'
      : agentStatus.status?.status === 'SUCCEEDED'
        ? 'completed'
        : agentStatus.status?.status
          ? 'failed'
          : null;

  const agentOutput = agentStatus.completedOutput || agentStatus.streamingText;

  // Determine which phase page to link back to
  const phaseRoute =
    sprint?.phase === 'CONSTRUCTION'
      ? '/construction'
      : sprint?.phase === 'REVIEW' || sprint?.phase === 'COMPLETED'
        ? '/review'
        : '';

  return (
    <div className="min-h-screen bg-background">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              to={`/space/${projectId}/sprint/${sprintId}${phaseRoute}`}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex items-center gap-2">
              <Bot className="h-6 w-6 text-purple-500" />
              <h1 className="text-2xl font-bold">Agent Runs</h1>
            </div>
            {sprint && <span className="text-sm text-muted-foreground">{sprint.name}</span>}
          </div>
          {badgeStatus && <AgentStatusBadge status={badgeStatus} agentType="bugfix" />}
        </div>

        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          This v1 space is read-only — agents can no longer be started and content can no longer be
          edited.
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: past-run output + unanswered questions */}
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">Agent Output</CardTitle>
              </CardHeader>
              <CardContent>
                {agentOutput ? (
                  <AgentStreamPanel
                    streamingText={agentOutput}
                    activeToolCall={agentStatus.activeToolCall}
                    toolCalls={agentStatus.toolCalls}
                    maxHeight="32rem"
                    isStreaming={agentStatus.status?.status === 'RUNNING'}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No stored output from past agent runs.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Pending questions (static — answers can no longer be submitted) */}
            {pendingQuestions.map((pq) => (
              <Card key={pq.id} id={questionAnchorId(pq.id)} className="border-yellow-500/50">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-yellow-600">
                      <MessageCircleQuestion className="h-5 w-5" />
                      Agent Question
                      <Badge variant="outline" className="text-[10px]">
                        Unanswered
                      </Badge>
                    </CardTitle>
                    <DiscussButton
                      entityType="question"
                      entityId={pq.id}
                      entityTitle={pq.questions[0]?.text || `${pq.agent} agent question`}
                    />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Asked by the {pq.agent} agent. The run has ended and answers can no longer be
                    submitted.
                  </p>
                  {pq.questions.map((sq, i) => (
                    <div key={i} className="border-l-2 border-primary/30 pl-3">
                      <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{sq.text}</ReactMarkdown>
                      </div>
                      {sq.options.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {sq.options.map((opt, oi) => (
                            <Badge
                              key={oi}
                              variant="outline"
                              className="text-[10px] text-muted-foreground"
                              title={opt.description}
                            >
                              {opt.label}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Right column: Timeline */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Agent Invocations</CardTitle>
              </CardHeader>
              <CardContent>
                <TimelinePanel
                  events={timelineEvents.filter(
                    (e) =>
                      e.type === 'agent_invoked' ||
                      e.type === 'agent_started' ||
                      e.type === 'agent_completed' ||
                      e.type === 'agent_failed',
                  )}
                  loading={sprintLoading}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
