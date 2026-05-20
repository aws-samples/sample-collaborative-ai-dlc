import { useCallback, useEffect, useState } from 'react';
import { useSprint } from '@/contexts/SprintContext';
import { useAuth } from '@/contexts/AuthContext';
import { usePresence } from '@/hooks/usePresence';
import { useCollaborativeInception } from '@/hooks/useCollaborativeInception';
import { useAgentStatus } from '@/hooks/useAgentStatus';
import { useSprintEvents } from '@/hooks/useSprintEvents';
import { sprintsService } from '@/services/sprints';
import { agentsService } from '@/services/agents';
import { requirementsService } from '@/services/requirements';
import { userStoriesService } from '@/services/userStories';
import { tasksService } from '@/services/tasks';
import { generalInfoService } from '@/services/generalInfo';
import type { StructuredAnswer } from '@/services/questions';
import { questionsService } from '@/services/questions';
import { realtimeService } from '@/services/realtime';
import { timelineEventsService } from '@/services/timelineEvents';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import { ArtifactCard } from '@/components/domain/ArtifactCard';
import QuestionEditor from '@/components/QuestionEditor';
import { CollaborativeTextarea } from '@/components/CollaborativeTextarea';
import { AiModifyModal } from '@/components/AiModifyModal';
import { AgentStartErrorBanner } from '@/components/AgentStartErrorBanner';
import { extractAgentStartError, type AgentStartError } from '@/lib/agentStartError';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  FileText,
  Info,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  Play,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function InceptionPage() {
  const { user } = useAuth();
  const {
    sprint,
    requirements,
    userStories,
    tasks,
    generalInfo,
    questions,
    projectId,
    sprintId,
    reload,
    getNeighbors,
  } = useSprint();

  const [startingAgent, setStartingAgent] = useState(false);
  const [startError, setStartError] = useState<AgentStartError | null>(null);
  const [aiModify, setAiModify] = useState<{ id: string; type: string; title: string } | null>(
    null,
  );
  const [showStartOver, setShowStartOver] = useState(false);
  const [hasLaunchedAgent, setHasLaunchedAgent] = useState(false);
  const [executionArn, setExecutionArn] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [showRerunModal, setShowRerunModal] = useState(false);
  const [changeRequest, setChangeRequest] = useState('');
  const [approvingPhase, setApprovingPhase] = useState(false);

  const currentUser = {
    id: user?.username || '',
    name: user?.displayName || user?.email || '',
    color: '#6366f1',
  };
  const { setActivity } = usePresence(sprintId, currentUser);

  const { description, setDescription, initDescription, synced, remoteUsers, setCursor } =
    useCollaborativeInception(
      projectId,
      user?.username || '',
      user?.displayName || user?.email || '',
      {
        onSaveDescription: async (desc: string) => {
          try {
            await sprintsService.update(projectId, sprintId, { description: desc });
          } catch {
            /* */
          }
        },
        onSaveDraft: async () => {},
      },
    );

  const agentStatus = useAgentStatus({
    executionArn,
    executionId,
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

  // Restore execution
  useEffect(() => {
    if (!projectId || !sprintId || sprint?.phase !== 'INCEPTION') return;
    agentsService
      .getCurrentExecution(projectId, sprintId)
      .then((exec) => {
        if (exec?.executionArn) {
          setExecutionArn(exec.executionArn);
          setExecutionId(exec.executionId || null);
          if (
            exec.status !== 'FAILED' &&
            exec.status !== 'ABORTED' &&
            exec.status !== 'TIMED_OUT' &&
            exec.status !== 'STOPPED'
          )
            setHasLaunchedAgent(true);
        }
      })
      .catch(() => {});
  }, [projectId, sprintId, sprint?.phase]);

  // Init collaborative description
  useEffect(() => {
    if (synced && sprint?.description && !description) initDescription(sprint.description);
  }, [synced, sprint?.description, description, initDescription]);

  const userName = user?.displayName || user?.email || '';

  // Agent lifecycle
  useEffect(() => {
    if (agentStatus.status?.status === 'SUCCEEDED') {
      reload();
      timelineEventsService
        .create(sprintId, {
          type: 'agent_completed',
          title: 'Inception agent completed',
          userName,
        })
        .catch(() => {});
    }
    if (
      agentStatus.status?.status === 'FAILED' ||
      agentStatus.status?.status === 'ABORTED' ||
      agentStatus.status?.status === 'TIMED_OUT'
    ) {
      setHasLaunchedAgent(false);
      timelineEventsService
        .create(sprintId, {
          type: 'agent_failed',
          title: 'Inception agent failed',
          userName,
        })
        .catch(() => {});
    }
    // Auto-dismiss stale pending questions when agent is no longer running
    const terminal =
      agentStatus.status?.status === 'SUCCEEDED' ||
      agentStatus.status?.status === 'FAILED' ||
      agentStatus.status?.status === 'ABORTED' ||
      agentStatus.status?.status === 'TIMED_OUT';
    if (terminal && pendingQuestions.length > 0) {
      const dismissed: StructuredAnswer = {
        answers: [
          {
            selectedOptions: [],
            freeText: '(auto-dismissed — agent finished)',
          },
        ],
      };
      Promise.all(
        pendingQuestions.map((q) =>
          questionsService.update(sprintId, q.id, { structuredAnswer: dismissed }).catch(() => {}),
        ),
      ).then(() => reload());
    }
  }, [agentStatus.status?.status, reload, sprintId, userName]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (agentStatus.artifactsUpdated > 0) reload();
  }, [agentStatus.artifactsUpdated, reload]);

  const hasArtifacts = requirements.length > 0 || userStories.length > 0;
  const isFirstRun = !hasArtifacts;
  const promptEditable = !hasLaunchedAgent && isFirstRun;

  // Reload when new questions from the agent arrive
  useEffect(() => {
    if (agentStatus.questions.length > 0) {
      reload();
    }
  }, [agentStatus.questions.length, reload]);

  const pendingQuestions = questions
    .filter((q) => !q.structuredAnswer)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const answeredQuestions = questions.filter((q) => q.structuredAnswer);

  const handleStartAgent = async () => {
    if (!description.trim()) return;
    setStartingAgent(true);
    setStartError(null);
    try {
      await sprintsService.update(projectId, sprintId, { description });
      const result = await agentsService.startWorkflow(projectId, {
        phase: 'inception',
        sprintId,
        description,
        event: { event: 'start' },
      });
      setExecutionArn(result.executionArn);
      setExecutionId(result.executionId || null);
      setHasLaunchedAgent(true);
      timelineEventsService
        .create(sprintId, {
          type: 'agent_started',
          title: 'Inception agent launched',
          userName,
        })
        .catch(() => {});
    } catch (err) {
      console.error('Failed to start agent:', err);
      setStartError(extractAgentStartError(err));
    } finally {
      setStartingAgent(false);
    }
  };

  const handleRerunAgent = async () => {
    if (!changeRequest.trim()) return;
    setStartingAgent(true);
    setStartError(null);
    setShowRerunModal(false);
    try {
      const result = await agentsService.startWorkflow(projectId, {
        phase: 'inception',
        sprintId,
        description,
        changeRequest,
        event: { event: 'rerun' },
      });
      setExecutionArn(result.executionArn);
      setExecutionId(result.executionId || null);
      setHasLaunchedAgent(true);
      timelineEventsService
        .create(sprintId, {
          type: 'agent_started',
          title: `Inception agent re-run: ${changeRequest.slice(0, 60)}`,
          userName,
        })
        .catch(() => {});
      setChangeRequest('');
    } catch (err) {
      console.error('Failed to re-run agent:', err);
      setStartError(extractAgentStartError(err));
    } finally {
      setStartingAgent(false);
    }
  };

  const handleStartOver = async () => {
    try {
      if (executionArn) await agentsService.cancel(executionArn).catch(() => {});
      await Promise.allSettled([
        ...requirements.map((r) => requirementsService.delete(sprintId, r.id)),
        ...userStories.map((s) => userStoriesService.delete(sprintId, s.id)),
        ...tasks.map((t) => tasksService.delete(sprintId, t.id)),
        ...generalInfo.map((g) => generalInfoService.delete(sprintId, g.id)),
      ]);
      setExecutionArn(null);
      setExecutionId(null);
      setHasLaunchedAgent(false);
      agentStatus.setCompletedOutput('');
      timelineEventsService
        .create(sprintId, {
          type: 'started_over',
          title: 'Started over -- artifacts cleared',
          userName,
        })
        .catch(() => {});
      await reload();
    } catch (err) {
      console.error('Start over failed:', err);
    }
    setShowStartOver(false);
  };

  const handleApprovePhase = async () => {
    setApprovingPhase(true);
    try {
      await sprintsService.update(projectId, sprintId, { phase: 'CONSTRUCTION' });
      realtimeService.send('broadcastToDocument', {
        documentId: `sprint:${sprintId}`,
        action: 'sprint.phaseChanged',
        data: { phase: 'CONSTRUCTION', sprintId },
      });
      timelineEventsService
        .create(sprintId, {
          type: 'phase_changed',
          title: 'Moved to Construction phase',
          userName,
        })
        .catch(() => {});
      await reload();
    } catch (err) {
      console.error('Failed to approve phase:', err);
    } finally {
      setApprovingPhase(false);
    }
  };

  const handleAnswerQuestion = async (questionId: string, answer: StructuredAnswer) => {
    try {
      await questionsService.update(sprintId, questionId, { structuredAnswer: answer });
      realtimeService.send('broadcastToDocument', {
        data: { action: 'question.answered', sprintId, questionId },
      });
      timelineEventsService
        .create(sprintId, {
          type: 'question_answered',
          title: 'Answered agent question',
          userName,
        })
        .catch(() => {});
      await reload();
    } catch (err) {
      console.error('Failed to answer question:', err);
    }
  };

  const handleDismissQuestion = async (questionId: string) => {
    const dismissed: StructuredAnswer = {
      answers: [
        {
          selectedOptions: [],
          freeText: '(dismissed — agent no longer running)',
        },
      ],
    };
    try {
      await questionsService.update(sprintId, questionId, { structuredAnswer: dismissed });
      await reload();
    } catch (err) {
      console.error('Failed to dismiss question:', err);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-6 space-y-6">
          <div>
            <h1 className="text-xl font-bold">{sprint?.name || 'Loading...'}</h1>
            <p className="text-sm text-muted-foreground">
              Inception Phase -- Define what you want to build
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

          {/* Prompt */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-sm">Project Description</CardTitle>
                  {synced ? (
                    <Badge
                      variant="outline"
                      className="text-[9px] h-4 bg-agent-success/10 text-agent-success border-agent-success/30"
                    >
                      Live
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] h-4">
                      Connecting...
                    </Badge>
                  )}
                </div>
                {remoteUsers.size > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {remoteUsers.size} collaborator{remoteUsers.size > 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <CollaborativeTextarea
                value={description}
                onChange={(val: string) => {
                  setDescription(val);
                  setActivity('description');
                }}
                onBlur={() => setActivity('idle')}
                onCursorChange={setCursor}
                remoteUsers={remoteUsers}
                disabled={!promptEditable}
                placeholder="Describe what you want to build..."
                className="min-h-[150px] text-sm"
              />
            </CardContent>
          </Card>

          {/* Agent controls */}
          <div className="flex items-center gap-3 flex-wrap">
            {!hasLaunchedAgent ? (
              isFirstRun ? (
                <Button
                  onClick={handleStartAgent}
                  disabled={startingAgent || !description.trim()}
                  className="gap-2"
                >
                  {startingAgent ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {startingAgent ? 'Starting...' : 'Launch Inception Agent'}
                </Button>
              ) : (
                <Button
                  onClick={() => setShowRerunModal(true)}
                  disabled={startingAgent}
                  className="gap-2"
                  variant="outline"
                >
                  {startingAgent ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {startingAgent ? 'Starting...' : 'Re-run Inception Agent'}
                </Button>
              )
            ) : (
              <AgentStatusBadge
                status={
                  agentStatus.status?.status === 'RUNNING'
                    ? 'running'
                    : agentStatus.status?.status === 'SUCCEEDED'
                      ? 'completed'
                      : agentStatus.status?.status === 'FAILED'
                        ? 'failed'
                        : (sprint?.currentAgentStatus === 'cancelled'
                            ? 'failed'
                            : sprint?.currentAgentStatus) || 'idle'
                }
                agentType="inception"
              />
            )}
            {agentStatus.status?.status === 'SUCCEEDED' &&
              hasArtifacts &&
              sprint?.phase === 'INCEPTION' && (
                <Button onClick={handleApprovePhase} disabled={approvingPhase} className="gap-2">
                  {approvingPhase ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  {approvingPhase ? 'Approving...' : 'Approve & Move to Construction'}
                </Button>
              )}
            {hasArtifacts && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setShowStartOver(true)}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Start Over
              </Button>
            )}
          </div>

          {startError && (
            <AgentStartErrorBanner error={startError} onDismiss={() => setStartError(null)} />
          )}

          {/* Artifacts */}
          {hasArtifacts && (
            <Accordion
              type="multiple"
              defaultValue={['requirements', 'user-stories', 'tasks']}
              className="space-y-2"
            >
              <AccordionItem value="requirements" className="border rounded-lg px-4">
                <AccordionTrigger className="py-3 hover:no-underline">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-orange-500" />
                    <span className="text-sm font-medium">Requirements</span>
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {requirements.length}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-2 pb-2">
                    {requirements.map((req) => (
                      <ArtifactCard
                        key={req.id}
                        id={req.id}
                        type="requirement"
                        title={req.title}
                        fields={[
                          { key: 'title', label: 'Title', value: req.title },
                          {
                            key: 'description',
                            label: 'Description',
                            value: req.description,
                            multiline: true,
                          },
                          {
                            key: 'acceptanceCriteria',
                            label: 'Acceptance Criteria',
                            value: req.acceptanceCriteria,
                            multiline: true,
                          },
                        ]}
                        graphNeighbors={getNeighbors(req.id)}
                        onSave={async (f) => {
                          await requirementsService.update(sprintId, req.id, f);
                          reload();
                        }}
                        onDelete={async () => {
                          await requirementsService.delete(sprintId, req.id);
                          reload();
                        }}
                        onAiModify={() =>
                          setAiModify({
                            id: req.id,
                            type: 'requirement',
                            title: req.title,
                          })
                        }
                        readOnly={hasLaunchedAgent && agentStatus.status?.status === 'RUNNING'}
                      />
                    ))}
                    {requirements.length === 0 && (
                      <p className="text-xs text-muted-foreground py-2">No requirements yet.</p>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="user-stories" className="border rounded-lg px-4">
                <AccordionTrigger className="py-3 hover:no-underline">
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-green-500" />
                    <span className="text-sm font-medium">User Stories</span>
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {userStories.length}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-2 pb-2">
                    {userStories.map((story) => (
                      <ArtifactCard
                        key={story.id}
                        id={story.id}
                        type="user-story"
                        title={story.title}
                        fields={[
                          { key: 'title', label: 'Title', value: story.title },
                          {
                            key: 'description',
                            label: 'Description',
                            value: story.description,
                            multiline: true,
                          },
                        ]}
                        badges={story.storyPoints ? [{ label: `${story.storyPoints} pts` }] : []}
                        graphNeighbors={getNeighbors(story.id)}
                        onSave={async (f) => {
                          await userStoriesService.update(sprintId, story.id, f);
                          reload();
                        }}
                        onDelete={async () => {
                          await userStoriesService.delete(sprintId, story.id);
                          reload();
                        }}
                        onAiModify={() =>
                          setAiModify({
                            id: story.id,
                            type: 'user-story',
                            title: story.title,
                          })
                        }
                        readOnly={hasLaunchedAgent && agentStatus.status?.status === 'RUNNING'}
                      />
                    ))}
                    {userStories.length === 0 && (
                      <p className="text-xs text-muted-foreground py-2">No user stories yet.</p>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="tasks" className="border rounded-lg px-4">
                <AccordionTrigger className="py-3 hover:no-underline">
                  <div className="flex items-center gap-2">
                    <ListChecks className="h-4 w-4 text-amber-500" />
                    <span className="text-sm font-medium">Tasks</span>
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {tasks.length}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-2 pb-2">
                    {tasks.map((task) => (
                      <ArtifactCard
                        key={task.id}
                        id={task.id}
                        type="task"
                        title={task.title}
                        status={task.status}
                        fields={[
                          {
                            key: 'title',
                            label: 'Title',
                            value: task.title,
                          },
                          {
                            key: 'description',
                            label: 'Description',
                            value: task.description,
                            multiline: true,
                          },
                        ]}
                        graphNeighbors={getNeighbors(task.id)}
                        readOnly
                      />
                    ))}
                    {tasks.length === 0 && (
                      <p className="text-xs text-muted-foreground py-2">No tasks yet.</p>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>

              {generalInfo.length > 0 && (
                <AccordionItem value="general-info" className="border rounded-lg px-4">
                  <AccordionTrigger className="py-3 hover:no-underline">
                    <div className="flex items-center gap-2">
                      <Info className="h-4 w-4 text-blue-500" />
                      <span className="text-sm font-medium">General Information</span>
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                        {generalInfo.length}
                      </Badge>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2 pb-2">
                      {generalInfo.map((info) => (
                        <Card key={info.id} className="border-l-[3px] border-l-blue-500">
                          <CardContent className="p-3">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant="secondary" className="text-[9px] h-4">
                                {info.type}
                              </Badge>
                              <span className="text-xs font-medium">{info.title}</span>
                            </div>
                            <div className="prose prose-sm max-w-none text-xs text-muted-foreground">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {info.content}
                              </ReactMarkdown>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}
            </Accordion>
          )}

          {/* Q&A History */}
          {answeredQuestions.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <MessageCircleQuestion className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-sm">Q&A History</CardTitle>
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {answeredQuestions.length}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {answeredQuestions.map((q) => (
                    <div key={q.id} className="border rounded-lg p-3">
                      <p className="text-xs font-medium mb-1">Agent: {q.agent}</p>
                      {q.questions.map((sq, i) => (
                        <div key={i} className="mb-2">
                          <p className="text-xs text-muted-foreground">{sq.text}</p>
                          {q.structuredAnswer?.answers[i] && (
                            <div className="mt-1">
                              {q.structuredAnswer.answers[i].selectedOptions.map((optIdx) => (
                                <Badge
                                  key={optIdx}
                                  variant="secondary"
                                  className="text-[10px] mr-1"
                                >
                                  {sq.options[optIdx]?.label}
                                </Badge>
                              ))}
                              {q.structuredAnswer.answers[i].freeText && (
                                <p className="text-xs mt-1 italic">
                                  {q.structuredAnswer.answers[i].freeText}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {aiModify && (
        <AiModifyModal
          artifactId={aiModify.id}
          artifactType={aiModify.type}
          artifactTitle={aiModify.title}
          projectId={projectId}
          sprintId={sprintId}
          onClose={() => setAiModify(null)}
          onSubmit={async (instruction: string) => {
            await agentsService.startWorkflow(projectId, {
              phase: 'inception',
              sprintId,
              description: `MODIFY ARTIFACT: ${aiModify.type} ${aiModify.id}\n${instruction}`,
              event: { event: 'modify' },
            });
            setAiModify(null);
            reload();
          }}
        />
      )}

      {/* Re-run Inception Modal */}
      <Dialog open={showRerunModal} onOpenChange={setShowRerunModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-run Inception Agent</DialogTitle>
            <DialogDescription>
              The agent will review the existing artifacts and apply your changes. The original
              project description is shown below for reference.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Original description</p>
              <p className="text-xs border rounded-md p-2 bg-muted text-muted-foreground line-clamp-4">
                {description || '(no description)'}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium mb-1">What do you want to change?</p>
              <Textarea
                placeholder="e.g., Add a requirement for multi-language support, remove the analytics tasks, rename the auth requirement..."
                value={changeRequest}
                onChange={(e) => setChangeRequest(e.target.value)}
                rows={4}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRerunModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRerunAgent}
              disabled={!changeRequest.trim() || startingAgent}
              className="gap-2"
            >
              {startingAgent ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Re-run Agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showStartOver} onOpenChange={setShowStartOver}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" /> Start Over
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will delete all artifacts. Your inception prompt will be preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleStartOver}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Start Over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
