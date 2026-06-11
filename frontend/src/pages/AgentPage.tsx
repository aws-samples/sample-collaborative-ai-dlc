import { useState, useEffect, useCallback } from 'react';
import { useSprint } from '@/contexts/SprintContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAgentStatus } from '@/hooks/useAgentStatus';
import { useSprintEvents } from '@/hooks/useSprintEvents';
import { useQuestionAnchor } from '@/hooks/useQuestionAnchor';
import { questionAnchorId } from '@/lib/questionAnchor';
import { projectsService, type Project } from '@/services/projects';
import { agentsService } from '@/services/agents';
import { timelineEventsService } from '@/services/timelineEvents';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import { AgentStreamPanel } from '@/components/AgentStreamPanel';
import { TimelinePanel } from '@/components/TimelinePanel';
import { BranchSelector } from '@/components/BranchSelector';
import QuestionEditor from '@/components/QuestionEditor';
import { AgentStartErrorBanner } from '@/components/AgentStartErrorBanner';
import { extractAgentStartError, type AgentStartError } from '@/lib/agentStartError';
import { Bot, GitBranch, Loader2, ArrowLeft, MessageCircleQuestion, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { questionsService, type StructuredAnswer } from '@/services/questions';

type PageState = 'prompt' | 'running' | 'completed' | 'failed';

export default function AgentPage() {
  const { user } = useAuth();
  const {
    sprint,
    timelineEvents,
    questions,
    projectId,
    sprintId,
    reload,
    reloadTimeline,
    loading: sprintLoading,
  } = useSprint();

  const [project, setProject] = useState<Project | null>(null);
  const [showBranchSelector, setShowBranchSelector] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [startingAgent, setStartingAgent] = useState(false);
  const [startError, setStartError] = useState<AgentStartError | null>(null);
  const [executionArn, setExecutionArn] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  // Explicit page state -- the form stays visible until the user explicitly starts an agent.
  // This avoids the form disappearing due to stale execution state from other agent types.
  const [pageState, setPageState] = useState<PageState>('prompt');

  const userName = user?.displayName || user?.email || '';

  // Only connect useAgentStatus when we have an execution we started from this page
  const agentStatus = useAgentStatus({
    executionArn: pageState !== 'prompt' ? executionArn : null,
    executionId: pageState !== 'prompt' ? executionId : null,
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

  // Load project for git repo info
  useEffect(() => {
    if (projectId)
      projectsService
        .get(projectId)
        .then(setProject)
        .catch(() => {});
  }, [projectId]);

  // Track agent completion/failure from streaming status
  useEffect(() => {
    if (pageState !== 'running') return;
    if (agentStatus.status?.status === 'SUCCEEDED') setPageState('completed');
    if (agentStatus.status?.status === 'FAILED') setPageState('failed');
  }, [agentStatus.status?.status, pageState]);

  // Reload on agent artifacts
  useEffect(() => {
    if (agentStatus.artifactsUpdated > 0) reload();
  }, [agentStatus.artifactsUpdated, reload]);

  const pendingQuestions = questions
    .filter((q) => !q.structuredAnswer)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Scroll to a question referenced by a #question-{id} URL hash (timeline links)
  useQuestionAnchor(questions.length > 0);

  const handleSelectBranch = (branch: string, baseBranch: string) => {
    setShowBranchSelector(false);
    handleStartAgent(branch, baseBranch);
  };

  const handleStartAgent = async (branch: string, baseBranch: string) => {
    if (!instructions.trim()) return;
    setStartingAgent(true);
    setStartError(null);
    try {
      const result = await agentsService.startWorkflow(projectId, {
        phase: 'bugfix',
        sprintId,
        branch,
        baseBranch,
        description: instructions.trim(),
      });
      setExecutionArn(result.executionArn);
      setExecutionId(result.executionId || null);
      setSelectedBranch(branch);
      setPageState('running');

      // Record timeline event
      timelineEventsService
        .create(sprintId, {
          type: 'agent_invoked',
          title: 'Agent invoked for bug fix',
          detail: `Branch: ${branch}\n\nInstructions:\n${instructions.trim()}`,
          userName,
        })
        .catch(() => {});
      reloadTimeline().catch(() => {});
    } catch (err) {
      console.error('Failed to start bugfix agent:', err);
      setStartError(extractAgentStartError(err));
    } finally {
      setStartingAgent(false);
    }
  };

  const handleAnswerQuestion = async (questionId: string, answer: StructuredAnswer) => {
    try {
      await agentStatus.answerQuestion(questionId, answer);
      // question.answered is now emitted SERVER-SIDE by the questions/agents
      // lambdas (plan §4b, D10 end state) — no client broadcast.
      timelineEventsService
        .create(sprintId, {
          type: 'question_answered',
          title: 'Answered agent question',
          userName,
          questionId,
        })
        .catch(() => {});
      // The answer endpoint also syncs the Neptune Question vertex — reload so
      // the pending card clears and the Q&A history picks up the responder.
      await reload();
    } catch (err) {
      console.error('Failed to answer question:', err);
    }
  };

  const handleDismissQuestion = async (questionId: string) => {
    const dismissed: StructuredAnswer = {
      answers: [{ selectedOptions: [], freeText: '(dismissed — agent no longer running)' }],
    };
    try {
      await questionsService.update(sprintId, questionId, { structuredAnswer: dismissed });
      await reload();
    } catch (err) {
      console.error('Failed to dismiss question:', err);
    }
  };

  const handleCancel = async () => {
    if (!executionArn) return;
    try {
      await agentsService.cancel(executionArn);
      agentStatus.refresh();
      setPageState('failed');
    } catch (err) {
      console.error('Failed to cancel agent:', err);
    }
  };

  const handleInvokeAnother = () => {
    agentStatus.reset();
    setExecutionArn(null);
    setExecutionId(null);
    setSelectedBranch(null);
    setInstructions('');
    setPageState('prompt');
  };

  // Map page state to badge status
  const badgeStatus =
    pageState === 'running'
      ? 'running'
      : pageState === 'completed'
        ? 'completed'
        : pageState === 'failed'
          ? 'failed'
          : null;

  // Determine which phase page to link back to
  const phaseRoute =
    sprint?.phase === 'CONSTRUCTION'
      ? '/construction'
      : sprint?.phase === 'REVIEW' || sprint?.phase === 'COMPLETED'
        ? '/review'
        : '';

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              to={`/project/${projectId}/sprint/${sprintId}${phaseRoute}`}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex items-center gap-2">
              <Bot className="h-6 w-6 text-purple-500" />
              <h1 className="text-2xl font-bold">Invoke Agent</h1>
            </div>
            {sprint && <span className="text-sm text-muted-foreground">{sprint.name}</span>}
          </div>
          <div className="flex items-center gap-2">
            {badgeStatus && <AgentStatusBadge status={badgeStatus} agentType="bugfix" />}
            {pageState === 'running' && (
              <Button variant="outline" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: Prompt form + stream */}
          <div className="lg:col-span-2 space-y-6">
            {/* Prompt Form -- always visible, but read-only once agent is running */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bot className="h-5 w-5" />
                  {pageState === 'prompt'
                    ? 'Describe What the Agent Should Do'
                    : 'Agent Instructions'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {pageState === 'prompt' && (
                  <p className="text-sm text-muted-foreground">
                    Invoke a general-purpose agent on a branch to fix bugs, make adjustments, or
                    perform other targeted changes. This is outside the AI-DLC lifecycle -- the
                    agent will simply follow your instructions and commit changes.
                  </p>
                )}
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  readOnly={pageState !== 'prompt'}
                  placeholder="Describe the bugs to fix or changes to make...&#10;&#10;Example: The login form doesn't validate email format before submission. Fix the validation logic in src/components/LoginForm.tsx to check for valid email format and show an error message."
                  className={`w-full px-3 py-2 text-sm border rounded-md bg-background resize-y focus:outline-none focus:ring-2 focus:ring-ring ${
                    pageState === 'prompt'
                      ? 'min-h-[160px]'
                      : 'min-h-[80px] opacity-75 cursor-default'
                  }`}
                />
                {pageState === 'prompt' && (
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      The agent will check out the branch, apply fixes, and commit changes. The
                      system pushes the branch after the agent finishes.
                    </p>
                    <Button
                      onClick={() => setShowBranchSelector(true)}
                      disabled={!instructions.trim() || startingAgent || !project?.gitRepo}
                    >
                      {startingAgent ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Starting...
                        </>
                      ) : (
                        <>
                          <GitBranch className="h-4 w-4 mr-2" />
                          Select Branch & Start
                        </>
                      )}
                    </Button>
                  </div>
                )}
                {pageState === 'prompt' && !project?.gitRepo && (
                  <p className="text-sm text-destructive">
                    This project has no git repository configured. Connect a repo in project
                    settings.
                  </p>
                )}
                {pageState === 'prompt' && startError && (
                  <AgentStartErrorBanner error={startError} onDismiss={() => setStartError(null)} />
                )}
                {pageState !== 'prompt' && selectedBranch && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <GitBranch className="h-3 w-3" />
                    {selectedBranch}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Agent Stream -- shown once agent is running */}
            {pageState !== 'prompt' && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">Agent Output</CardTitle>
                </CardHeader>
                <CardContent>
                  <AgentStreamPanel
                    streamingText={agentStatus.completedOutput || agentStatus.streamingText}
                    activeToolCall={agentStatus.activeToolCall}
                    toolCalls={agentStatus.toolCalls}
                    maxHeight="32rem"
                    isStreaming={pageState === 'running'}
                  />
                </CardContent>
              </Card>
            )}

            {/* Invoke Another */}
            {(pageState === 'completed' || pageState === 'failed') && (
              <div className="flex items-center gap-3">
                <Button onClick={handleInvokeAnother} variant="outline">
                  <Bot className="h-4 w-4 mr-2" />
                  Invoke Another Agent
                </Button>
                <span className="text-sm text-muted-foreground">
                  {pageState === 'completed'
                    ? 'Agent completed successfully. Changes have been pushed to the branch.'
                    : 'Agent failed. You can try again with different instructions.'}
                </span>
              </div>
            )}

            {/* Pending Questions */}
            {pendingQuestions.length > 0 &&
              pendingQuestions.map((pq) => (
                <Card key={pq.id} id={questionAnchorId(pq.id)} className="border-yellow-500/50">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2 text-yellow-600">
                        <MessageCircleQuestion className="h-5 w-5" />
                        Agent Has a Question
                      </CardTitle>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDismissQuestion(pq.id)}
                        title="Dismiss question"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <QuestionEditor
                      question={pq}
                      sprintId={sprintId}
                      userName={userName}
                      onAnswer={(answer: StructuredAnswer) => handleAnswerQuestion(pq.id, answer)}
                    />
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

      {/* Branch Selector Modal */}
      {showBranchSelector && project?.gitRepo && (
        <BranchSelector
          gitRepo={project.gitRepo}
          onSelect={handleSelectBranch}
          onCancel={() => setShowBranchSelector(false)}
          title="Select Branch for Agent"
          submitLabel="Start Agent"
          defaultUseExisting
        />
      )}
    </div>
  );
}
