// Tier-model overrides — the shared compact editor for the agent tier → model
// configuration (services/projects.ts TierModels). Rendered collapsed inside
// the Admin Default Models card (global config) and the project Agent tab
// (per-project overrides that win row/CLI-wise over the global config).
//
// Four override rows: the three upstream agent tiers (judgment / balanced /
// templated) plus Quorum (discussion/edit one-shot surfaces). The legacy
// `fallback` row is deliberately NOT rendered — the flat per-CLI default model
// IS the fallback (a tier row beats it; everything tier-less inherits it) —
// though saved fallback values keep resolving in the backend.
//
// Every unset cell shows what it actually inherits (the caller passes the
// effective per-CLI defaults) instead of a bare "Not set".

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AgentModel } from '@/services/agents';
import type { CliModels, RuntimeModelCli, TierModels, TierModelRow } from '@/services/projects';

const MODEL_CLI_LABELS: Record<RuntimeModelCli, string> = {
  kiro: 'Kiro',
  claude: 'Claude',
  opencode: 'OpenCode',
};
const MODEL_CLI_KEYS = Object.keys(MODEL_CLI_LABELS) as RuntimeModelCli[];

// Radix Select can't hold an empty-string value, so the "unset" choice carries
// this sentinel; it maps back to '' (cleared) on change.
const MODEL_DEFAULT_SENTINEL = '__default__';

// The rows the editor exposes (fallback is legacy-only, see header).
export const TIER_MODEL_ROWS: { row: TierModelRow; label: string; description: string }[] = [
  { row: 'judgment', label: 'Judgment', description: 'architect, developer, design, …' },
  { row: 'balanced', label: 'Balanced', description: 'reviewer agents' },
  { row: 'templated', label: 'Templated', description: 'delivery, operations, pipeline' },
  { row: 'quorum', label: 'Quorum', description: 'discussion + edit assists' },
];

// Drop empty strings so change detection and save payloads stay canonical.
// Preserves a legacy `fallback` row untouched (the editor never renders it,
// but saving must not silently erase it).
export function canonicalTierModels(models: TierModels = {}): TierModels {
  const rows: TierModelRow[] = ['judgment', 'balanced', 'templated', 'fallback', 'quorum'];
  return rows.reduce<TierModels>((acc, row) => {
    const rowValue = models[row] ?? {};
    const cleaned = MODEL_CLI_KEYS.reduce<CliModels>((rowAcc, cli) => {
      const value = rowValue[cli]?.trim();
      if (value) rowAcc[cli] = value;
      return rowAcc;
    }, {});
    if (Object.keys(cleaned).length > 0) acc[row] = cleaned;
    return acc;
  }, {});
}

interface Props {
  value: TierModels;
  onChange: (next: TierModels) => void;
  modelOptions: Partial<Record<RuntimeModelCli, AgentModel[]>>;
  modelsLoaded: boolean;
  disabled?: boolean;
  /** Distinguishes admin vs project instances in test ids + element ids. */
  idPrefix: string;
  /** The effective per-CLI defaults an unset cell inherits (flat default
   *  models, for the project card merged with the global tier config). */
  inheritedModels?: CliModels;
}

// Short display name for an inherited model id (the id's last path segment,
// truncated) so the placeholder stays readable inside a narrow cell.
const inheritLabel = (model?: string) => {
  if (!model) return 'Default';
  const short = model.split('/').pop() ?? model;
  return `Default (${short.length > 28 ? `${short.slice(0, 27)}…` : short})`;
};

export function TierModelsSection({
  value,
  onChange,
  modelOptions,
  modelsLoaded,
  disabled = false,
  idPrefix,
  inheritedModels = {},
}: Props) {
  const setCell = (row: TierModelRow, cli: RuntimeModelCli, model: string) => {
    onChange({ ...value, [row]: { ...value[row], [cli]: model } });
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-y-1.5">
        <thead>
          <tr>
            <th className="w-40 pr-3 text-left text-[11px] font-medium text-muted-foreground" />
            {MODEL_CLI_KEYS.map((cli) => (
              <th
                key={cli}
                className="pr-2 text-left text-[11px] font-medium text-muted-foreground"
              >
                {MODEL_CLI_LABELS[cli]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TIER_MODEL_ROWS.map(({ row, label, description }) => (
            <tr key={row}>
              <td className="pr-3 align-middle">
                <span className="text-xs font-semibold text-foreground">{label}</span>
                <span className="block text-[10px] leading-tight text-muted-foreground">
                  {description}
                </span>
              </td>
              {MODEL_CLI_KEYS.map((cli) => {
                const options = modelOptions[cli] ?? [];
                const current = value[row]?.[cli] || '';
                const optionIds = new Set(options.map((o) => o.id));
                const extraOption: AgentModel[] =
                  current && !optionIds.has(current)
                    ? [{ id: current, name: `${current} (custom)` }]
                    : [];
                const cellId = `${idPrefix}-tier-model-${row}-${cli}`;
                const placeholder = inheritLabel(inheritedModels[cli]);
                return (
                  <td key={cli} className="pr-2 align-middle">
                    {modelsLoaded && options.length > 0 ? (
                      <Select
                        value={current || MODEL_DEFAULT_SENTINEL}
                        onValueChange={(v) =>
                          setCell(row, cli, v === MODEL_DEFAULT_SENTINEL ? '' : v)
                        }
                        disabled={disabled}
                      >
                        <SelectTrigger
                          id={cellId}
                          data-testid={cellId}
                          className="h-8 text-xs disabled:cursor-default"
                        >
                          <SelectValue placeholder={placeholder} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={MODEL_DEFAULT_SENTINEL}>{placeholder}</SelectItem>
                          {[...extraOption, ...options].map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              <span className="font-mono text-xs">{m.name}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={cellId}
                        data-testid={cellId}
                        value={current}
                        onChange={(e) => setCell(row, cli, e.target.value)}
                        placeholder={placeholder}
                        className="h-8 font-mono text-xs"
                        disabled={disabled}
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
