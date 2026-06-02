import { Loader2, MoreVertical, RotateCcw, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Task } from '@/services/tasks';

interface TaskActionsMenuProps {
  task: Task;
  isResetting: boolean;
  onOpenSettings: (task: Task) => void;
  onReset: (taskId: string, taskTitle: string) => void;
  variant?: 'compact' | 'default';
  disableReset?: boolean;
}

export function TaskActionsMenu({
  task,
  isResetting,
  onOpenSettings,
  onReset,
  variant = 'default',
  disableReset = false,
}: TaskActionsMenuProps) {
  if (isResetting) {
    return (
      <Loader2
        className={
          variant === 'compact'
            ? 'h-3 w-3 animate-spin shrink-0 mt-1'
            : 'h-3.5 w-3.5 animate-spin shrink-0 mt-2'
        }
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant === 'compact' ? 'ghost' : 'outline'}
          size="sm"
          className={
            variant === 'compact' ? 'h-6 w-6 p-0 shrink-0' : 'shrink-0 gap-1 mt-1 h-7 px-2'
          }
          title="Task actions"
        >
          <MoreVertical className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => onOpenSettings(task)}>
          <Settings className="mr-2 h-3.5 w-3.5" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disableReset} onClick={() => onReset(task.id, task.title)}>
          <RotateCcw className="mr-2 h-3.5 w-3.5" />
          Reset to To Do
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
