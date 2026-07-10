// Tier-model grid — the shared editor for the agent tier → model configuration
// (services/projects.ts TierModels). Rendered by both the Admin Default Models
// card (global config) and the project Agent tab (per-project overrides that
// win row/CLI-wise over the global config at intent create).
//
// Five rows: the three upstream agent tiers (judgment / balanced / templated),
// the fallback row (agents with no resolvable tier), and the Quorum row
// (discussion/edit one-shot surfaces). Each row is a per-CLI model map with
// the same select-or-input pattern as the flat per-CLI defaults.

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

export const TIER_MODEL_ROWS: { row: TierModelRow; label: string; description: string }[] = [
  {
    row: 'judgment',
    label: 'Judgment',
    description: 'Deep-reasoning agents (architect, developer, design, …)',
  },
  {
    row: 'balanced',
    label: 'Balanced',
    description: 'Reviewer agents (architecture reviewer, product lead)',
  },
  {
    row: 'templated',
    label: 'Templated',
    description: 'Plan-shaped agents (delivery, operations, pipeline deploy)',
  },
  {
    row: 'fallback',
    label: 'Fallback',
    description: 'Agents with no tier and machine one-shot calls',
  },
  {
    row: 'quorum',
    label: 'Quorum',
    description: 'Discussion assists and Quorum edit planning/apply',
  },
];

// Drop empty strings so change detection and save payloads stay canonical.
export function canonicalTierModels(models: TierModels = {}): TierModels {
  return TIER_MODEL_ROWS.reduce<TierModels>((acc, { row }) => {
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
  /** Placeholder label for an unset cell (e.g. what it falls back to). */
  unsetLabel?: string;
}

export function TierModelsSection({
  value,
  onChange,
  modelOptions,
  modelsLoaded,
  disabled = false,
  idPrefix,
  unsetLabel = 'Not set',
}: Props) {
  const setCell = (row: TierModelRow, cli: RuntimeModelCli, model: string) => {
    onChange({ ...value, [row]: { ...value[row], [cli]: model } });
  };

  return (
    <div className="space-y-4">
      {TIER_MODEL_ROWS.map(({ row, label, description }) => (
        <div key={row} className="space-y-1.5">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold text-foreground">{label}</span>
            <span className="text-[11px] text-muted-foreground">{description}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODEL_CLI_KEYS.map((cli) => {
              const options = modelOptions[cli] ?? [];
              const current = value[row]?.[cli] || '';
              const optionIds = new Set(options.map((o) => o.id));
              const extraOption: AgentModel[] =
                current && !optionIds.has(current)
                  ? [{ id: current, name: `${current} (custom)` }]
                  : [];
              const cellId = `${idPrefix}-tier-model-${row}-${cli}`;
              return (
                <div key={cli} className="space-y-1">
                  <label htmlFor={cellId} className="text-[11px] text-muted-foreground">
                    {MODEL_CLI_LABELS[cli]}
                  </label>
                  {modelsLoaded && options.length > 0 ? (
                    <Select
                      value={current || MODEL_DEFAULT_SENTINEL}
                      onValueChange={(v) =>
                        setCell(row, cli, v === MODEL_DEFAULT_SENTINEL ? '' : v)
                      }
                      disabled={disabled}
                    >
                      <SelectTrigger id={cellId} data-testid={cellId} className="text-sm h-9">
                        <SelectValue placeholder={unsetLabel} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={MODEL_DEFAULT_SENTINEL}>{unsetLabel}</SelectItem>
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
                      placeholder={unsetLabel}
                      className="font-mono text-sm h-9"
                      disabled={disabled}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
