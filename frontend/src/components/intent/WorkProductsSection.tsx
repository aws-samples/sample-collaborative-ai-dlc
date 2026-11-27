import { useMemo, useState } from 'react';
import type { IntentDetail, IntentGate } from '@/services/intents';
import { useIntent } from '@/contexts/IntentContext';
import { useIntentGraph } from '@/hooks/useIntentGraph';
import { buildCodeItems, buildUnitBranchItems } from '@/components/intent/CodeSection';
import { ProvenanceTree } from '@/components/intent/ProvenanceTree';
import { HistorySection } from '@/components/intent/HistorySection';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { countWorkProductDocuments } from '@/components/intent/documentHelpers';
import { getDocumentOrder, setDocumentOrder } from '@/lib/workProductsPreference';
import { humanizeSlug } from '@/lib/displayNames';
import { ArrowDownUp, Info, Search, X } from 'lucide-react';

export interface WorkProductsSectionProps {
  detail: IntentDetail;
  gates: IntentGate[];
}

const FILTER_FROM_DOCUMENTS = 6;

const NO_DOCUMENTS_COPY: Partial<Record<IntentDetail['intent']['status'], string>> = {
  FAILED: 'No documents were produced before the run failed.',
  CANCELLED: 'No documents were produced before the run was cancelled.',
  SUCCEEDED: 'This run produced no documents.',
};

export function WorkProductsSection({ detail, gates }: WorkProductsSectionProps) {
  const { openArtifactPreview, openItemPreview, projectId, intentId, stageRows, phaseNameOf } =
    useIntent();
  const { getNeighbors, derivedItems, itemsByArtifact } = useIntentGraph(projectId, intentId);

  const questionGates = useMemo(() => gates.filter((g) => g.kind === 'question'), [gates]);
  const steering = detail.steering ?? [];
  const [documentOrder, setDocumentOrderState] = useState(getDocumentOrder);
  // The filter belongs to one intent: switching intents starts unfiltered.
  const [filterState, setFilterState] = useState({ intentId, value: '' });
  const filter = filterState.intentId === intentId ? filterState.value : '';
  const setFilter = (value: string) => setFilterState({ intentId, value });
  const newestFirst = documentOrder === 'newest-first';
  const documentCount = useMemo(
    () => countWorkProductDocuments(detail.artifacts),
    [detail.artifacts],
  );

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
  const unitBranchItems = useMemo(() => buildUnitBranchItems(detail), [detail]);

  const nothingToShow =
    detail.artifacts.length === 0 &&
    questionGates.length === 0 &&
    steering.length === 0 &&
    codeItems.length === 0;
  // A run that ended with nothing says so (the page must not just stop after
  // the pipeline, review R3-16); a draft has nothing to say yet.
  if (nothingToShow && detail.intent.status === 'DRAFT') return null;

  const planWarnings = detail.intent.planWarnings ?? [];
  const showPlanWarnings = planWarnings.length > 0 && detail.intent.status !== 'SUCCEEDED';
  // An active filter keeps its field (and Clear) even when a rewind drops the
  // count below the threshold; otherwise it would hide documents with no way back.
  const showFilter = documentCount >= FILTER_FROM_DOCUMENTS || filter !== '';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="mr-auto text-sm">Work products</CardTitle>
          {documentCount > 1 && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 sm:order-last"
                    aria-label={
                      newestFirst
                        ? 'Sort work products by oldest first'
                        : 'Sort work products by newest first'
                    }
                    onClick={() => {
                      const nextOrder = newestFirst ? 'oldest-first' : 'newest-first';
                      setDocumentOrderState(nextOrder);
                      setDocumentOrder(nextOrder);
                    }}
                  >
                    <ArrowDownUp className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {newestFirst
                    ? 'Show oldest work products first'
                    : 'Show newest work products first'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {showFilter && (
            <div className="relative basis-full sm:w-56 sm:basis-auto">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                aria-label="Filter documents"
                placeholder="Filter documents"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && filter) {
                    event.preventDefault();
                    setFilter('');
                  }
                }}
                className="h-8 pl-8 pr-8 text-sm [&::-webkit-search-cancel-button]:hidden"
              />
              {filter && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Clear filter"
                  className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2"
                  onClick={() => setFilter('')}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>
        {showPlanWarnings && (
          <Disclosure
            variant="inline"
            className="mt-2"
            title={
              <span className="inline-flex items-center gap-1.5 text-primary">
                <Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                {detail.intent.scope
                  ? `Some stages are intentionally excluded from the ${humanizeSlug(detail.intent.scope)} scope`
                  : 'Some stages are intentionally excluded from this scope'}
              </span>
            }
          >
            <ul className="space-y-1 pl-5 text-xs text-muted-foreground">
              {planWarnings.map((w, i) => (
                <li key={`${w.code}-${i}`} className="list-disc">
                  {w.message}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {detail.artifacts.length > 0 || codeItems.length > 0 ? (
          <ProvenanceTree
            detail={detail}
            stageRows={stageRows}
            phaseNameOf={phaseNameOf}
            getNeighbors={getNeighbors}
            itemsByArtifact={itemsByArtifact}
            derivedItems={derivedItems}
            codeItems={codeItems}
            unitBranchItems={unitBranchItems}
            openArtifactPreview={openArtifactPreview}
            openItemPreview={openItemPreview}
            documentOrder={documentOrder}
            filter={filter}
          />
        ) : (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {NO_DOCUMENTS_COPY[detail.intent.status] ??
              'No work products yet — documents, items and code will appear here as the run progresses.'}
          </p>
        )}

        {(questionGates.length > 0 || steering.length > 0) && !filter.trim() && (
          <HistorySection
            questionGates={questionGates}
            steering={steering}
            influencedArtifactsByQuestion={influencedArtifactsByQuestion}
          />
        )}
      </CardContent>
    </Card>
  );
}
