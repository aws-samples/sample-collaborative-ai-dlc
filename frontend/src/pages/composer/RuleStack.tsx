import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Block } from '@/services/blocks';
import type { RuleLayer, RuleRef, Workflow } from '@/services/workflows';

// V2's resolution chain. Rule bodies are concatenated into the per-stage
// steering doc in this layer order (alphabetical by rule id within a layer),
// so the stack renders the same order the agent reads.
const LAYER_CHAIN: RuleLayer[] = [
  'org',
  'team',
  'team-learnings',
  'project',
  'project-learnings',
  'phase',
  'stage',
];

interface RuleStackProps {
  workflow: Workflow;
  ruleLib: Block[];
  // Rule ids from compiled.rules.unresolved — refs whose block doesn't exist.
  unresolved: string[];
  readOnly: boolean;
  onAddRule: (ruleId: string, layer: RuleLayer, ruleTenant: string) => void;
  onRemoveRule: (layer: RuleLayer, ruleId: string) => void;
}

const blockLayer = (block: Block): RuleLayer | null =>
  typeof block.layer === 'string' && (LAYER_CHAIN as string[]).includes(block.layer)
    ? (block.layer as RuleLayer)
    : null;

// Why a library rule cannot be attached right now, or null when it can.
const attachBlocker = (block: Block, attached: boolean): string | null => {
  if (attached) return 'Already attached to this workflow.';
  const layer = blockLayer(block);
  if (!layer) return 'No layer set — edit the rule block and set its layer first.';
  if (layer === 'stage') return 'Stage-layer rules are reserved and not applied to runs yet.';
  return null;
};

export function RuleStack({
  workflow,
  ruleLib,
  unresolved,
  readOnly,
  onAddRule,
  onRemoveRule,
}: RuleStackProps) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');

  const refsByLayer = new Map<RuleLayer, RuleRef[]>();
  for (const ref of workflow.ruleRefs) {
    const refs = refsByLayer.get(ref.layer) ?? [];
    refs.push(ref);
    refsByLayer.set(ref.layer, refs);
  }
  const layersWithRefs = LAYER_CHAIN.filter((layer) => (refsByLayer.get(layer) ?? []).length > 0);

  const isAttached = (block: Block) =>
    workflow.ruleRefs.some((ref) => ref.ruleId === block.id && ref.layer === blockLayer(block));

  const query = filter.toLowerCase();
  const filteredLib = ruleLib.filter(
    (block) =>
      !query ||
      block.name.toLowerCase().includes(query) ||
      block.id.toLowerCase().includes(query) ||
      (typeof block.description === 'string' && block.description.toLowerCase().includes(query)),
  );

  const libBlockFor = (ref: RuleRef) =>
    ruleLib.find((block) => block.id === ref.ruleId && block.tenantId === ref.ruleTenant);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section>
        <h3 className="text-sm font-medium">Rule stack</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Rules attach at a layer of the resolution chain (org → team → team-learnings → project →
          project-learnings → phase). Their bodies are concatenated in this order into every
          stage&apos;s steering doc; within a layer, rules sort by id.
        </p>
        {layersWithRefs.length === 0 && (
          <p className="mt-3 text-sm italic text-muted-foreground">
            No rules attached. Pick one from the library on the right.
          </p>
        )}
        <div className="mt-3 space-y-3">
          {layersWithRefs.map((layer) => (
            <div key={layer} data-testid={`rule-layer-${layer}`}>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {layer}
              </p>
              <ul className="mt-1 space-y-1">
                {(refsByLayer.get(layer) ?? [])
                  .toSorted((a, b) => a.ruleId.localeCompare(b.ruleId))
                  .map((ref) => {
                    const block = libBlockFor(ref);
                    const broken = unresolved.includes(ref.ruleId);
                    return (
                      <li
                        key={`${ref.layer}:${ref.ruleId}`}
                        className="flex items-center gap-2 rounded-md border bg-card p-2 text-sm"
                      >
                        <span className="truncate font-medium">{block?.name ?? ref.ruleId}</span>
                        <Badge variant="outline" className="h-4 shrink-0 px-1 text-[8px]">
                          {ref.ruleTenant === 'SYSTEM' ? 'SYSTEM' : 'library'}
                        </Badge>
                        {broken && (
                          <span className="flex shrink-0 items-center gap-1 text-xs text-rose-600">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            unresolved — no such rule block, runs ignore it
                          </span>
                        )}
                        {!readOnly && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="ml-auto h-6 w-6 shrink-0"
                            title="Remove rule from workflow"
                            aria-label={`Remove ${ref.ruleId} from the ${ref.layer} layer`}
                            onClick={() => onRemoveRule(ref.layer, ref.ruleId)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border bg-muted/40">
        <div className="border-b bg-muted/30 p-2.5">
          <p className="text-xs font-medium">Library rules</p>
          <Input
            placeholder="Filter rules…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="mt-2 h-7 text-xs"
          />
        </div>
        <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto p-2">
          {filteredLib.length === 0 && (
            <p className="py-4 text-center text-xs text-muted-foreground">No rules match.</p>
          )}
          {filteredLib.map((block) => {
            const layer = blockLayer(block);
            const attached = isAttached(block);
            const blocker = attachBlocker(block, attached);
            return (
              <div
                key={`${block.tenantId}:${block.id}`}
                className="group shrink-0 rounded-md border bg-card p-2 text-xs shadow-sm"
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{block.name}</span>
                  {block.readOnly && (
                    <Badge variant="outline" className="h-4 shrink-0 px-1 text-[8px]">
                      SYSTEM
                    </Badge>
                  )}
                  {layer && (
                    <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[8px]">
                      {layer}
                    </Badge>
                  )}
                  {attached && (
                    <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[8px]">
                      attached
                    </Badge>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 opacity-0 transition-opacity group-hover:opacity-100"
                      title="Open in Block Library"
                      aria-label={`Open ${block.name} in Block Library`}
                      onClick={() => navigate(`/blocks/rule/${block.id}`)}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      title={blocker ?? 'Attach to workflow'}
                      aria-label={`Attach ${block.name} to the workflow`}
                      disabled={readOnly || blocker != null}
                      onClick={() => layer && onAddRule(block.id, layer, block.tenantId)}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </span>
                </div>
                {typeof block.description === 'string' && block.description && (
                  <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground">
                    {block.description}
                  </p>
                )}
                {blocker && !attached && (
                  <p className="mt-0.5 text-[10px] text-amber-600">{blocker}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
