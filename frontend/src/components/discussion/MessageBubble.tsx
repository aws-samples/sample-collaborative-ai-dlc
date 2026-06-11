import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { generateColor } from '@/utils/colors';
import { relativeTime } from '@/lib/discussion';
import type { MessageGroup } from '@/lib/discussion';
import { Bot } from 'lucide-react';

// MessageBubble (plan §9): one author block (grouped consecutive messages),
// hash-colored avatar, relative timestamps, markdown via react-markdown +
// remark-gfm (no raw HTML — default-safe). Agent messages get distinct
// styling + a "requested by {name} · {command}" caption (assist audit
// visibility). Redacted: muted italic + audit caption.

export function MessageBubble({
  group,
  currentUserId,
}: {
  group: MessageGroup;
  currentUserId: string;
}) {
  const isAgent = group.authorType === 'agent';
  const isSelf = group.authorId === currentUserId;
  const color = generateColor(group.authorId || group.authorName);
  const first = group.messages[0];

  return (
    <div className="flex gap-2 px-3 py-1.5">
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
              <div
                key={m.id}
                className={cn(
                  'prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed break-words',
                  '[&_p]:my-0.5 [&_pre]:my-1 [&_ul]:my-1 [&_ol]:my-1',
                  isAgent && 'rounded-md bg-primary/5 px-2 py-1',
                )}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
