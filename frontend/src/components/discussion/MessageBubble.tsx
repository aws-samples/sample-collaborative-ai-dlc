import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { generateColor } from '@/utils/colors';
import { relativeTime } from '@/lib/discussion';
import type { MessageGroup } from '@/lib/discussion';
import { AlertCircle, Bot, Loader2, MoreHorizontal, RotateCcw, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// MessageBubble: one author block (grouped consecutive messages),
// hash-colored avatar, relative timestamps, markdown via react-markdown +
// remark-gfm (no raw HTML — default-safe). Agent messages get distinct
// styling + a "requested by {name} · {command}" caption (assist audit
// visibility). Redacted: muted italic + audit caption. The redact action is
// admin/owner only (role gate in the sheet; the server enforces it anyway).

interface Props {
  group: MessageGroup;
  currentUserId: string;
  canRedact?: boolean;
  onRedact?: (messageId: string) => void;
  onAssistRetry?: (messageId: string) => void;
}

export function MessageBubble({ group, currentUserId, canRedact, onRedact, onAssistRetry }: Props) {
  const isAgent = group.authorType === 'agent';
  const isSelf = group.authorId === currentUserId;
  const color = generateColor(group.authorId || group.authorName);
  const first = group.messages[0];

  return (
    <div className="flex gap-2 px-3 py-1.5 group/bubble">
      <div className="pt-0.5 shrink-0">
        {isAgent ? (
          <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center">
            <Bot className="h-3.5 w-3.5 text-primary" />
          </div>
        ) : (
          <div
            className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
            style={{ backgroundColor: color }}
            title={group.authorName}
          >
            {(group.authorName || '?').slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('text-xs font-medium truncate', isSelf && 'text-primary')}>
            {group.authorName}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {relativeTime(first.createdAt)}
          </span>
        </div>
        {isAgent && (first.requestedByName || first.command) && (
          <p className="text-[10px] text-muted-foreground">
            requested by {first.requestedByName || 'unknown'}
            {first.command ? ` · ${first.command}` : ''}
          </p>
        )}
        <div className="space-y-1">
          {group.messages.map((m) =>
            m.redacted ? (
              <div key={m.id} className="text-xs italic text-muted-foreground">
                {m.content}
                {m.redactedAt && (
                  <span className="not-italic text-[10px]"> · {relativeTime(m.redactedAt)}</span>
                )}
              </div>
            ) : (
              <div key={m.id} className="flex items-start gap-1">
                <div
                  className={cn(
                    'prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed break-words flex-1 min-w-0',
                    '[&_p]:my-0.5 [&_pre]:my-1 [&_ul]:my-1 [&_ol]:my-1',
                    // Narrow-panel guards: code blocks scroll instead of
                    // clipping, wide GFM tables scroll inside the bubble.
                    'max-w-full [&_pre]:max-w-full [&_pre]:overflow-x-auto',
                    '[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto',
                    isAgent && 'rounded-md bg-primary/5 px-2 py-1',
                  )}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  {isAgent && m.assistStatus === 'running' && (
                    <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      running
                    </p>
                  )}
                  {isAgent && m.assistStatus === 'failed' && m.requestId && onAssistRetry && (
                    <button
                      type="button"
                      className="mt-1 inline-flex items-center gap-1 text-[10px] text-destructive hover:underline"
                      onClick={() => onAssistRetry(m.id)}
                    >
                      <AlertCircle className="h-2.5 w-2.5" />
                      failed - retry
                      <RotateCcw className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
                {canRedact && onRedact && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 shrink-0 opacity-0 group-hover/bubble:opacity-100"
                        aria-label="Message actions"
                      >
                        <MoreHorizontal className="h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="text-xs text-destructive focus:text-destructive"
                        onClick={() => onRedact(m.id)}
                      >
                        <ShieldOff className="h-3 w-3 mr-1.5" />
                        Redact message
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
