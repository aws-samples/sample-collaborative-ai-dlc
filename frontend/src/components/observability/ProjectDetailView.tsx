import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  FolderGit2,
  GitBranch,
  ExternalLink,
  Bot,
  Loader2,
  CheckCircle2,
  XCircle,
  MessageCircleQuestion,
  ChevronRight,
  Clock,
  Send,
  GitPullRequest,
  ArrowLeft,
} from 'lucide-react';
import { AgentStreamPanel } from '@/components/AgentStreamPanel';
import { useAgentStatus } from '@/hooks/useAgentStatus';
import { agentsService } from '@/services/agents';
import { type Sprint } from '@/services/sprints';
import type { ProjectAgentInfo, VelocityMetrics } from '@/hooks/useObservability';

interface ProjectDetailViewProps {
  info: ProjectAgentInfo;
  allSprints: Sprint[];
  pendingQuestions: number;
  velocity?: VelocityMetrics;
  onNavigate: (path: string) => void;
  onBack?: () => void;
}

const STATUS_ICON: Record<string, typeof Loader2> = {
  running: Loader2,
  waiting: MessageCircleQuestion,
  completed: CheckCircle2,
  failed: XCircle,
};

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  waiting: 'Waiting for input',
  completed: 'Completed',
  failed: 'Failed',
};

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function ProjectDetailView({
  info,
  allSprints,
  pendingQuestions,
  velocity,
  onNavigate,
  onBack,
}: ProjectDetailViewProps) {
  const { project, sprint, progress, taskStatuses } = info;
  const agentStatus = sprint?.currentAgentStatus;
  const navigate = useNavigate();

  const [instructions, setInstructions] = useState('');
  const [sending, setSending] = useState(false);

  const agentStream = useAgentStatus({
    executionArn: sprint?.currentExecutionArn ?? null,
    executionId: sprint?.currentExecutionId ?? null,
    projectId: project.id,
    sprintId: sprint?.id,
    sprintAgentStatus: agentStatus,
  });

  const handleSendInstruction = async () => {
    if (!instructions.trim()) return;
    setSending(true);
    try {
      await agentsService.startWorkflow(project.id, {
        phase: 'bugfix',
        sprintId: sprint?.id,
        description: instructions.trim(),
      });
      setInstructions('');
    } catch (err) {
      console.error('Failed to start agent:', err);
    } finally {
      setSending(false);
    }
  };

  const isAgentActive = agentStatus === 'running' || agentStatus === 'waiting';
  const activeSprints = allSprints.filter(
    (s) => s.currentAgentStatus === 'running' || s.currentAgentStatus === 'waiting',
  );
  const pastSprints = allSprints.filter(
    (s) => s.currentAgentStatus !== 'running' && s.currentAgentStatus !== 'waiting',
  );

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <FolderGit2 className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-bold tracking-tight">{project.name}</h1>
          {sprint && (
            <Badge variant="outline" className="text-[10px]">
              {sprint.phase}
            </Badge>
          )}
          {isAgentActive && (
            <Badge
              variant="outline"
              className="gap-1 text-[10px] bg-agent-running/10 text-agent-running border-agent-running/30"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse" />
              Live
            </Badge>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 h-7"
          onClick={() => navigate(`/project/${project.id}`)}
        >
          <ExternalLink className="h-3 w-3" />
          Open project
        </Button>
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <GitBranch className="h-3 w-3" />
              Repository
            </div>
            <p className="text-sm font-medium truncate">{project.gitRepo || 'Not configured'}</p>
            {sprint?.branch && (
              <p className="text-[11px] text-muted-foreground mt-1 truncate">
                Branch: {sprint.branch}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Bot className="h-3 w-3" />
              Agent
            </div>
            <div className="flex items-center gap-2">
              {agentStatus &&
                STATUS_ICON[agentStatus] &&
                (() => {
                  const Icon = STATUS_ICON[agentStatus];
                  return (
                    <Icon
                      className={cn(
                        'h-3.5 w-3.5',
                        agentStatus === 'running' && 'animate-spin text-agent-running',
                        agentStatus === 'waiting' && 'text-agent-waiting',
                        agentStatus === 'completed' && 'text-agent-success',
                        agentStatus === 'failed' && 'text-agent-error',
                      )}
                    />
                  );
                })()}
              <p className="text-sm font-medium">
                {agentStatus ? STATUS_LABEL[agentStatus] : 'Idle'}
              </p>
            </div>
            {sprint?.currentAgentType && (
              <p className="text-[11px] text-muted-foreground mt-1 capitalize">
                {sprint.currentAgentType.replace(/[_-]/g, ' ')}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Clock className="h-3 w-3" />
              Progress
            </div>
            {progress ? (
              <>
                <p className="text-sm font-medium">
                  {progress.taskDoneCount}/{progress.taskCount} tasks
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {progress.codeFileCount} files · {progress.requirementCount} reqs
                  {velocity && ` · ${velocity.tasksPerHour} tasks/hr`}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No sprint data</p>
            )}
          </CardContent>
        </Card>
      </div>

      {sprint?.prUrl && (
        <Card className="border-green-500/20 bg-green-500/[0.03]">
          <CardContent className="px-4 py-3 flex items-center gap-3">
            <GitPullRequest className="h-4 w-4 text-green-600 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Pull Request #{sprint.prNumber}</p>
            </div>
            <a
              href={sprint.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-green-700 hover:underline flex items-center gap-1"
            >
              View PR <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Agent Workspace
          </h3>
          <Card>
            <CardContent className="p-0">
              <div className="border-b px-4 py-3">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">Chat with Worker</span>
                  {isAgentActive && (
                    <span className="text-[10px] text-agent-running font-medium ml-auto">
                      Connected
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Send instructions to an available worker for quick fixes or information
                </p>
              </div>

              {(isAgentActive || agentStream.streamingText || agentStream.completedOutput) && (
                <AgentStreamPanel
                  streamingText={agentStream.completedOutput || agentStream.streamingText}
                  activeToolCall={agentStream.activeToolCall}
                  toolCalls={agentStream.toolCalls}
                  compact={false}
                  isStreaming={agentStatus === 'running'}
                  maxHeight="400px"
                />
              )}

              <div className="p-3 border-t">
                <div className="flex gap-2">
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="Ask the agent to fix a bug, investigate an issue, or make a quick change..."
                    className="flex-1 px-3 py-2 text-sm border rounded-md bg-background resize-none h-[72px] focus:outline-none focus:ring-2 focus:ring-ring"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        handleSendInstruction();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-[72px] px-3"
                    disabled={!instructions.trim() || sending || !project.gitRepo}
                    onClick={handleSendInstruction}
                  >
                    {sending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  ⌘+Enter to send · Project context auto-attached
                </p>
              </div>
            </CardContent>
          </Card>

          {pendingQuestions > 0 && (
            <Card className="border-agent-waiting/30 bg-agent-waiting/[0.04]">
              <CardContent className="px-4 py-3 flex items-center gap-3">
                <MessageCircleQuestion className="h-4 w-4 text-agent-waiting shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-agent-waiting">
                    {pendingQuestions} question{pendingQuestions > 1 ? 's' : ''} waiting
                  </p>
                  <p className="text-[11px] text-muted-foreground">Agent needs input to continue</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 h-7 text-xs"
                  onClick={() => {
                    if (sprint) onNavigate(`/project/${project.id}/sprint/${sprint.id}/agent`);
                  }}
                >
                  Answer
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Iterations
          </h3>

          {activeSprints.length > 0 && (
            <div className="space-y-2">
              {activeSprints.map((s) => (
                <SprintRow
                  key={s.id}
                  sprint={s}
                  projectId={project.id}
                  active
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          )}

          {pastSprints.length > 0 && (
            <Collapsible defaultOpen={pastSprints.length <= 5}>
              <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group w-full">
                <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                <span>Past iterations ({pastSprints.length})</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-1 mt-2">
                  {pastSprints.map((s) => (
                    <SprintRow
                      key={s.id}
                      sprint={s}
                      projectId={project.id}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {allSprints.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground">No iterations yet</p>
              </CardContent>
            </Card>
          )}

          {taskStatuses.length > 0 && (
            <>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground pt-2">
                Current Tasks
              </h3>
              <div className="space-y-1">
                {taskStatuses.map((t) => {
                  const s = t.executionStatus;
                  return (
                    <div
                      key={t.taskId}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-3 py-2',
                        s === 'RUNNING' && 'bg-agent-running/5 border-agent-running/20',
                        s === 'SUCCEEDED' && 'bg-agent-success/5 border-agent-success/20',
                        s === 'FAILED' && 'bg-agent-error/5 border-agent-error/20',
                        !s && 'border-border',
                      )}
                    >
                      {s === 'RUNNING' && (
                        <Loader2 className="h-3 w-3 text-agent-running animate-spin shrink-0" />
                      )}
                      {s === 'SUCCEEDED' && (
                        <CheckCircle2 className="h-3 w-3 text-agent-success shrink-0" />
                      )}
                      {s === 'FAILED' && <XCircle className="h-3 w-3 text-agent-error shrink-0" />}
                      {!s && (
                        <div className="h-3 w-3 rounded-full border-2 border-muted-foreground/30 shrink-0" />
                      )}
                      <span className="text-xs font-medium truncate">{t.title}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SprintRow({
  sprint,
  projectId,
  active,
  onNavigate,
}: {
  sprint: Sprint;
  projectId: string;
  active?: boolean;
  onNavigate: (path: string) => void;
}) {
  const status = sprint.currentAgentStatus;
  const phaseRoute =
    sprint.phase === 'CONSTRUCTION' ? '/construction' : sprint.phase === 'REVIEW' ? '/review' : '';

  return (
    <button
      onClick={() => onNavigate(`/project/${projectId}/sprint/${sprint.id}${phaseRoute}`)}
      className={cn(
        'flex items-center gap-3 rounded-lg border px-3 py-2.5 w-full text-left transition-colors hover:bg-accent/50',
        active && status === 'running' && 'border-agent-running/25 bg-agent-running/[0.03]',
        active && status === 'waiting' && 'border-agent-waiting/25 bg-agent-waiting/[0.03]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{sprint.name}</p>
          <Badge variant="outline" className="text-[9px] h-4 shrink-0">
            {sprint.phase}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {formatRelativeTime(sprint.createdAt)}
          {sprint.prUrl && ' · PR open'}
        </p>
      </div>
      {status &&
        STATUS_ICON[status] &&
        (() => {
          const Icon = STATUS_ICON[status];
          return (
            <Icon
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                status === 'running' && 'animate-spin text-agent-running',
                status === 'waiting' && 'text-agent-waiting',
                status === 'completed' && 'text-agent-success',
                status === 'failed' && 'text-agent-error',
              )}
            />
          );
        })()}
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
    </button>
  );
}
