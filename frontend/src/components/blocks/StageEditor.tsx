import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// The Stage's three-compartment contract (C1 define / C2 verify / C3 learn)
// plus the front-of-stage clarification gate. Edits a plain `value` object and
// reports changes up via `onChange`. Reference fields (agents, artifacts,
// sensors) are comma-separated text for now — autocomplete pickers can replace
// them later without changing the stored shape.

export interface StageForm {
  leadAgent?: string;
  supportAgents?: string[];
  defaultGrouping?: string;
  mode?: string;
  execution?: string;
  condition?: string;
  forEach?: string | null;
  c1_definition?: {
    purpose?: string;
    inputs?: { artifact: string; required: boolean }[];
    outputs?: string[];
    intermediates?: string[];
    requires?: string[];
  };
  c2_verification?: {
    sensors?: string[];
    humanValidation?: string;
  };
  c3_learning?: {
    captures?: string[];
    promotionTargets?: string[];
  };
  clarification?: {
    required?: string;
    condition?: string;
  };
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
  // Shallow/nested setters that always produce a new object for React state.
  const set = (patch: Partial<StageForm>) => onChange({ ...value, ...patch });
  const setC1 = (patch: Partial<NonNullable<StageForm['c1_definition']>>) =>
    set({ c1_definition: { ...value.c1_definition, ...patch } });
  const setC2 = (patch: Partial<NonNullable<StageForm['c2_verification']>>) =>
    set({ c2_verification: { ...value.c2_verification, ...patch } });
  const setC3 = (patch: Partial<NonNullable<StageForm['c3_learning']>>) =>
    set({ c3_learning: { ...value.c3_learning, ...patch } });
  const setClarify = (patch: Partial<NonNullable<StageForm['clarification']>>) =>
    set({ clarification: { ...value.clarification, ...patch } });

  const c1 = value.c1_definition ?? {};
  const c2 = value.c2_verification ?? {};
  const c3 = value.c3_learning ?? {};
  const clarify = value.clarification ?? {};

  // Inputs are objects ({artifact, required}); edit the artifact names as CSV
  // and preserve each one's required flag (default true for new entries).
  const inputsCsv = listToCsv((c1.inputs ?? []).map((i) => i.artifact));
  const setInputs = (s: string) => {
    const prev = new Map((c1.inputs ?? []).map((i) => [i.artifact, i.required]));
    setC1({
      inputs: csvToList(s).map((artifact) => ({ artifact, required: prev.get(artifact) ?? true })),
    });
  };

  return (
    <Tabs defaultValue="clarify" className="w-full">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="clarify">⊣ Clarify</TabsTrigger>
        <TabsTrigger value="c1">C1 Define</TabsTrigger>
        <TabsTrigger value="c2">C2 Verify</TabsTrigger>
        <TabsTrigger value="c3">C3 Learn</TabsTrigger>
        <TabsTrigger value="meta">Agent &amp; Mode</TabsTrigger>
      </TabsList>

      {/* ⊣ Clarify — the front-of-stage human gate (P2) */}
      <TabsContent value="clarify" className="space-y-4 pt-2">
        <p className="text-xs text-muted-foreground">
          Resolve ambiguity with a human before generating. Setting this to <code>always</code>{' '}
          opens the front gate — the stage cannot fully self-halt.
        </p>
        <div className="grid gap-2 max-w-xs">
          <Label>Required</Label>
          <Input
            value={clarify.required ?? ''}
            onChange={(e) => setClarify({ required: e.target.value })}
            placeholder="always | conditional | none"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Condition</Label>
          <Input
            value={clarify.condition ?? ''}
            onChange={(e) => setClarify({ condition: e.target.value })}
            placeholder="e.g. intent lacks measurable acceptance criteria"
            disabled={disabled}
          />
        </div>
      </TabsContent>

      {/* C1 — Definition */}
      <TabsContent value="c1" className="space-y-4 pt-2">
        <div className="grid gap-2">
          <Label>Purpose</Label>
          <Textarea
            value={c1.purpose ?? ''}
            onChange={(e) => setC1({ purpose: e.target.value })}
            placeholder="What transformation or validation this stage performs"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Inputs (consumes)</Label>
          <Input
            value={inputsCsv}
            onChange={(e) => setInputs(e.target.value)}
            placeholder="intent-statement, feasibility-assessment"
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">Comma-separated artifact names.</p>
        </div>
        <div className="grid gap-2">
          <Label>Outputs (produces)</Label>
          <Input
            value={listToCsv(c1.outputs)}
            onChange={(e) => setC1({ outputs: csvToList(e.target.value) })}
            placeholder="scope-document, intent-backlog"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Intermediates</Label>
          <Input
            value={listToCsv(c1.intermediates)}
            onChange={(e) => setC1({ intermediates: csvToList(e.target.value) })}
            placeholder="scope-definition-questions"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Requires (ordering)</Label>
          <Input
            value={listToCsv(c1.requires)}
            onChange={(e) => setC1({ requires: csvToList(e.target.value) })}
            placeholder="intent-capture, feasibility"
            disabled={disabled}
          />
        </div>
      </TabsContent>

      {/* C2 — Verification */}
      <TabsContent value="c2" className="space-y-4 pt-2">
        <div className="grid gap-2">
          <Label>Sensors</Label>
          <Input
            value={listToCsv(c2.sensors)}
            onChange={(e) => setC2({ sensors: csvToList(e.target.value) })}
            placeholder="required-sections, upstream-coverage"
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            All-deterministic sensors let a stage self-halt; any llm-judged one escalates to a
            human.
          </p>
        </div>
        <div className="grid gap-2 max-w-xs">
          <Label>Human validation</Label>
          <Input
            value={c2.humanValidation ?? ''}
            onChange={(e) => setC2({ humanValidation: e.target.value })}
            placeholder="required | conditional | none"
            disabled={disabled}
          />
        </div>
      </TabsContent>

      {/* C3 — Learning */}
      <TabsContent value="c3" className="space-y-4 pt-2">
        <div className="grid gap-2">
          <Label>Captures</Label>
          <Input
            value={listToCsv(c3.captures)}
            onChange={(e) => setC3({ captures: csvToList(e.target.value) })}
            placeholder="human-corrections, reruns, escape-hatch-acceptances"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label>Promotion targets</Label>
          <Input
            value={listToCsv(c3.promotionTargets)}
            onChange={(e) => setC3({ promotionTargets: csvToList(e.target.value) })}
            placeholder="c2-sensor, guardrail-library, exemplar"
            disabled={disabled}
          />
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
          <Label>Default phase</Label>
          <Input
            value={value.defaultGrouping ?? ''}
            onChange={(e) => set({ defaultGrouping: e.target.value })}
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
