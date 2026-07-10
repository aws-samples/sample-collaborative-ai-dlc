// Default agent models card — per-CLI default model IDs used when a project
// doesn't set its own override, plus a collapsed per-tier override table (pin
// a different model for a specific agent tier or the Quorum assists; unset
// cells inherit the defaults). Extracted from the old monolithic Admin page.

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronRight, Cpu, ExternalLink } from 'lucide-react';
import { agentsService, type AgentModel } from '@/services/agents';
import type { CliModels, RuntimeModelCli, TierModels } from '@/services/projects';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { TierModelsSection, canonicalTierModels } from '@/components/settings/TierModelsSection';

const MODEL_CLI_LABELS: Record<RuntimeModelCli, string> = {
  kiro: 'Kiro',
  claude: 'Claude',
  opencode: 'OpenCode',
};

const MODEL_CLI_KEYS = Object.keys(MODEL_CLI_LABELS) as RuntimeModelCli[];

// Radix Select can't hold an empty-string value, so the "use the default" choice
// carries this sentinel; it maps back to '' (cleared override) on change.
const MODEL_DEFAULT_SENTINEL = '__default__';

const MODEL_ID_HELP: Record<RuntimeModelCli, { label: string; url: string }> = {
  kiro: {
    label: 'Kiro model IDs',
    url: 'https://kiro.dev/docs/',
  },
  claude: {
    label: 'Bedrock model IDs',
    url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
  },
  opencode: {
    label: 'Bedrock model IDs',
    url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
  },
};

const MODEL_PLACEHOLDERS: Record<RuntimeModelCli, string> = {
  kiro: 'Model ID',
  claude: 'us.anthropic.claude-sonnet-4-6',
  opencode: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6',
};

function canonicalCliModels(models: CliModels = {}) {
  return MODEL_CLI_KEYS.reduce<CliModels>((acc, cli) => {
    const value = models[cli]?.trim();
    if (value) acc[cli] = value;
    return acc;
  }, {});
}

export function DefaultModelsCard() {
  const [savedModels, setSavedModels] = useState<CliModels>({});
  const [cliModels, setCliModels] = useState<CliModels>({});
  const [savedTierModels, setSavedTierModels] = useState<TierModels>({});
  const [tierModels, setTierModels] = useState<TierModels>({});
  // The override table is collapsed by default (the common case is defaults
  // only); it opens automatically when the saved config already carries
  // overrides so existing configuration is never hidden.
  const [tierOpen, setTierOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);

  // Model options fetched from the capabilities endpoint
  const [modelOptions, setModelOptions] = useState<Partial<Record<RuntimeModelCli, AgentModel[]>>>(
    {},
  );
  const [modelsLoaded, setModelsLoaded] = useState(false);

  useEffect(() => {
    agentsService
      .getSettings()
      .then((s) => {
        setSavedModels(s.cliModels || {});
        setCliModels(s.cliModels || {});
        setSavedTierModels(s.tierModels || {});
        setTierModels(s.tierModels || {});
        if (Object.keys(canonicalTierModels(s.tierModels || {})).length > 0) setTierOpen(true);
      })
      .catch((e) => console.error('Failed to load agent settings:', e))
      .finally(() => setLoading(false));

    agentsService
      .getCapabilities(true)
      .then((c) => {
        if (c.models) setModelOptions(c.models);
      })
      .catch(() => {
        /* non-fatal — fall back to Input fields when models unavailable */
      })
      .finally(() => setModelsLoaded(true));
  }, []);

  const hasChanges =
    JSON.stringify(canonicalCliModels(cliModels)) !==
      JSON.stringify(canonicalCliModels(savedModels)) ||
    JSON.stringify(canonicalTierModels(tierModels)) !==
      JSON.stringify(canonicalTierModels(savedTierModels));

  // How many cells are overridden — shown on the collapsed disclosure so an
  // admin can tell at a glance whether anything deviates from the defaults.
  const tierOverrideCount = Object.values(canonicalTierModels(tierModels)).reduce(
    (n, row) => n + Object.keys(row ?? {}).length,
    0,
  );

  const save = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      await agentsService.updateSettings({
        cliModels,
        tierModels: canonicalTierModels(tierModels),
      });
      const fresh = await agentsService.getSettings();
      setSavedModels(fresh.cliModels || {});
      setCliModels(fresh.cliModels || {});
      setSavedTierModels(fresh.tierModels || {});
      setTierModels(fresh.tierModels || {});
      setSaveResult('saved');
    } catch (e) {
      console.error('Failed to save default models:', e);
      setSaveResult('error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  return (
    <SettingsCard
      icon={<Cpu />}
      title="Default Models"
      description="Default model per CLI — every agent uses it unless a tier or project override applies."
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {MODEL_CLI_KEYS.map((cli) => {
              const options = modelOptions[cli] ?? [];
              const current = cliModels[cli] || '';
              // If a previously-saved model ID isn't in the discovered list,
              // surface it so the dropdown still shows + keeps it.
              const optionIds = new Set(options.map((o) => o.id));
              const extraOption: AgentModel[] =
                current && !optionIds.has(current)
                  ? [{ id: current, name: `${current} (custom)` }]
                  : [];
              const defaultLabel = 'No default — use CLI built-in';

              return (
                <div key={cli} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <label
                      htmlFor={`default-model-${cli}`}
                      className="text-xs font-medium text-foreground"
                    >
                      {MODEL_CLI_LABELS[cli]}
                    </label>
                    <a
                      href={MODEL_ID_HELP[cli].url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {MODEL_ID_HELP[cli].label}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  {modelsLoaded && options.length > 0 ? (
                    <Select
                      value={current || MODEL_DEFAULT_SENTINEL}
                      onValueChange={(v) =>
                        setCliModels((cur) => ({
                          ...cur,
                          [cli]: v === MODEL_DEFAULT_SENTINEL ? '' : v,
                        }))
                      }
                      disabled={!modelsLoaded || saving}
                    >
                      <SelectTrigger
                        id={`default-model-${cli}`}
                        data-testid={`default-model-select-${cli}`}
                        className="text-sm h-9"
                      >
                        <SelectValue placeholder={defaultLabel} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={MODEL_DEFAULT_SENTINEL}>{defaultLabel}</SelectItem>
                        {[...extraOption, ...options].map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            <span className="font-mono text-xs">{m.name}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={`default-model-${cli}`}
                      data-testid={`default-model-input-${cli}`}
                      value={current}
                      onChange={(e) => setCliModels((cur) => ({ ...cur, [cli]: e.target.value }))}
                      placeholder={MODEL_PLACEHOLDERS[cli]}
                      className="font-mono text-sm h-9"
                      disabled={!modelsLoaded || saving}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="border-t pt-3">
            <Collapsible open={tierOpen} onOpenChange={setTierOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  data-testid="tier-overrides-toggle"
                  className="flex w-full items-center gap-1.5 text-left"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${tierOpen ? 'rotate-90' : ''}`}
                  />
                  <span className="text-sm font-medium text-foreground">Per-tier overrides</span>
                  <span className="text-xs text-muted-foreground">
                    {tierOverrideCount > 0
                      ? `${tierOverrideCount} set`
                      : 'optional — every tier uses the defaults above'}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-2 pt-3">
                  <p className="text-xs text-muted-foreground">
                    Pin a different model for a specific agent tier (or the Quorum discussion
                    assists). Unset cells inherit the default model above. Projects can override any
                    cell.
                  </p>
                  <TierModelsSection
                    value={tierModels}
                    onChange={setTierModels}
                    modelOptions={modelOptions}
                    modelsLoaded={modelsLoaded}
                    disabled={saving}
                    idPrefix="admin"
                    inheritedModels={cliModels}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
          <SaveStatusButton
            onClick={save}
            disabled={!hasChanges}
            saving={saving}
            label="Save Models"
            result={saveResult}
            data-testid="default-models-save-button"
          />
        </div>
      )}
    </SettingsCard>
  );
}
