import { useCallback, useEffect, useState } from 'react';
import { useSprint } from '@/contexts/SprintContext';
import { useAgentStatus } from '@/hooks/useAgentStatus';
import { useConstructionStatus } from '@/hooks/useConstructionStatus';
import { useSprintEvents } from '@/hooks/useSprintEvents';
import { useQuestionAnchor } from '@/hooks/useQuestionAnchor';
import { questionAnchorId } from '@/lib/questionAnchor';
import { gitProviderTerminology } from '@/services/gitProvider';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { agentsService } from '@/services/agents';
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
import { AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import { ArtifactCard } from '@/components/domain/ArtifactCard';
import CodeFileViewer from '@/components/CodeFileViewer';
import { GitFileBrowser } from '@/components/GitFileBrowser';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Code2,
  ExternalLink,
  Eye,
  Folder,
  GitBranch,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { DiscussButton } from '@/components/discussion';

// v1 projects are read-only: the v1 execution engine has been retired, so this
// page keeps all display functionality (task board, streams of past runs, code
// files, PR banner) but no write affordances (no kick-offs, PR creation, task
// resets, settings, or answers).
export default function ConstructionPage() {
  const { sprint, tasks, codeFiles, questions, projectId, sprintId, reload } = useSprint();

  const { project } = useProjectCache(projectId ?? null);
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [executionArn, setExecutionArn] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);

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

  // Restore the last execution (read-only status/stream display)
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

  const allTasksDone =
    tasks.length > 0 && tasks.every((t) => t.status === 'done' || t.status === 'failed');

  const pendingQuestions = questions
    .filter((q) => !q.structuredAnswer)
    .toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Scroll to a question referenced by a #question-{id} URL hash (timeline links)
  useQuestionAnchor(questions.length > 0);

  const storedBranch = sprint?.branch || null;

  // Group tasks by status
  const tasksByStatus = {
    todo: tasks.filter((t) => t.status === 'todo'),
    in_progress: tasks.filter((t) => t.status === 'in_progress'),
    done: tasks.filter((t) => t.status === 'done'),
    failed: tasks.filter((t) => t.status === 'failed'),
  };

  const prTerm = gitProviderTerminology(project?.gitProvider ?? 'github');

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-6">
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

          <div className="rounded-lg border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
            This v1 space is read-only — agents can no longer be started and content can no longer
            be edited.
          </div>

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

          {/* PR banner */}
          {sprint?.prUrl && (
            <Card className="border-agent-success bg-agent-success/5">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-3">
                  <GitBranch className="h-5 w-5 text-agent-success" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{prTerm.changeRequest} Created</p>
                    <a
                      href={sprint.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-agent-success hover:underline"
                    >
                      {prTerm.changeRequestShort} #{sprint.prNumber} -- View on {prTerm.label}
                    </a>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => window.open(sprint.prUrl!, '_blank')}
                  >
                    <ExternalLink className="h-3 w-3" /> View {prTerm.changeRequestShort}
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

          {/* Read-only controls */}
          <div className="flex items-center gap-3 flex-wrap">
            {agentStatus.status?.status === 'RUNNING' && (
              <AgentStatusBadge status="running" agentType="construction" />
            )}

            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 ml-auto"
              onClick={() => setShowFileBrowser(true)}
            >
              <Eye className="h-3.5 w-3.5" /> View Repo Files
            </Button>
          </div>

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
                    <ArtifactCard
                      key={task.id}
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
                            .toSorted(([a], [b]) => a.localeCompare(b))
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
                                      .toSorted((a, b) => a.filePath.localeCompare(b.filePath))
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

      {/* Repository file browser */}
      {showFileBrowser && project && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-8">
          <Card className="w-full max-w-5xl max-h-[80vh] overflow-hidden">
            <CardHeader className="py-2 px-4 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Repository Files</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setShowFileBrowser(false)}>
                Close
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <GitFileBrowser provider={project.gitProvider} repoId={project.gitRepo} />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
