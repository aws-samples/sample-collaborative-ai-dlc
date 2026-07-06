import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, CheckCircle2, Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { discussionsService } from '@/services/discussions';
import type { Discussion, SearchResult } from '@/services/discussions';
import { useDiscussions } from './DiscussionProvider';

// ActivityPanel "Discussions" tab: all threads of the sprint with
// anchor badge, unread/total counts, resolved state + summary tooltip, and a
// filter bar (text → search endpoint, open/resolved). Clicking a row swaps
// the tab to the shared non-modal DiscussionPanel.

const ENTITY_LABELS: Record<string, string> = {
  sprint: 'Sprint',
  inception: 'Inception',
  question: 'Question',
  requirement: 'Req',
  userstory: 'Story',
  task: 'Task',
  review: 'Review',
  generalinfo: 'Info',
  // v2 intent-scoped anchors.
  intent: 'Intent',
  artifact: 'Artifact',
};

const EMPTY_DISCUSSIONS: Discussion[] = [];

const timeAgo = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
};

type StatusFilter = 'all' | 'open' | 'resolved';

export function DiscussionsTab() {
  const ctx = useDiscussions();
  const scope = ctx?.scope ?? null;
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Text search (≥3 chars, debounced) goes to the bounded search endpoint;
  // shorter queries fall back to the local list.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || !scope) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      discussionsService
        .search(scope, {
          q,
          status: statusFilter === 'all' ? undefined : statusFilter,
        })
        .then((r) => setSearchResults(r.results))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [query, statusFilter, scope]);

  const discussions = ctx?.discussions ?? EMPTY_DISCUSSIONS;
  const filtered = useMemo(
    () => discussions.filter((d) => statusFilter === 'all' || d.status === statusFilter),
    [discussions, statusFilter],
  );

  if (!ctx) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="p-2 space-y-1.5 border-b">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages… (min 3 chars)"
            className="h-7 pl-7 text-xs"
          />
          {searching && (
            <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex gap-1">
          {(['all', 'open', 'resolved'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={cn(
                'px-2 py-0.5 rounded text-[10px] capitalize border',
                statusFilter === s
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Search results */}
      {searchResults !== null ? (
        <div className="p-2 space-y-1">
          {searchResults.length === 0 && !searching && (
            <p className="text-center text-xs text-muted-foreground py-6">No matches.</p>
          )}
          {searchResults.map((r, i) => (
            <button
              key={`${r.discussion.id}-${r.message?.id ?? i}`}
              type="button"
              className="w-full text-left rounded-md border p-2 hover:bg-muted/50"
              onClick={() => ctx.openDiscussionById(r.discussion.id)}
            >
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">
                  {ENTITY_LABELS[r.discussion.entityType] || r.discussion.entityType}
                </Badge>
                <span className="text-xs font-medium truncate">
                  {r.discussion.entityTitle || 'Discussion'}
                </span>
              </div>
              {r.message && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 mt-1">
                  <span className="font-medium">{r.message.authorName}: </span>
                  {r.message.content}
                </p>
              )}
            </button>
          ))}
        </div>
      ) : (
        /* Thread list */
        <div className="p-2 space-y-1">
          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <MessageSquare className="h-5 w-5 text-muted-foreground mb-2" />
              <p className="text-xs text-muted-foreground">No discussions yet</p>
              <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                {scope?.kind === 'sprint'
                  ? 'v1 discussions are read-only.'
                  : 'Open one from any question, artifact or the sprint'}
              </p>
            </div>
          )}
          {filtered.map((d) => (
            <DiscussionRow key={d.id} d={d} onOpen={() => ctx.openDiscussionById(d.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DiscussionRow({ d, onOpen }: { d: Discussion; onOpen: () => void }) {
  const unread = d.unreadCount ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'w-full text-left rounded-md border p-2 hover:bg-muted/50',
        unread > 0 && 'border-primary/40',
      )}
    >
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">
          {ENTITY_LABELS[d.entityType] || d.entityType}
        </Badge>
        <span className={cn('text-xs truncate flex-1', unread > 0 && 'font-semibold')}>
          {d.entityTitle || 'Discussion'}
        </span>
        {d.status === 'resolved' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <CheckCircle2 className="h-3 w-3 text-agent-success shrink-0" />
            </TooltipTrigger>
            <TooltipContent className="max-w-60">
              {d.resolutionSummary || `Resolved by ${d.resolvedByName || 'a member'}`}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {unread > 0 && (
          <span className="min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-semibold flex items-center justify-center shrink-0">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
        <span>
          {d.messageCount ?? 0} message{(d.messageCount ?? 0) === 1 ? '' : 's'}
        </span>
        <span>·</span>
        <span>{timeAgo(d.lastMessageAt)}</span>
      </div>
    </button>
  );
}
