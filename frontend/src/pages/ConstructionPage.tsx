import { useState, useEffect, useCallback } from 'react';
import { useSprint } from '@/contexts/SprintContext';
import { useAuth } from '@/contexts/AuthContext';
import { usePresence } from '@/hooks/usePresence';
import { useAgentStatus } from '@/hooks/useAgentStatus';
import { useConstructionStatus } from '@/hooks/useConstructionStatus';
import { useSprintEvents } from '@/hooks/useSprintEvents';
import { sprintsService } from '@/services/sprints';
import { projectsService, type Project } from '@/services/projects';
import { agentsService } from '@/services/agents';
import { questionsService } from '@/services/questions';
import { tasksService } from '@/services/tasks';
import { realtimeService } from '@/services/realtime';
import { timelineEventsService } from '@/services/timelineEvents';
import { Button } from '@/components/ui/button';
import { PrCheckoutCommand } from '@/components/PrCheckoutCommand';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import { ArtifactCard } from '@/components/domain/ArtifactCard';
import QuestionEditor from '@/components/QuestionEditor';
import { BranchSelector } from '@/components/BranchSelector';
import CodeFileViewer from '@/components/CodeFileViewer';
import { GitHubFileBrowser } from '@/components/GitHubFileBrowser';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Hammer,
  Loader2,
  ExternalLink,
  RefreshCw,
  ListChecks,
  Code2,
  MessageCircleQuestion,
  GitBranch,
  Eye,
  Wrench,
  ArrowRight,
  Folder,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StructuredAnswer } from '@/services/questions';
import { TaskSettingsDialog } from '@/components/settings/TaskSettingsDialog';
import { TaskActionsMenu } from '@/components/domain/TaskActionsMenu';
import type { Task } from '@/services/tasks';

export default function ConstructionPage() {
  const { user } = useAuth();
  const { sprint, tasks, codeFiles, questions, projectId, sprintId, reload } = useSprint();

  const [project, setProject] = useState<Project | null>(null);
  const [showBranchSelector, setShowBranchSelector] = useState(false);
  const [branchSelectorMode, setBranchSelectorMode] = useState<'construction' | 'create-pr'>(
    'construction',
  );
  const [showGitHub, setShowGitHub] = useState(false);
  const [startingConstruction, setStartingConstruction] = useState(false);
  const [executionArn, setExecutionArn] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [showRerunModal, setShowRerunModal] = useState(false);
  const [changeRequest, setChangeRequest] = useState('');

  const currentUser = {
    id: user?.username || '',
    name: user?.displayName || user?.email || '',
    color: '#f59e0b',
  };
  const userName = user?.displayName || user?.email || '';
  const { setActivity } = usePresence(sprintId, currentUser);

  const agentStatus = useAgentStatus({
    executionArn,
    executionId,
    projectId,
    sprintId,
    sprintAgentStatus: sprint?.currentAgentStatus,
  });
  const constructionStatus = useConstructionStatus({
    projectId,
    sprintId,
    executionArn,
    executionId,
  });
  useSprintEvents(
    sprintId,
    useCallback(() => {
      reload();
    }, [reload]),
  );

  // Load project
  useEffect(() => {
    if (projectId)
      projectsService
        .get(projectId)
        .then(setProject)
        .catch(() => {});
  }, [projectId]);

  // Restore execution (only when sprint is in CONSTRUCTION phase)
  useEffect(() => {
    if (!projectId || !sprintId || sprint?.phase !== 'CONSTRUCTION') return;
    agentsService
      .getCurrentExecution(projectId, sprintId)
      .then((exec) => {
        if (exec?.executionArn) {
          setExecutionArn(exec.executionArn);
          setExecutionId(exec.executionId || null);
        }
      })
      .catch(() => {});
  }, [projectId, sprintId, sprint?.phase]);

  // Backfill older sprints that started construction before the Sprint
  // workflow-state contract existed. If construction evidence already exists,
  // normalize the UI-owned phase so the dashboard no longer shows Inception as active.
  useEffect(() => {
    if (!projectId || !sprintId || !sprint || sprint.phase !== 'INCEPTION') return;
    const hasConstructionEvidence =
      sprint.currentAgentType === 'construction-orchestrator' ||
      sprint.currentAgentType === 'construction' ||
      codeFiles.length > 0 ||
      Boolean(sprint.branch);
    if (!hasConstructionEvidence) return;

    sprintsService
      .update(projectId, sprintId, {
        phase: 'CONSTRUCTION',
        currentStage: sprint.currentStage || 'code-generation',
        phaseStatus: sprint.phaseStatus || 'active',
      })
      .then(() => {
        realtimeService.send('broadcastToDocument', {
          documentId: `sprint:${sprintId}`,
          action: 'sprint.phaseChanged',
          data: { phase: 'CONSTRUCTION', sprintId },
        });
        return reload();
      })
      .catch(() => {});
  }, [codeFiles.length, projectId, reload, sprint, sprintId]);

  // Reload on agent artifacts
  useEffect(() => {
    if (agentStatus.artifactsUpdated > 0) reload();
  }, [agentStatus.artifactsUpdated, reload]);

  // PR created event
  useEffect(() => {
    const unsub = realtimeService.on('pr.created', () => {
      reload();
    });
    return () => {
      unsub?.();
    };
  }, [reload]);

  const allTasksDone =
    tasks.length > 0 && tasks.every((t) => t.status === 'done' || t.status === 'failed');
  const constructionComplete =
    allTasksDone && (!agentStatus.status?.status || agentStatus.status.status !== 'RUNNING');

  // Reload when new questions from the agent arrive
  useEffect(() => {
    if (agentStatus.questions.length > 0) {
      reload();
    }
  }, [agentStatus.questions.length, reload]);

  const pendingQuestions = questions
    .filter((q) => !q.structuredAnswer)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Branch is stored on the sprint after first kick-off — skip BranchSelector on re-runs
  const storedBranch = sprint?.branch || null;
  const storedBaseBranch = sprint?.baseBranch || 'main';

  const handleStartConstruction = async (
    branch: string,
    baseBranch: string,
    additionalContext?: string,
  ) => {
    setStartingConstruction(true);
    setShowBranchSelector(false);
    try {
      // Construction kick-off is a UI-owned phase transition. Normalize older
      // sprints that reached this page before workflow state fields existed.
      await sprintsService.update(projectId, sprintId, {
        phase: 'CONSTRUCTION',
        currentStage: 'code-generation',
        phaseStatus: 'active',
        branch,
        baseBranch,
      });
      realtimeService.send('broadcastToDocument', {
        documentId: `sprint:${sprintId}`,
        action: 'sprint.phaseChanged',
        data: { phase: 'CONSTRUCTION', sprintId },
      });
      const result = await agentsService.startWorkflow(projectId, {
        phase: 'construction-orchestrator',
        sprintId,
        branch,
        baseBranch,
        changeRequest: additionalContext || '',
        event: { event: 'start' },
      });
      setExecutionArn(result.executionArn);
      setExecutionId(result.executionId || null);
      const title = additionalContext
        ? `Construction re-run: ${additionalContext.slice(0, 60)}`
        : 'Construction agent launched';
      timelineEventsService
        .create(sprintId, { type: 'agent_started', title, detail: `Branch: ${branch}`, userName })
        .catch(() => {});
      await reload();
    } catch (err) {
      console.error('Failed to start construction:', err);
    } finally {
      setStartingConstruction(false);
    }
  };

  const handleKickOffConstruction = () => {
    if (storedBranch) {
      // Has previous runs — open re-run modal for optional context
      setShowRerunModal(true);
    } else {
      setBranchSelectorMode('construction');
      setShowBranchSelector(true);
    }
  };

  const handleConfirmRerun = () => {
    setShowRerunModal(false);
    handleStartConstruction(storedBranch!, storedBaseBranch, changeRequest.trim() || undefined);
    setChangeRequest('');
  };

  const handleCreatePr = async (branch: string, baseBranch: string) => {
    setStartingConstruction(true);
    setShowBranchSelector(false);
    try {
      // Re-kick the orchestrator — it will see all tasks done and call trigger_pr_creation
      const result = await agentsService.startWorkflow(projectId, {
        phase: 'construction-orchestrator',
        sprintId,
        branch,
        baseBranch,
        event: { event: 'start' },
      });
      setExecutionArn(result.executionArn);
      setExecutionId(result.executionId || null);
      timelineEventsService
        .create(sprintId, {
          type: 'agent_started',
          title: 'PR creation triggered',
          detail: `Branch: ${branch}`,
          userName,
        })
        .catch(() => {});
      await reload();
    } catch (err) {
      console.error('Failed to trigger PR creation:', err);
    } finally {
      setStartingConstruction(false);
    }
  };

  const handleKickOffCreatePr = () => {
    if (storedBranch) {
      handleCreatePr(storedBranch, storedBaseBranch);
    } else {
      setBranchSelectorMode('create-pr');
      setShowBranchSelector(true);
    }
  };

  const handleAnswerQuestion = async (questionId: string, answer: StructuredAnswer) => {
    try {
      await questionsService.update(sprintId, questionId, { structuredAnswer: answer });
      realtimeService.send('broadcastToDocument', {
        data: { action: 'question.answered', sprintId, questionId },
      });
      timelineEventsService
        .create(sprintId, { type: 'question_answered', title: 'Answered agent question', userName })
        .catch(() => {});
      await reload();
    } catch (err) {
      console.error('Failed to answer:', err);
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

  const [approvingPhase, setApprovingPhase] = useState(false);

  const handleApprovePhase = async () => {
    setApprovingPhase(true);
    try {
      await sprintsService.update(projectId, sprintId, {
        phase: 'REVIEW',
        currentStage: null,
        phaseStatus: 'active',
      });
      realtimeService.send('broadcastToDocument', {
        documentId: `sprint:${sprintId}`,
        action: 'sprint.phaseChanged',
        data: { phase: 'REVIEW', sprintId },
      });
      timelineEventsService
        .create(sprintId, { type: 'phase_changed', title: 'Moved to Review phase', userName })
        .catch(() => {});
      await reload();
    } catch (err) {
      console.error('Failed to approve phase:', err);
    } finally {
      setApprovingPhase(false);
    }
  };

  const [resettingTaskId, setResettingTaskId] = useState<string | null>(null);
  const [settingsTask, setSettingsTask] = useState<Task | null>(null);

  const handleResetTask = async (taskId: string, taskTitle: string) => {
    if (
      !confirm(
        `Reset "${taskTitle}" back to To Do? This will allow it to be re-dispatched on the next construction run.`,
      )
    )
      return;
    setResettingTaskId(taskId);
    try {
      await tasksService.update(sprintId, taskId, { status: 'todo' });
      timelineEventsService
        .create(sprintId, {
          type: 'task_reset',
          title: `Reset task: ${taskTitle}`,
          detail: 'Task reset to todo for re-dispatch',
          userName,
        })
        .catch(() => {});
      await reload();
    } catch (err) {
      console.error('Failed to reset task:', err);
    } finally {
      setResettingTaskId(null);
    }
  };

  // Group tasks by status
  const tasksByStatus = {
    todo: tasks.filter((t) => t.status === 'todo'),
    in_progress: tasks.filter((t) => t.status === 'in_progress'),
    done: tasks.filter((t) => t.status === 'done'),
    failed: tasks.filter((t) => t.status === 'failed'),
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-6 space-y-6">
          <div>
            <h1 className="text-xl font-bold">{sprint?.name || 'Loading...'}</h1>
            <p className="text-sm text-muted-foreground">
              Construction Phase -- Build and implement
              {storedBranch && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  <GitBranch className="h-3 w-3" />
                  {storedBranch}
                </span>
              )}
            </p>
          </div>

          {/* Pending questions */}
          {pendingQuestions.map((pq) => (
            <Card key={pq.id} className="border-agent-waiting bg-agent-waiting/5">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageCircleQuestion className="h-4 w-4 text-agent-waiting" />
                    <CardTitle className="text-sm">Agent Question</CardTitle>
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-agent-waiting/10 border-agent-waiting/30"
                    >
                      Needs your input
                    </Badge>
                  </div>
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
                  userName={user?.displayName || user?.email || ''}
                  onAnswer={(answer) => handleAnswerQuestion(pq.id, answer)}
                  onAutoSave={async (draft) => {
                    questionsService
                      .update(sprintId, pq.id, { draftAnswer: draft })
                      .catch(() => {});
                  }}
                  onFocus={() => setActivity('question', pq.id)}
                  onBlur={() => setActivity('idle')}
                />
              </CardContent>
            </Card>
          ))}

          {/* PR banner */}
          {sprint?.prUrl && (
            <Card className="border-agent-success bg-agent-success/5">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-3">
                  <GitBranch className="h-5 w-5 text-agent-success" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">Pull Request Created</p>
                    <a
                      href={sprint.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-agent-success hover:underline"
                    >
                      PR #{sprint.prNumber} -- View on GitHub
                    </a>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => window.open(sprint.prUrl!, '_blank')}
                  >
                    <ExternalLink className="h-3 w-3" /> View PR
                  </Button>
                </div>
                {sprint.prNumber && (
                  <PrCheckoutCommand
                    prNumber={sprint.prNumber}
                    branch={sprint.branch}
                    baseBranch={sprint.baseBranch}
                    gitRepo={project?.gitRepo}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            {!constructionComplete ? (
              // In-progress: show primary kick-off button
              <Button
                onClick={handleKickOffConstruction}
                disabled={
                  tasks.length === 0 ||
                  startingConstruction ||
                  agentStatus.status?.status === 'RUNNING'
                }
                className="gap-2"
              >
                {startingConstruction ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Hammer className="h-4 w-4" />
                )}
                {startingConstruction
                  ? 'Starting...'
                  : storedBranch
                    ? 'Re-run Construction'
                    : 'Kick-Off Construction'}
              </Button>
            ) : (
              // Complete: show re-run as outline button so it doesn't dominate
              <Button
                variant="outline"
                onClick={handleKickOffConstruction}
                disabled={startingConstruction || agentStatus.status?.status === 'RUNNING'}
                className="gap-2"
              >
                {startingConstruction ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {startingConstruction ? 'Starting...' : 'Re-run Construction'}
              </Button>
            )}

            {/* Create PR button — only when no PR yet and construction is complete */}
            {constructionComplete && !sprint?.prUrl && (
              <Button
                onClick={handleKickOffCreatePr}
                disabled={startingConstruction || agentStatus.status?.status === 'RUNNING'}
                className="gap-2"
              >
                {startingConstruction ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <GitBranch className="h-4 w-4" />
                )}
                {startingConstruction ? 'Creating PR...' : 'Create PR'}
              </Button>
            )}

            {/* Move to Review button — when construction complete, PR exists, and still in CONSTRUCTION phase */}
            {constructionComplete && sprint?.prUrl && sprint?.phase === 'CONSTRUCTION' && (
              <Button onClick={handleApprovePhase} disabled={approvingPhase} className="gap-2">
                {approvingPhase ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                {approvingPhase ? 'Ending Construction...' : 'End Construction & Move to Review'}
              </Button>
            )}

            {agentStatus.status?.status === 'RUNNING' && (
              <AgentStatusBadge status="running" agentType="construction" />
            )}

            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 ml-auto"
              onClick={() => setShowGitHub(true)}
            >
              <Eye className="h-3.5 w-3.5" /> View Repo Files
            </Button>
          </div>

          {/* Warning when construction done but PR missing */}
          {constructionComplete && !sprint?.prUrl && agentStatus.status?.status !== 'RUNNING' && (
            <Card className="border-amber-500/50 bg-amber-500/5">
              <CardContent className="p-3 text-sm text-amber-600 dark:text-amber-400">
                Construction is complete but no Pull Request was created. Click{' '}
                <strong>Create PR</strong> to have the orchestrator create one now, or advance to
                Review and link a PR manually from there.
              </CardContent>
            </Card>
          )}

          {/* Task board */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <ListChecks className="h-4 w-4" />
              <h2 className="text-sm font-semibold">Tasks</h2>
              <Badge variant="secondary" className="text-[10px]">
                {tasks.length}
              </Badge>
              {allTasksDone && tasks.length > 0 && (
                <Badge
                  className="text-[10px] bg-agent-success/15 text-agent-success border-agent-success/30"
                  variant="outline"
                >
                  All done
                </Badge>
              )}
            </div>

            {/* Kanban columns */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(['todo', 'in_progress', 'done'] as const).map((status) => {
                const statusTasks = tasksByStatus[status] || [];
                const labels: Record<string, { label: string; color: string }> = {
                  todo: { label: 'To Do', color: 'text-muted-foreground' },
                  in_progress: { label: 'In Progress', color: 'text-phase-inception' },
                  done: { label: 'Done', color: 'text-agent-success' },
                  failed: { label: 'Failed', color: 'text-agent-error' },
                };
                const cfg = labels[status];

                return (
                  <div key={status}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={cn('text-xs font-medium', cfg.color)}>{cfg.label}</span>
                      <Badge variant="outline" className="h-4 px-1 text-[9px]">
                        {statusTasks.length}
                      </Badge>
                    </div>
                    <div className="space-y-2">
                      {statusTasks.map((task) => {
                        const stream = constructionStatus.taskStreams[task.id];
                        return (
                          <Card
                            key={task.id}
                            className={cn(
                              'transition-all',
                              status === 'in_progress' && 'border-phase-inception/30',
                            )}
                          >
                            <CardContent className="p-3">
                              <div className="flex items-start gap-2">
                                <AgentStatusBadge
                                  compact
                                  status={
                                    task.status === 'done'
                                      ? 'completed'
                                      : task.status === 'failed'
                                        ? 'failed'
                                        : stream?.activeToolCall
                                          ? 'running'
                                          : task.status === 'in_progress'
                                            ? 'running'
                                            : 'idle'
                                  }
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-medium leading-tight">{task.title}</p>
                                  {task.description && (
                                    <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
                                      {task.description}
                                    </p>
                                  )}
                                </div>
                                <TaskActionsMenu
                                  task={task}
                                  isResetting={
                                    task.status === 'done' && resettingTaskId === task.id
                                  }
                                  onOpenSettings={setSettingsTask}
                                  onReset={handleResetTask}
                                  variant="compact"
                                  disableReset={task.status !== 'done'}
                                />
                              </div>
                              {stream?.text && task.status === 'in_progress' && (
                                <div className="mt-2 space-y-1.5">
                                  {/* Active tool call indicator */}
                                  {stream.activeToolCall && (
                                    <div className="flex items-center gap-1.5 text-[10px] text-yellow-400">
                                      <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0" />
                                      <Wrench className="h-2.5 w-2.5 shrink-0" />
                                      <span className="font-mono truncate">
                                        {stream.activeToolCall}
                                      </span>
                                    </div>
                                  )}
                                  {/* Tool call summary */}
                                  {stream.toolCalls && stream.toolCalls.length > 0 && (
                                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                      <Wrench className="h-2.5 w-2.5 shrink-0" />
                                      <span>
                                        {
                                          stream.toolCalls.filter((t) => t.status === 'completed')
                                            .length
                                        }
                                        /{stream.toolCalls.length} tools
                                      </span>
                                    </div>
                                  )}
                                  {/* Markdown-rendered streaming text */}
                                  <div className="rounded bg-zinc-950 p-2 max-h-[120px] overflow-y-auto">
                                    <div className="prose prose-invert prose-xs max-w-none [&_p]:text-[10px] [&_p]:leading-relaxed [&_li]:text-[10px] [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-[10px] [&_pre]:text-[9px] [&_code]:text-[9px]">
                                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                        {stream.text.length > 1000
                                          ? stream.text.slice(-1000).replace(/^[^\n]*\n/, '')
                                          : stream.text}
                                      </ReactMarkdown>
                                      {stream.activeToolCall && (
                                        <span className="inline-block w-1 h-2.5 bg-zinc-500 animate-pulse ml-0.5" />
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })}
                      {statusTasks.length === 0 && (
                        <p className="text-[11px] text-muted-foreground py-2">No tasks</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Failed tasks */}
            {tasksByStatus.failed.length > 0 && (
              <div>
                <span className="text-xs font-medium text-agent-error">
                  Failed ({tasksByStatus.failed.length})
                </span>
                <div className="space-y-2 mt-2">
                  {tasksByStatus.failed.map((task) => (
                    <div key={task.id} className="flex items-start gap-2">
                      <div className="flex-1">
                        <ArtifactCard
                          id={task.id}
                          type="task"
                          title={task.title}
                          status="failed"
                          fields={[
                            {
                              key: 'description',
                              label: 'Description',
                              value: task.description,
                              multiline: true,
                            },
                          ]}
                          readOnly
                        />
                      </div>
                      <TaskActionsMenu
                        task={task}
                        isResetting={resettingTaskId === task.id}
                        onOpenSettings={setSettingsTask}
                        onReset={handleResetTask}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Code files */}
          {codeFiles.length > 0 && (
            <Accordion type="single" collapsible>
              <AccordionItem value="code-files" className="border rounded-lg px-4">
                <AccordionTrigger className="py-3 hover:no-underline">
                  <div className="flex items-center gap-2">
                    <Code2 className="h-4 w-4 text-red-500" />
                    <span className="text-sm font-medium">Code Files</span>
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {codeFiles.length}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-2 pb-2">
                    {(() => {
                      const grouped = new Map<string, typeof codeFiles>();
                      for (const file of codeFiles) {
                        const lastSlash = file.filePath.lastIndexOf('/');
                        const folder = lastSlash >= 0 ? file.filePath.substring(0, lastSlash) : '.';
                        if (!grouped.has(folder)) grouped.set(folder, []);
                        grouped.get(folder)!.push(file);
                      }
                      return (
                        <Accordion type="multiple" className="space-y-1">
                          {Array.from(grouped.entries())
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([folder, files]) => (
                              <AccordionItem
                                key={folder}
                                value={folder}
                                className="border rounded-md"
                              >
                                <AccordionTrigger className="py-2 px-3 hover:no-underline text-xs">
                                  <div className="flex items-center gap-1.5 font-mono text-muted-foreground">
                                    <Folder className="h-3.5 w-3.5 shrink-0" />
                                    {folder}
                                    <Badge variant="outline" className="h-4 px-1 text-[9px] ml-1">
                                      {files.length}
                                    </Badge>
                                  </div>
                                </AccordionTrigger>
                                <AccordionContent className="px-3 pb-2">
                                  <div className="space-y-1.5">
                                    {files
                                      .sort((a, b) => a.filePath.localeCompare(b.filePath))
                                      .map((file) => (
                                        <CodeFileViewer key={file.id} codeFile={file} />
                                      ))}
                                  </div>
                                </AccordionContent>
                              </AccordionItem>
                            ))}
                        </Accordion>
                      );
                    })()}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </div>
      </div>

      {/* Re-run Construction Modal */}
      <Dialog open={showRerunModal} onOpenChange={setShowRerunModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-run Construction Agent</DialogTitle>
            <DialogDescription>
              {constructionComplete
                ? 'All tasks are done. Describe what you want to build or fix — the agent will create new tasks and implement them on the existing branch.'
                : 'The agent will pick up any tasks still in "To Do". You can optionally provide additional context.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted rounded-md px-3 py-2">
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
              <span className="font-mono">{storedBranch}</span>
            </div>
            <div>
              <p className="text-xs font-medium mb-1">
                {constructionComplete ? 'What do you want to build or fix?' : 'Additional context'}
                {!constructionComplete && (
                  <span className="text-muted-foreground font-normal"> (optional)</span>
                )}
              </p>
              <Textarea
                placeholder={
                  constructionComplete
                    ? 'e.g., Add input validation to all forms, fix the 404 error on the profile page, add a dark mode toggle...'
                    : 'e.g., Focus on the failing tasks, use PostgreSQL instead of SQLite...'
                }
                value={changeRequest}
                onChange={(e) => setChangeRequest(e.target.value)}
                rows={4}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowRerunModal(false);
                setChangeRequest('');
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmRerun}
              disabled={startingConstruction || (constructionComplete && !changeRequest.trim())}
              className="gap-2"
            >
              {startingConstruction ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Launch Agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Branch selector modal (only shown when branch not yet stored) */}
      {showBranchSelector && project && (
        <BranchSelector
          gitRepo={project.gitRepo}
          onSelect={(branch, baseBranch) =>
            branchSelectorMode === 'create-pr'
              ? handleCreatePr(branch, baseBranch)
              : handleStartConstruction(branch, baseBranch)
          }
          onCancel={() => setShowBranchSelector(false)}
        />
      )}

      {/* GitHub file browser */}
      {showGitHub &&
        project &&
        (() => {
          const [owner, repo] = project.gitRepo.split('/');
          return (
            <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-8">
              <Card className="w-full max-w-5xl max-h-[80vh] overflow-hidden">
                <CardHeader className="py-2 px-4 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">Repository Files</CardTitle>
                  <Button variant="ghost" size="sm" onClick={() => setShowGitHub(false)}>
                    Close
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  <GitHubFileBrowser owner={owner} repo={repo} />
                </CardContent>
              </Card>
            </div>
          );
        })()}

      {/* Task Settings */}
      {sprintId && settingsTask && (
        <TaskSettingsDialog
          open={!!settingsTask}
          onOpenChange={(open) => {
            if (!open) setSettingsTask(null);
          }}
          sprintId={sprintId}
          taskId={settingsTask.id}
          taskTitle={settingsTask.title}
          canEdit={settingsTask.status === 'todo'}
        />
      )}
    </div>
  );
}
