import { useEffect, useState } from 'react';
import { tasksService } from '../../services/tasks';
import type { SteeringDoc } from '../../services/projects';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { McpServersSection } from './McpServersSection';
import { SteeringDocsSection } from './SteeringDocsSection';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sprintId: string;
  taskId: string;
  taskTitle: string;
  // Settings are read-only once the task has left the todo state.
  canEdit: boolean;
}

export function TaskSettingsDialog({
  open,
  onOpenChange,
  sprintId,
  taskId,
  taskTitle,
  canEdit,
}: Props) {
  const [mcpServers, setMcpServers] = useState('[]');
  const [steeringDocs, setSteeringDocs] = useState<SteeringDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const clearMessages = () => {
    setSuccess('');
    setError('');
  };

  // Reload on open so we always show the latest server-side values
  // (including refreshed download URLs after an upload).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    clearMessages();
    Promise.all([
      tasksService.getMcpServers(sprintId, taskId).catch(() => ({ mcpServers: '[]' })),
      tasksService.getSteeringDocs(sprintId, taskId).catch(() => ({ steeringDocs: [] })),
    ])
      .then(([mcp, docs]) => {
        if (cancelled) return;
        setMcpServers(mcp.mcpServers ?? '[]');
        setSteeringDocs(docs.steeringDocs ?? []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sprintId, taskId]);

  const handleSaveMcp = async (value: string) => {
    clearMessages();
    await tasksService.updateMcpServers(sprintId, taskId, value);
    setSuccess('MCP servers saved');
  };

  const handleSaveSteeringMetadata = async (docs: Array<{ filename: string }>) => {
    return tasksService.updateSteeringDocs(sprintId, taskId, docs);
  };

  const refreshSteering = async () => {
    const refreshed = await tasksService.getSteeringDocs(sprintId, taskId);
    setSteeringDocs(refreshed.steeringDocs ?? []);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Task Settings</DialogTitle>
          <DialogDescription className="text-xs">
            <span className="font-medium text-foreground">{taskTitle}</span>
            {!canEdit && (
              <span className="ml-2 text-muted-foreground">
                — read-only (task has already started)
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {(success || error) && (
          <div className="space-y-2">
            {success && (
              <div className="flex items-start gap-2 text-xs text-green-600 dark:text-green-400 bg-green-500/10 border border-green-500/20 rounded-md px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{success}</span>
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {loading ? (
          <p className="text-xs text-muted-foreground py-6 text-center">Loading task settings…</p>
        ) : (
          <div className="space-y-4">
            <McpServersSection
              value={mcpServers}
              onChange={setMcpServers}
              onSave={handleSaveMcp}
              canEdit={canEdit}
              description="JSON array of MCP server definitions injected into this task's agent session. Merged with the project-level and global MCP servers; when names collide, task-level entries take precedence."
            />
            <SteeringDocsSection
              docs={steeringDocs}
              onSaveMetadata={handleSaveSteeringMetadata}
              onRefresh={refreshSteering}
              canEdit={canEdit}
              description="Markdown documents loaded into this task's agent context, in addition to project-level steering rules."
              onSuccess={setSuccess}
              onError={setError}
              onClearMessages={clearMessages}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
