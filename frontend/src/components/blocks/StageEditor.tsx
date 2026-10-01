import { useId, useMemo, useState } from 'react';
import { GitBranch, Plus, ShieldCheck, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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

export interface ReferenceOption {
  id: string;
  label: string;
  description?: string;
}

export interface StageReferenceOptions {
  agents?: ReferenceOption[];
  artifacts?: ReferenceOption[];
  sensors?: ReferenceOption[];
  stages?: ReferenceOption[];
}

interface Props {
  value: StageForm;
  onChange: (next: StageForm) => void;
  disabled?: boolean;
  referenceOptions?: StageReferenceOptions;
}

const NONE = '__none__';
const UNIT_OF_WORK = 'unit-of-work';

const csvToList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const listToCsv = (l?: string[]) => (l ?? []).join(', ');

const unique = (items: string[]) => [...new Set(items.filter(Boolean))];

const verificationLabel = (stage: StageForm) => {
  if (stage.humanValidation === 'required') return 'human-gated';
  if (stage.humanValidation === 'conditional' || stage.reviewer) return 'mixed';
  return 'self-halting';
};

export function StageEditor({ value, onChange, disabled, referenceOptions = {} }: Props) {
  const set = (patch: Partial<StageForm>) => onChange({ ...value, ...patch });
  const summaryBranchId = useId();

  const consumes = value.consumes ?? [];
  const branchEnabled = value.forEach === UNIT_OF_WORK;
  const artifactInputs = consumes.map((input) => input.artifact);
  const artifactOutputs = value.produces ?? [];
  const runMode = value.mode ?? 'inline';
  const execution = value.execution ?? 'ALWAYS';
  const verification = verificationLabel(value);

  const setConsumes = (artifacts: string[]) => {
    const prev = new Map(consumes.map((item) => [item.artifact, item]));
    set({
      consumes: unique(artifacts).map(
        (artifact) => prev.get(artifact) ?? { artifact, required: true },
      ),
    });
  };

  const setConsumeRequired = (artifact: string, required: boolean) => {
    set({
      consumes: consumes.map((item) => (item.artifact === artifact ? { ...item, required } : item)),
    });
  };

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 rounded-md border bg-background/95 p-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="h-6">
            {value.phase || 'unphased'}
          </Badge>
          <Badge variant="outline" className="h-6">
            {value.leadAgent || 'no lead agent'}
          </Badge>
          <Badge variant="outline" className="h-6">
            {runMode}
          </Badge>
          <Badge variant={branchEnabled ? 'default' : 'outline'} className="h-6 gap-1">
            <GitBranch className="h-3 w-3" />
            {branchEnabled ? 'unit branch' : 'single run'}
          </Badge>
          <Badge variant="outline" className="h-6">
            {artifactInputs.length} in / {artifactOutputs.length} out
          </Badge>
          <Badge variant="outline" className="h-6 gap-1">
            <ShieldCheck className="h-3 w-3" />
            {verification}
          </Badge>
          <span className="ml-auto flex items-center gap-2">
            <Label htmlFor={summaryBranchId} className="text-xs">
              Branch by unit of work
            </Label>
            <Switch
              id={summaryBranchId}
              checked={branchEnabled}
              onCheckedChange={(checked) => set({ forEach: checked ? UNIT_OF_WORK : null })}
              disabled={disabled}
            />
          </span>
        </div>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="flow">Flow</TabsTrigger>
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="verify">Verify</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 pt-2">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Phase</Label>
              <Input
                value={value.phase ?? ''}
                onChange={(e) => set({ phase: e.target.value })}
                placeholder="ideation"
                disabled={disabled}
              />
            </div>
            <ChipPicker
              label="Lead agent"
              single
              values={value.leadAgent ? [value.leadAgent] : []}
              options={referenceOptions.agents}
              onChange={(items) => set({ leadAgent: items[0] ?? '' })}
              disabled={disabled}
              placeholder="Search agents"
            />
          </div>
          <ChipPicker
            label="Support agents"
            values={value.supportAgents ?? []}
            options={referenceOptions.agents}
            onChange={(items) => set({ supportAgents: items })}
            disabled={disabled}
            placeholder="Add support agents"
          />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Inputs summary</Label>
              <Textarea
                value={value.inputs ?? ''}
                onChange={(e) => set({ inputs: e.target.value })}
                placeholder="Human-readable description of what this stage reads"
                disabled={disabled}
              />
            </div>
            <div className="grid gap-2">
              <Label>Outputs summary</Label>
              <Textarea
                value={value.outputs ?? ''}
                onChange={(e) => set({ outputs: e.target.value })}
                placeholder="Human-readable description of what this stage writes"
                disabled={disabled}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="flow" className="space-y-4 pt-2">
          <ChipPicker
            label="Artifacts consumed"
            values={artifactInputs}
            options={referenceOptions.artifacts}
            onChange={setConsumes}
            disabled={disabled}
            placeholder="Add input artifacts"
          />
          {consumes.length > 0 && (
            <div className="rounded-md border">
              {consumes.map((item) => (
                <div
                  key={item.artifact}
                  className="flex flex-wrap items-center gap-3 border-b px-3 py-2 text-xs last:border-b-0"
                >
                  <span className="font-medium">{item.artifact}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <Label htmlFor={`required-${item.artifact}`} className="text-xs">
                      Required
                    </Label>
                    <Switch
                      id={`required-${item.artifact}`}
                      checked={item.required !== false}
                      onCheckedChange={(checked) => setConsumeRequired(item.artifact, checked)}
                      disabled={disabled}
                    />
                  </span>
                </div>
              ))}
            </div>
          )}
          <ChipPicker
            label="Artifacts produced"
            values={value.produces ?? []}
            options={referenceOptions.artifacts}
            onChange={(items) => set({ produces: items })}
            disabled={disabled}
            placeholder="Add output artifacts"
          />
          <ChipPicker
            label="Dependency stages"
            values={value.requires ?? []}
            options={referenceOptions.stages}
            onChange={(items) => set({ requires: items })}
            disabled={disabled}
            placeholder="Add required stages"
          />
        </TabsContent>

        <TabsContent value="run" className="space-y-4 pt-2">
          <div className="grid gap-4 md:grid-cols-2">
            <SelectField
              label="Run mode"
              value={runMode}
              values={['inline', 'subagent', 'agent-team']}
              onChange={(mode) => set({ mode })}
              disabled={disabled}
            />
            <SelectField
              label="Execution policy"
              value={execution}
              values={['ALWAYS', 'CONDITIONAL']}
              onChange={(next) => set({ execution: next })}
              disabled={disabled}
            />
          </div>
          {execution === 'CONDITIONAL' && (
            <div className="grid gap-2">
              <Label>Condition</Label>
              <Input
                value={value.condition ?? ''}
                onChange={(e) => set({ condition: e.target.value })}
                placeholder="e.g. project is brownfield"
                disabled={disabled}
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-1">
              <Label htmlFor="branch-unit-work" className="text-sm">
                Branch by unit of work
              </Label>
              {value.forEach && value.forEach !== UNIT_OF_WORK && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  Current value is unsupported by runtime: {value.forEach}
                </p>
              )}
            </div>
            <Switch
              id="branch-unit-work"
              checked={branchEnabled}
              onCheckedChange={(checked) => set({ forEach: checked ? UNIT_OF_WORK : null })}
              disabled={disabled}
            />
          </div>
        </TabsContent>

        <TabsContent value="verify" className="space-y-4 pt-2">
          <ChipPicker
            label="Deterministic sensors"
            values={value.sensors ?? []}
            options={referenceOptions.sensors}
            onChange={(items) => set({ sensors: items })}
            disabled={disabled}
            placeholder="Add sensors"
          />
          <div className="grid gap-4 md:grid-cols-2">
            <ChipPicker
              label="Reviewer"
              single
              values={value.reviewer ? [value.reviewer] : []}
              options={referenceOptions.agents}
              onChange={(items) => set({ reviewer: items[0] ?? null })}
              disabled={disabled}
              placeholder="Search reviewer agents"
            />
            <div className="grid gap-2">
              <Label>Reviewer max iterations</Label>
              <Input
                type="number"
                min={1}
                value={value.reviewerMaxIterations ?? ''}
                onChange={(e) =>
                  set({ reviewerMaxIterations: e.target.value ? Number(e.target.value) : null })
                }
                placeholder="2"
                disabled={disabled}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-1">
              <Label htmlFor="human-validation-required" className="text-sm">
                Human validation required
              </Label>
              <SelectField
                compact
                label="Human validation mode"
                value={value.humanValidation ?? 'none'}
                values={['none', 'conditional', 'required']}
                onChange={(humanValidation) => set({ humanValidation })}
                disabled={disabled}
              />
            </div>
            <Switch
              id="human-validation-required"
              checked={value.humanValidation === 'required'}
              onCheckedChange={(checked) => set({ humanValidation: checked ? 'required' : 'none' })}
              disabled={disabled}
            />
          </div>
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4 pt-2">
          <ManualCsvField
            label="Manual input artifacts"
            value={artifactInputs}
            onChange={setConsumes}
            disabled={disabled}
          />
          <ManualCsvField
            label="Manual output artifacts"
            value={value.produces ?? []}
            onChange={(items) => set({ produces: items })}
            disabled={disabled}
          />
          <ManualCsvField
            label="Manual stage dependencies"
            value={value.requires ?? []}
            onChange={(items) => set({ requires: items })}
            disabled={disabled}
          />
          <ManualCsvField
            label="Blocks on"
            value={value.blocksOn ?? []}
            onChange={(items) => set({ blocksOn: items })}
            disabled={disabled}
          />
          <div className="grid gap-2">
            <Label>Raw forEach value</Label>
            <Input
              value={value.forEach ?? ''}
              onChange={(e) => set({ forEach: e.target.value || null })}
              placeholder="unit-of-work"
              disabled={disabled}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SelectField({
  label,
  value,
  values,
  onChange,
  disabled,
  compact,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'grid gap-1' : 'grid gap-2'}>
      {!compact && <Label>{label}</Label>}
      <Select
        value={value || NONE}
        onValueChange={(next) => onChange(next === NONE ? '' : next)}
        disabled={disabled}
      >
        <SelectTrigger className={compact ? 'h-8 w-52 text-xs' : undefined} aria-label={label}>
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ManualCsvField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={listToCsv(value)}
        onChange={(e) => onChange(csvToList(e.target.value))}
        placeholder="comma-separated ids"
        disabled={disabled}
      />
    </div>
  );
}

function ChipPicker({
  label,
  values,
  options = [],
  onChange,
  disabled,
  placeholder,
  single,
}: {
  label: string;
  values: string[];
  options?: ReferenceOption[];
  onChange: (items: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  single?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const selected = useMemo(() => new Set(values), [values]);
  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return options
      .filter((option) => !selected.has(option.id))
      .filter((option) => !q || option.id.includes(q) || option.label.toLowerCase().includes(q))
      .slice(0, 6);
  }, [draft, options, selected]);

  const add = (item: string) => {
    const next = item.trim();
    if (!next) return;
    onChange(single ? [next] : unique([...values, next]));
    setDraft('');
  };
  const remove = (item: string) => onChange(values.filter((value) => value !== item));

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="rounded-md border bg-background p-2">
        <div className="mb-2 flex min-h-7 flex-wrap gap-1">
          {values.length === 0 && <span className="text-xs text-muted-foreground">None</span>}
          {values.map((item) => (
            <Badge key={item} variant="secondary" className="gap-1">
              {options.find((option) => option.id === item)?.label ?? item}
              {!disabled && (
                <button
                  type="button"
                  className="rounded-full hover:text-destructive"
                  onClick={() => remove(item)}
                  aria-label={`Remove ${item}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
        {!disabled && (
          <div className="relative flex gap-2">
            <Input
              id={id}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ',') {
                  event.preventDefault();
                  add(draft);
                }
              }}
              placeholder={placeholder}
              className="h-8 text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => add(draft)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            {draft.trim() && matches.length > 0 && (
              <div className="absolute left-0 right-10 top-9 z-20 rounded-md border bg-popover p-1 shadow-md">
                {matches.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                    onClick={() => add(option.id)}
                  >
                    <span className="font-medium">{option.label}</span>
                    <span className="ml-2 text-muted-foreground">{option.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
