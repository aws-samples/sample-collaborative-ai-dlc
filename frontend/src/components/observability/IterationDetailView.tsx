import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowLeft, Bot, ExternalLink } from 'lucide-react';
import { AgentStreamPanel } from '@/components/AgentStreamPanel';
import { useAgentStatus } from '@/hooks/useAgentStatus';
import { effectiveSprintStatus } from '@/lib/sprintStatus';
import { ProjectDiagram } from './ProjectDiagram';
import type { ProjectAgentInfo, VelocityMetrics } from '@/hooks/useObservability';

interface IterationDetailViewProps {
  info: ProjectAgentInfo;
  pendingQuestions: number;
  velocity?: VelocityMetrics;
  onNavigate: (path: string) => void;
  onBack: () => void;
}

export function IterationDetailView({
  info,
  pendingQuestions,
  velocity,
  onNavigate,
  onBack,
}: IterationDetailViewProps) {
  const { project, sprint, progress } = info;
  const agentStatus = effectiveSprintStatus(sprint);
  const isAgentActive = agentStatus === 'running' || agentStatus === 'waiting';

  const agentStream = useAgentStatus({
    executionArn: sprint?.currentExecutionArn ?? null,
    executionId: sprint?.currentExecutionId ?? null,
    projectId: project.id,
    sprintId: sprint?.id,
    sprintAgentStatus: sprint?.currentAgentStatus,
  });

  const workbenchPath = sprint
    ? `/space/${project.id}/sprint/${sprint.id}${sprint.phase === 'CONSTRUCTION' ? '/construction' : sprint.phase === 'REVIEW' ? '/review' : ''}`
    : `/space/${project.id}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-lg font-bold tracking-tight">{sprint?.name ?? project.name}</h1>
          {sprint?.phase && (
            <Badge variant="outline" className="text-[10px] h-5 bg-muted/40">
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
          onClick={() => onNavigate(workbenchPath)}
        >
          <ExternalLink className="h-3 w-3" />
          Open in workbench
        </Button>
      </div>

      <ProjectDiagram
        info={info}
        pendingQuestions={pendingQuestions}
        velocity={velocity}
        onNavigate={onNavigate}
      />

      <div className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
          <Bot className="h-3.5 w-3.5" />
          Live Activity
        </h3>
        <Card>
          <CardContent className="p-0">
            <div className="border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">Agent activity</span>
                {isAgentActive && (
                  <span className="text-[10px] text-agent-running font-medium ml-auto">
                    Connected
                  </span>
                )}
              </div>
            </div>

            {isAgentActive || agentStream.streamingText || agentStream.completedOutput ? (
              <AgentStreamPanel
                streamingText={agentStream.completedOutput || agentStream.streamingText}
                activeToolCall={agentStream.activeToolCall}
                toolCalls={agentStream.toolCalls}
                compact={false}
                isStreaming={agentStatus === 'running'}
                maxHeight="400px"
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-10 px-4">
                <Bot className="h-6 w-6 text-muted-foreground/30 mb-2" />
                <p className="text-xs text-muted-foreground">No agent activity right now</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {progress && progress.taskCount > 0 && (
        <div className="flex items-center gap-4 text-sm text-muted-foreground border rounded-lg px-4 py-3">
          <span className="font-medium text-foreground">
            {progress.taskDoneCount}/{progress.taskCount} tasks
          </span>
          {progress.codeFileCount > 0 && <span>{progress.codeFileCount} files</span>}
          {progress.requirementCount > 0 && <span>{progress.requirementCount} requirements</span>}
        </div>
      )}
    </div>
  );
}
