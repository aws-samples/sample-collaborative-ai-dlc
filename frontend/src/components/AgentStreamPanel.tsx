import { useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ToolCallEvent } from '../hooks/useAgentStatus';

interface Props {
  streamingText: string;
  activeToolCall: string | null;
  toolCalls: ToolCallEvent[];
  /** Max height in CSS (default: "20rem" / max-h-80) */
  maxHeight?: string;
  /** Compact mode for sidebars — hides tool history, smaller text */
  compact?: boolean;
  /** Whether agent is currently streaming */
  isStreaming?: boolean;
}

/**
 * Safely truncate markdown text by finding a safe boundary (end of a line
 * that is not inside a code block). Returns the text from that boundary onward.
 * This prevents broken markdown rendering from cutting mid-structure.
 */
function safeTruncateMarkdown(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Start from the target position
  const startPos = text.length - maxChars;

  // Find the next double-newline (paragraph break) after startPos
  // This ensures we don't cut in the middle of a paragraph, list, or code block
  let safeStart = text.indexOf('\n\n', startPos);
  if (safeStart === -1 || safeStart > startPos + 500) {
    // Fallback: find the next single newline
    safeStart = text.indexOf('\n', startPos);
  }
  if (safeStart === -1 || safeStart > startPos + 500) {
    // Last resort: just use startPos
    safeStart = startPos;
  }

  const truncated = text.slice(safeStart).trimStart();

  // Check if we're inside an unclosed code fence (odd number of ``` before our start)
  const beforeTruncation = text.slice(0, safeStart);
  const fenceMatches = beforeTruncation.match(/^```/gm);
  const fenceCount = fenceMatches ? fenceMatches.length : 0;
  if (fenceCount % 2 !== 0) {
    // We're inside a code block -- find the end of it and start after
    const endFence = truncated.indexOf('\n```');
    if (endFence !== -1) {
      return truncated.slice(endFence + 4).trimStart();
    }
  }

  return truncated;
}

export function AgentStreamPanel({
  streamingText,
  activeToolCall,
  toolCalls,
  compact = false,
  isStreaming = true,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only auto-scroll if user is near the bottom (within 80px)
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [streamingText, toolCalls.length]);

  const hasContent = streamingText || toolCalls.length > 0;

  // Show the last N tool calls in the timeline (recent first for display)
  const recentTools = compact ? toolCalls.slice(-3) : toolCalls.slice(-10);

  // For streaming, use safe truncation to keep rendering fast without breaking markdown.
  // For completed output, render the full text.
  const displayText = useMemo(() => {
    if (!streamingText) return '';
    if (!isStreaming) return streamingText; // Show full text when done
    const limit = compact ? 3000 : 8000;
    return safeTruncateMarkdown(streamingText, limit);
  }, [streamingText, isStreaming, compact]);

  return (
    <div
      ref={scrollRef}
      className="bg-gray-900 rounded-lg overflow-y-auto"
    >
      {/* Activity indicator when nothing else is showing */}
      {!hasContent && (
        <div className="p-4 flex items-center gap-3 text-gray-400 text-sm">
          <div className="animate-spin h-4 w-4 border-2 border-gray-500 border-t-gray-300 rounded-full flex-shrink-0" />
          <span>Agent is starting up...</span>
        </div>
      )}

      {/* Tool call timeline */}
      {recentTools.length > 0 && (
        <div className={`border-b border-gray-800 ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
          <div className="space-y-1.5">
            {recentTools.map((tool) => (
              <ToolCallRow key={tool.id} tool={tool} compact={compact} />
            ))}
          </div>
          {!compact && toolCalls.length > 10 && (
            <p className="text-gray-600 text-xs mt-1">
              + {toolCalls.length - 10} earlier tool calls
            </p>
          )}
        </div>
      )}

      {/* Active tool call highlight (always visible if active, even without text) */}
      {activeToolCall && !recentTools.some(t => t.name === activeToolCall && t.status === 'pending') && (
        <div className="px-4 py-2 border-b border-gray-800">
          <div className="text-yellow-400 text-xs flex items-center gap-2">
            <div className="animate-spin h-3 w-3 border border-yellow-400 border-t-transparent rounded-full flex-shrink-0" />
            <span className="truncate">{activeToolCall}</span>
          </div>
        </div>
      )}

      {/* Streaming markdown text */}
      {displayText && (
        <div className={compact ? 'p-3' : 'p-4'}>
          <div className={`prose prose-invert max-w-none ${compact ? 'prose-xs' : 'prose-sm'}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {displayText}
            </ReactMarkdown>
            {isStreaming && (
              <span className="inline-block w-1.5 h-3.5 bg-gray-400 animate-pulse ml-0.5 align-middle" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ tool, compact }: { tool: ToolCallEvent; compact: boolean }) {
  const elapsed = tool.completedAt
    ? formatDuration(tool.completedAt - tool.startedAt)
    : formatDuration(Date.now() - tool.startedAt);

  return (
    <div className="flex items-center gap-2 text-xs">
      <ToolStatusIcon status={tool.status} />
      <span className={`truncate ${
        tool.status === 'pending' ? 'text-yellow-400' :
        tool.status === 'running' ? 'text-blue-400' :
        tool.status === 'completed' ? 'text-gray-500' :
        'text-red-400'
      }`}>
        {tool.name}
      </span>
      {!compact && (
        <span className="text-gray-600 ml-auto flex-shrink-0">{elapsed}</span>
      )}
    </div>
  );
}

function ToolStatusIcon({ status }: { status: ToolCallEvent['status'] }) {
  if (status === 'pending' || status === 'running') {
    return (
      <div className="animate-spin h-3 w-3 border border-yellow-400 border-t-transparent rounded-full flex-shrink-0" />
    );
  }
  if (status === 'completed') {
    return (
      <svg className="w-3 h-3 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  // failed
  return (
    <svg className="w-3 h-3 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
