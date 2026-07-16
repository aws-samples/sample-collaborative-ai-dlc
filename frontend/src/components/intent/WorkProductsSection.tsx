import { useMemo } from 'react';
import type { IntentDetail, IntentGate } from '@/services/intents';
import { useIntent } from '@/contexts/IntentContext';
import { useIntentGraph } from '@/hooks/useIntentGraph';
import { buildCodeItems } from '@/components/intent/CodeSection';
import { ProvenanceTree } from '@/components/intent/ProvenanceTree';
import { HistorySection } from '@/components/intent/HistorySection';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Info } from 'lucide-react';

export interface WorkProductsSectionProps {
  detail: IntentDetail;
  gates: IntentGate[];
}

export function WorkProductsSection({ detail, gates }: WorkProductsSectionProps) {
  const { openArtifactPreview, openItemPreview, projectId, intentId, stageRows, phaseNameOf } =
    useIntent();
  const { getNeighbors, derivedItems, itemsByArtifact } = useIntentGraph(projectId, intentId);

  const questionGates = useMemo(() => gates.filter((g) => g.kind === 'question'), [gates]);
  const steering = detail.steering ?? [];

  const influencedArtifactsByQuestion = useMemo(
    () =>
      new Map(
        detail.events
          .filter((ev) => ev.type === 'v2.question.answered' && ev.humanTaskId)
          .map((ev) => [ev.humanTaskId as string, ev.artifacts ?? []]),
      ),
    [detail.events],
  );

  const codeItems = useMemo(() => buildCodeItems(detail), [detail]);

  if (
    detail.artifacts.length === 0 &&
    questionGates.length === 0 &&
    steering.length === 0 &&
    codeItems.length === 0
  ) {
    // Terminal runs with nothing to show render nothing; an in-flight run gets
    // a placeholder so the pane below the progress card doesn't look broken.
    if (!['CREATED', 'RUNNING', 'WAITING'].includes(detail.intent.status)) {
      return null;
    }
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Work products</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-4 text-center text-sm text-muted-foreground">
            No work products yet — documents, items and code will appear here as the run progresses.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Work products</CardTitle>
        {detail.intent.planWarnings &&
          detail.intent.planWarnings.length > 0 &&
          detail.intent.status !== 'SUCCEEDED' && (
            <details className="mt-2 rounded border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-sm">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-sky-700 dark:text-sky-300">
                <Info className="h-4 w-4 shrink-0" />
                Some stages are intentionally excluded from this scope ({detail.intent.scope}) and
                their artifacts won't be generated
              </summary>
              <ul className="mt-2 space-y-1 pl-6 text-[12px] text-muted-foreground">
                {detail.intent.planWarnings.map((w, i) => (
                  <li key={`${w.code}-${i}`} className="list-disc">
                    {w.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
      </CardHeader>
      <CardContent className="space-y-3">
        <ProvenanceTree
          detail={detail}
          stageRows={stageRows}
          phaseNameOf={phaseNameOf}
          getNeighbors={getNeighbors}
          itemsByArtifact={itemsByArtifact}
          derivedItems={derivedItems}
          codeItems={codeItems}
          openArtifactPreview={openArtifactPreview}
          openItemPreview={openItemPreview}
        />

        <HistorySection
          questionGates={questionGates}
          steering={steering}
          influencedArtifactsByQuestion={influencedArtifactsByQuestion}
        />
      </CardContent>
    </Card>
  );
}
