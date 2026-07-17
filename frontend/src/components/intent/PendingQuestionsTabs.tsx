import { useEffect, useState } from 'react';
import { FileQuestion, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { IntentGate } from '@/services/intents';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const MAX_VISIBLE_TABS = 5;

export function gateTabLabel(gate: IntentGate): string {
  if (gate.prompt) return gate.prompt;
  if (gate.kind === 'question' && gate.questions) {
    try {
      const parsed: { text?: string }[] = JSON.parse(gate.questions);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].text) {
        return parsed[0].text;
      }
    } catch (parseError) {
      void parseError;
    }
  }
  if (gate.kind === 'validation') return 'Review required';
  return 'Approval required';
}

interface PendingQuestionsTabsProps {
  gates: IntentGate[];
  activeGateId: string | null;
  renderGateCard: (gate: IntentGate) => React.ReactNode;
  /** Short scan context per tab (stage name, unit lane) — null hides the prefix. */
  gateContext?: (gate: IntentGate) => string | null;
}

const OVERFLOW_TRIGGER_ID = 'gate-tabs-overflow-trigger';

export function PendingQuestionsTabs({
  gates,
  activeGateId,
  renderGateCard,
  gateContext,
}: PendingQuestionsTabsProps) {
  const [selectedId, setSelectedId] = useState<string>(
    () => activeGateId ?? gates[0]?.humanTaskId ?? '',
  );

  // Stable string signature for gate-set identity (avoids object/Set deps).
  // NUL delimiter — cannot appear in task ids, so splits are always exact.
  const gateIdSig = gates.map((g) => g.humanTaskId).join('\u0000');

  useEffect(() => {
    setSelectedId((current) => {
      const ids = gateIdSig.split('\u0000');
      if (ids.includes(current)) return current;
      if (activeGateId && ids.includes(activeGateId)) return activeGateId;
      return ids[0] ?? '';
    });
  }, [activeGateId, gateIdSig]);

  const selectedGate = gates.find((g) => g.humanTaskId === selectedId) ?? gates[0] ?? null;

  if (!selectedGate) return null;

  if (gates.length === 1) {
    return (
      <div role="region" aria-label="Pending questions" className="space-y-2">
        <div className="flex items-center gap-2">
          <FileQuestion className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">Questions for you</span>
          <Badge variant="secondary" className="h-4 px-1 text-[9px]">
            1
          </Badge>
        </div>
        {renderGateCard(selectedGate)}
      </div>
    );
  }

  const needsOverflow = gates.length > MAX_VISIBLE_TABS;
  const visibleGates = needsOverflow ? computeVisibleTabs(gates, selectedId) : gates;
  const overflowGates = needsOverflow ? gates.filter((g) => !visibleGates.includes(g)) : [];

  return (
    <div role="region" aria-label="Pending questions" className="space-y-2">
      <div className="flex items-center gap-2">
        <FileQuestion className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Questions for you</span>
        <Badge variant="secondary" className="h-4 px-1 text-[9px]">
          {gates.length}
        </Badge>
      </div>

      <div
        role="tablist"
        aria-label="Pending questions"
        className="flex items-center gap-1 overflow-x-auto scrollbar-none"
      >
        {visibleGates.map((gate) => {
          const isSelected = gate.humanTaskId === selectedId;
          const context = gateContext?.(gate) ?? null;
          return (
            <button
              key={gate.humanTaskId}
              type="button"
              role="tab"
              id={`gate-tab-${gate.humanTaskId}`}
              aria-selected={isSelected}
              aria-controls={`gate-tabpanel-${gate.humanTaskId}`}
              tabIndex={isSelected ? 0 : -1}
              className={cn(
                'flex shrink-0 max-w-[220px] items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isSelected
                  ? 'bg-background text-foreground shadow-sm border'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
              onClick={() => setSelectedId(gate.humanTaskId)}
              onKeyDown={(e) =>
                handleTabKeyboard(e, visibleGates, selectedId, setSelectedId, needsOverflow)
              }
            >
              {context && (
                <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                  {context}
                </span>
              )}
              <span className="truncate">{gateTabLabel(gate)}</span>
            </button>
          );
        })}

        {overflowGates.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                id={OVERFLOW_TRIGGER_ID}
                className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
                aria-label={`${overflowGates.length} more questions`}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const last = visibleGates[visibleGates.length - 1];
                    if (last) document.getElementById(`gate-tab-${last.humanTaskId}`)?.focus();
                  }
                }}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />+{overflowGates.length}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-60 overflow-y-auto">
              {overflowGates.map((gate) => {
                const context = gateContext?.(gate) ?? null;
                return (
                  <DropdownMenuItem
                    key={gate.humanTaskId}
                    onClick={() => setSelectedId(gate.humanTaskId)}
                    className="max-w-[280px] gap-1.5 text-xs"
                  >
                    {context && (
                      <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                        {context}
                      </span>
                    )}
                    <span className="truncate">{gateTabLabel(gate)}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div
        role="tabpanel"
        id={`gate-tabpanel-${selectedId}`}
        aria-labelledby={`gate-tab-${selectedId}`}
        data-testid={`gate-panel-${selectedId}`}
      >
        {renderGateCard(selectedGate)}
      </div>
    </div>
  );
}

function computeVisibleTabs(gates: IntentGate[], selectedId: string): IntentGate[] {
  const selectedIdx = gates.findIndex((g) => g.humanTaskId === selectedId);
  if (selectedIdx < 0 || selectedIdx < MAX_VISIBLE_TABS) {
    return gates.slice(0, MAX_VISIBLE_TABS);
  }
  const visible = gates.slice(0, MAX_VISIBLE_TABS - 1);
  visible.push(gates[selectedIdx]);
  return visible;
}

function handleTabKeyboard(
  e: React.KeyboardEvent,
  visibleGates: IntentGate[],
  selectedId: string,
  setSelectedId: (id: string) => void,
  hasOverflow: boolean,
) {
  const currentIdx = visibleGates.findIndex((g) => g.humanTaskId === selectedId);
  if (currentIdx < 0) return;
  let nextIdx: number | null = null;

  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    // Past the last tab, hand focus to the overflow trigger (WCAG 2.1.1 —
    // overflow questions must be keyboard-reachable from the strip).
    if (hasOverflow && currentIdx === visibleGates.length - 1) {
      e.preventDefault();
      document.getElementById(OVERFLOW_TRIGGER_ID)?.focus();
      return;
    }
    nextIdx = (currentIdx + 1) % visibleGates.length;
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    nextIdx = (currentIdx - 1 + visibleGates.length) % visibleGates.length;
  } else if (e.key === 'Home') {
    nextIdx = 0;
  } else if (e.key === 'End') {
    nextIdx = visibleGates.length - 1;
  }

  if (nextIdx !== null) {
    e.preventDefault();
    setSelectedId(visibleGates[nextIdx].humanTaskId);
    const tabEl = document.getElementById(`gate-tab-${visibleGates[nextIdx].humanTaskId}`);
    tabEl?.focus();
  }
}
