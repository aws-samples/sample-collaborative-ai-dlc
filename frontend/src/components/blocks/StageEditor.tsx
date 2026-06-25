import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// The Stage's flat V2 frontmatter shape, grouped into editor tabs for clarity
// (Define / Verify / Agent & Mode) — the grouping is presentation only; the
// stored object is flat. Edits a plain `value` object and reports changes up via
// `onChange`. Reference fields (agents, artifacts, sensors) are comma-separated
// text for now — autocomplete pickers can replace them later without changing
// the stored shape.
//
// Verification has three orthogonal axes: deterministic `sensors`, an LLM-judged
// `reviewer` agent, and the human `humanValidation` gate.

export interface StageForm {
  leadAgent?: string;
  supportAgents?: string[];
  phase?: string;
  mode?: string;
  execution?: string;
  condition?: string;
  forEach?: string | null;
  produces?: string[];
  consumes?: { artifact: string; required: boolean; conditionalOn?: string }[];
  requires?: string[];
  blocksOn?: string[];
  inputs?: string;
  outputs?: string;
  sensors?: string[];
  reviewer?: string | null;
  reviewerMaxIterations?: number | null;
  humanValidation?: string;
  [key: string]: unknown;
}

interface Props {
  value: StageForm;
  onChange: (next: StageForm) => void;
  disabled?: boolean;
}

const csvToList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const listToCsv = (l?: string[]) => (l ?? []).join(', ');

export function StageEditor({ value, onChange, disabled }: Props) {
  const set = (patch: Partial<StageForm>) => onChange({ ...value, ...patch });

  // Consumes are objects ({artifact, required, conditionalOn?}); edit the
  // artifact names as CSV and preserve each one's required flag + conditionalOn
  // (default required=true for new entries).
  const consumesCsv = listToCsv((value.consumes ?? []).map((i) => i.artifact));
  const setConsumes = (s: string) => {
    const prev = new Map((value.consumes ?? []).map((i) => [i.artifact, i]));
    set({
      consumes: csvToList(s).map((artifact) => prev.get(artifact) ?? { artifact, required: true }),
    });
  };

  return (
    <Tabs defaultValue="define" className="w-full">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="define">Define</TabsTrigger>
        <TabsTrigger value="verify">Verify</TabsTrigger>
        <TabsTrigger value="meta">Agent &amp; Mode</TabsTrigger>
      </TabsList>

      {/* Define — the stage's DAG edges + human prose */}
      <TabsContent value="define" className="space-y-4 pt-2">
        <div className="grid gap-2">
          <Label>Consumes (inputs)</Label>
          <Input
            value={consumesCsv}
            onChange={(e) => setConsumes(e.target.value)}
            placeholder="intent-statement, feasibility-assessment"
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">Comma-separated artifact names.</p>
        </div>
        <div className="grid gap-2">
          <Label>Produces (outputs)</Label>
          <Input
            value={listToCsv(value.produces)}
            onChange={(e) => set({ produces: csvToList(e.target.value) })}
            placeholder="scope-document, intent-backlog"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Requires (data/ordering)</Label>
          <Input
            value={listToCsv(value.requires)}
            onChange={(e) => set({ requires: csvToList(e.target.value) })}
            placeholder="intent-capture, feasibility"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Blocks on (completion-only ordering)</Label>
          <Input
            value={listToCsv(value.blocksOn)}
            onChange={(e) => set({ blocksOn: csvToList(e.target.value) })}
            placeholder="(reserved — run after, no data read)"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Inputs (prose)</Label>
          <Textarea
            value={value.inputs ?? ''}
            onChange={(e) => set({ inputs: e.target.value })}
            placeholder="Human-readable description of what this stage reads"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Outputs (prose)</Label>
          <Textarea
            value={value.outputs ?? ''}
            onChange={(e) => set({ outputs: e.target.value })}
            placeholder="Human-readable description of what this stage writes"
            disabled={disabled}
          />
        </div>
      </TabsContent>

      {/* Verify — the three orthogonal verification axes */}
      <TabsContent value="verify" className="space-y-4 pt-2">
        <div className="grid gap-2">
          <Label>Sensors (deterministic)</Label>
          <Input
            value={listToCsv(value.sensors)}
            onChange={(e) => set({ sensors: csvToList(e.target.value) })}
            placeholder="required-sections, upstream-coverage"
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            Deterministic checks (advisory). They never block a stage from self-halting.
          </p>
        </div>
        <div className="grid gap-2 max-w-xs">
          <Label>Reviewer (LLM-judged)</Label>
          <Input
            value={value.reviewer ?? ''}
            onChange={(e) => set({ reviewer: e.target.value || null })}
            placeholder="aidlc-architecture-reviewer-agent"
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            A reviewer agent returns READY/NOT-READY and can escalate — puts a judge in the loop.
          </p>
        </div>
        <div className="grid gap-2 max-w-xs">
          <Label>Reviewer max iterations</Label>
          <Input
            type="number"
            value={value.reviewerMaxIterations ?? ''}
            onChange={(e) =>
              set({ reviewerMaxIterations: e.target.value ? Number(e.target.value) : null })
            }
            placeholder="2"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2 max-w-xs">
          <Label>Human validation</Label>
          <Input
            value={value.humanValidation ?? ''}
            onChange={(e) => set({ humanValidation: e.target.value })}
            placeholder="required | conditional | none"
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            A required gate makes the stage human-gated; conditional or a reviewer makes it mixed.
          </p>
        </div>
      </TabsContent>

      {/* Agent & mode — intrinsic stage metadata */}
      <TabsContent value="meta" className="space-y-4 pt-2">
        <div className="grid gap-2">
          <Label>Lead agent</Label>
          <Input
            value={value.leadAgent ?? ''}
            onChange={(e) => set({ leadAgent: e.target.value })}
            placeholder="aidlc-product-agent"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Support agents</Label>
          <Input
            value={listToCsv(value.supportAgents)}
            onChange={(e) => set({ supportAgents: csvToList(e.target.value) })}
            placeholder="aidlc-delivery-agent, aidlc-architect-agent"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Phase</Label>
          <Input
            value={value.phase ?? ''}
            onChange={(e) => set({ phase: e.target.value })}
            placeholder="ideation"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2 max-w-xs">
          <Label>Mode</Label>
          <Input
            value={value.mode ?? ''}
            onChange={(e) => set({ mode: e.target.value })}
            placeholder="inline | subagent | agent-team"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2 max-w-xs">
          <Label>Execution</Label>
          <Input
            value={value.execution ?? ''}
            onChange={(e) => set({ execution: e.target.value })}
            placeholder="ALWAYS | CONDITIONAL"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Condition (when CONDITIONAL)</Label>
          <Input
            value={value.condition ?? ''}
            onChange={(e) => set({ condition: e.target.value })}
            placeholder="e.g. project is brownfield"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2 max-w-xs">
          <Label>For each (fan-out)</Label>
          <Input
            value={value.forEach ?? ''}
            onChange={(e) => set({ forEach: e.target.value || null })}
            placeholder="unit-of-work"
            disabled={disabled}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}
