import { useCallback } from 'react';
import { useSprint } from '@/contexts/SprintContext';
import { useAgentStatus } from '@/hooks/useAgentStatus';
import { useSprintEvents } from '@/hooks/useSprintEvents';
import { useQuestionAnchor } from '@/hooks/useQuestionAnchor';
import { questionAnchorId } from '@/lib/questionAnchor';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import { ArtifactCard } from '@/components/domain/ArtifactCard';
import { BookOpen, FileText, Info, ListChecks, MessageCircleQuestion } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DiscussButton } from '@/components/discussion';

// v1 projects are read-only: the v1 execution engine has been retired, so this
// page keeps all display functionality (artifacts, Q&A history, description)
// but no write affordances (no agent starts, edits, deletes, or answers).
export default function InceptionPage() {
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

  // Read-only status of the last agent run (GET endpoints only).
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

  const hasArtifacts = requirements.length > 0 || userStories.length > 0;

  const pendingQuestions = questions
    .filter((q) => !q.structuredAnswer)
    .toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const answeredQuestions = questions.filter((q) => q.structuredAnswer);

  // Scroll to a question referenced by a #question-{id} URL hash (timeline links)
  useQuestionAnchor(questions.length > 0);

  const badgeStatus =
    agentStatus.status?.status === 'RUNNING'
      ? 'running'
      : agentStatus.status?.status === 'SUCCEEDED'
        ? 'completed'
        : agentStatus.status?.status
          ? 'failed'
          : (sprint?.currentAgentStatus === 'cancelled' ? 'failed' : sprint?.currentAgentStatus) ||
            null;

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

          <div className="rounded-lg border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
            This v1 space is read-only — agents can no longer be started and content can no longer
            be edited.
          </div>

          {badgeStatus && <AgentStatusBadge status={badgeStatus} agentType="inception" />}

          {/* Pending questions (static — answers can no longer be submitted) */}
          {pendingQuestions.map((pq) => (
            <Card
              key={pq.id}
              id={questionAnchorId(pq.id)}
              className="border-agent-waiting bg-agent-waiting/5"
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageCircleQuestion className="h-4 w-4 text-agent-waiting" />
                    <CardTitle className="text-sm">Agent Question</CardTitle>
                    <Badge variant="outline" className="text-[10px]">
                      Unanswered
                    </Badge>
                  </div>
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

          {/* Project description (static) */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Space Description</CardTitle>
                <DiscussButton entityType="inception" entityTitle="Space Description" />
              </div>
            </CardHeader>
            <CardContent>
              {sprint?.description ? (
                <p className="text-sm whitespace-pre-wrap">{sprint.description}</p>
              ) : (
                <p className="text-sm text-muted-foreground">No description.</p>
              )}
            </CardContent>
          </Card>

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
                        readOnly
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
                        readOnly
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
                            <div className="prose prose-sm dark:prose-invert max-w-none text-xs text-muted-foreground">
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
                    <div key={q.id} id={questionAnchorId(q.id)} className="border rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-medium">Agent: {q.agent}</p>
                        <DiscussButton
                          entityType="question"
                          entityId={q.id}
                          entityTitle={q.questions[0]?.text || `${q.agent} agent question`}
                        />
                      </div>
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
                      {(q.answeredByName || q.answeredAt) && (
                        <p className="text-[10px] text-muted-foreground border-t pt-2 mt-2">
                          Answered
                          {q.answeredByName ? ` by ${q.answeredByName}` : ''}
                          {q.answeredAt ? ` · ${new Date(q.answeredAt).toLocaleString()}` : ''}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
