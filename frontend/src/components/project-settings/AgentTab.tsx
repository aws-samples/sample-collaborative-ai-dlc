// Project Settings → Agent tab: agent CLI picker + per-CLI model override.
// Self-contained: loads CLI capabilities and global model defaults itself,
// saves through projectsService, and syncs updates upward.

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Bot, CheckCircle2, ChevronRight, Cpu, ExternalLink } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import {
  projectsService,
  type Project,
  type AgentCli,
  type CliModels,
  type RuntimeModelCli,
  type TierModels,
} from '@/services/projects';
import { agentsService, type AgentModel, type RuntimeCliStatus } from '@/services/agents';
import { invalidateProjects } from '@/hooks/useProjectsCache';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { CustomMcpServersSection } from '@/components/settings/CustomMcpServersSection';
import { CustomRulesSection } from '@/components/settings/CustomRulesSection';
import { TierModelsSection, canonicalTierModels } from '@/components/settings/TierModelsSection';
import type { CustomRule } from '@/services/projects';

const AGENT_CLI_CONFIG: Record<AgentCli, { label: string; description: string }> = {
  kiro: {
    label: 'Kiro',
    description: 'AWS Kiro CLI — device-flow SSO authentication',
  },
  claude: {
    label: 'Claude Code',
    description: 'Anthropic Claude Code — AWS Bedrock authentication',
  },
  opencode: {
    label: 'OpenCode',
    description: 'OpenCode CLI — AWS Bedrock authentication',
  },
};

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
  kiro: { label: 'Kiro model IDs', url: 'https://kiro.dev/docs/' },
  claude: {
    label: 'Bedrock model IDs',
    url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
  },
  opencode: {
    label: 'Bedrock model IDs',
    url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
  },
};

interface Props {
  project: Project;
  canEdit: boolean;
  onProjectUpdated: (updates: Partial<Project>) => void;
}

export function AgentTab({ project, canEdit, onProjectUpdated }: Props) {
  // Capabilities — which CLIs are usable, per-CLI model lists, runtime status.
  const [availableCliNames, setAvailableCliNames] = useState<AgentCli[]>(['kiro']);
  const [runtimeModelOverride, setRuntimeModelOverride] = useState<Record<AgentCli, boolean>>({
    kiro: true,
    claude: true,
    opencode: true,
  });
  const [modelOptions, setModelOptions] = useState<Partial<Record<AgentCli, AgentModel[]>>>({});
  const [runtimeClis, setRuntimeClis] = useState<RuntimeCliStatus[] | null>(null);
  const [globalCliModels, setGlobalCliModels] = useState<CliModels>({});
  // Names of the globally-provided MCP servers (shown for reference in the
  // project MCP editor; the config/secrets are not exposed to project admins).
  const [globalMcpServerNames, setGlobalMcpServerNames] = useState<string[]>([]);
  // The `${VAR}` refs used by each global MCP server, keyed by server name — lets
  // the project editor compute survivors and run the SAME cross-tier collision
  // check the backend does (a flat ref list would false-block a same-name override).
  const [globalMcpServerSecretRefs, setGlobalMcpServerSecretRefs] = useState<
    Record<string, string[]>
  >({});

  // Form state
  const [editAgentCli, setEditAgentCli] = useState<AgentCli>(project.agentCli ?? 'kiro');
  const [savingCli, setSavingCli] = useState(false);
  const [cliResult, setCliResult] = useState<SaveResult>(null);
  const [cliError, setCliError] = useState<string | null>(null);

  const [editCliModels, setEditCliModels] = useState<CliModels>(project.cliModels || {});
  const [editTierModels, setEditTierModels] = useState<TierModels>(project.tierModels || {});
  // Collapsed by default; opens automatically when the project already carries
  // tier overrides so existing configuration is never hidden.
  const [tierOpen, setTierOpen] = useState(
    Object.keys(canonicalTierModels(project.tierModels || {})).length > 0,
  );
  const [savingModels, setSavingModels] = useState(false);
  const [modelsResult, setModelsResult] = useState<SaveResult>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Custom MCP servers (raw JSON string) + custom agent rules (uploaded .md).
  const [customMcpServers, setCustomMcpServers] = useState('{}');
  const [projectMcpSecretsSet, setProjectMcpSecretsSet] = useState<Record<string, boolean>>({});
  const [customRules, setCustomRules] = useState<CustomRule[]>([]);
  const [customMsg, setCustomMsg] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    agentsService
      .getCapabilities(true)
      .then((c) => {
        setAvailableCliNames(c.available);
        if (c.runtimeModelOverride) setRuntimeModelOverride(c.runtimeModelOverride);
        if (c.runtimeClis) setRuntimeClis(c.runtimeClis);
        if (c.models) setModelOptions(c.models);
      })
      .catch(() => {
        /* non-fatal — keep default ['kiro'] and empty model options */
      });
    agentsService
      .getSettings()
      .then((settings) => {
        setGlobalCliModels(settings.cliModels || {});
        setGlobalMcpServerNames(settings.customMcpServerNames || []);
        setGlobalMcpServerSecretRefs(settings.globalMcpServerSecretRefs || {});
      })
      .catch(() => {
        /* non-fatal — placeholders fall back to generic defaults */
      });
  }, []);

  // Load the project's custom MCP servers + custom rules (non-blocking).
  // Restricted to owners/admins on the backend, so only fetch when canEdit.
  useEffect(() => {
    if (!canEdit) return;
    Promise.all([
      projectsService.getCustomMcpServers(project.id).catch(() => ({ customMcpServers: '{}' })),
      projectsService.getCustomRules(project.id).catch(() => ({ customRules: [] })),
      projectsService.getMcpSecrets(project.id).catch(() => ({ mcpSecretsSet: {} })),
    ]).then(([mcpResp, rulesResp, secretsResp]) => {
      setCustomMcpServers(mcpResp.customMcpServers ?? '{}');
      setCustomRules(rulesResp.customRules ?? []);
      setProjectMcpSecretsSet(secretsResp.mcpSecretsSet ?? {});
    });
  }, [project.id, canEdit]);

  // Is a CLI usable for a run? Prefer the v2 runtime's truth (installed + authed);
  // fall back to the ECS-pool-derived list when the runtime hasn't reported.
  const isCliAvailable = (cli: AgentCli): boolean => {
    if (runtimeClis) return runtimeClis.find((c) => c.cli === cli)?.available ?? false;
    return availableCliNames.includes(cli);
  };
  const cliUnavailableReason = (cli: AgentCli): string | null => {
    const rt = runtimeClis?.find((c) => c.cli === cli);
    if (!rt) return isCliAvailable(cli) ? null : 'not available';
    if (rt.available) return null;
    if (!rt.installed) return 'not installed';
    if (!rt.authed) return 'no credentials';
    return 'not available';
  };
  // The model that will actually run for the SELECTED CLI: the project override,
  // else the Admin global default, else the CLI's own default.
  const effectiveModelFor = (cli: AgentCli): string =>
    editCliModels[cli] ||
    globalCliModels[cli] ||
    (cli === 'kiro' ? 'auto (Kiro default)' : 'Admin/runtime default');

  // How many tier cells this project overrides — shown on the collapsed
  // disclosure so the deviation from the Admin config is visible at a glance.
  const tierOverrideCount = Object.values(canonicalTierModels(editTierModels)).reduce(
    (n, row) => n + Object.keys(row ?? {}).length,
    0,
  );

  const saveCli = async () => {
    if (editAgentCli === project.agentCli) return;
    setSavingCli(true);
    setCliResult(null);
    try {
      await projectsService.update(project.id, { agentCli: editAgentCli });
      onProjectUpdated({ agentCli: editAgentCli });
      invalidateProjects();
      setCliResult('saved');
    } catch (err) {
      setCliError(err instanceof Error ? err.message : 'Failed to update agent CLI');
      setCliResult('error');
    } finally {
      setSavingCli(false);
      setTimeout(() => setCliResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  const saveModels = async () => {
    setSavingModels(true);
    setModelsResult(null);
    try {
      const saved = await projectsService.update(project.id, {
        cliModels: editCliModels,
        tierModels: canonicalTierModels(editTierModels),
      });
      const nextModels = saved.cliModels || editCliModels;
      const nextTierModels = saved.tierModels || canonicalTierModels(editTierModels);
      setEditCliModels(nextModels);
      setEditTierModels(nextTierModels);
      onProjectUpdated({ cliModels: nextModels, tierModels: nextTierModels });
      setModelsResult('saved');
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : 'Failed to update model override');
      setModelsResult('error');
    } finally {
      setSavingModels(false);
      setTimeout(() => setModelsResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  const saveCustomMcpServers = async (value: string) => {
    await projectsService.updateCustomMcpServers(project.id, value);
    setCustomMcpServers(value);
  };

  const saveProjectMcpSecrets = async (secrets: Record<string, string>) => {
    await projectsService.updateMcpSecrets(project.id, secrets);
    const fresh = await projectsService
      .getMcpSecrets(project.id)
      .catch(() => ({ mcpSecretsSet: {} as Record<string, boolean> }));
    setProjectMcpSecretsSet(fresh.mcpSecretsSet ?? {});
  };

  const presignCustomRules = (docs: Array<{ filename: string }>) =>
    projectsService.presignCustomRules(project.id, docs);

  const commitCustomRules = (docs: Array<{ filename: string }>) =>
    projectsService.commitCustomRules(project.id, docs);

  const refreshCustomRules = async () => {
    const refreshed = await projectsService.getCustomRules(project.id);
    setCustomRules(refreshed.customRules ?? []);
  };

  return (
    <div className="space-y-6">
      <SettingsCard
        icon={<Bot />}
        title="Agent CLI"
        badge={
          <ConfigStatusBadge
            ok={isCliAvailable(project.agentCli ?? 'kiro')}
            okLabel={AGENT_CLI_CONFIG[project.agentCli ?? 'kiro'].label}
            notOkLabel={`${AGENT_CLI_CONFIG[project.agentCli ?? 'kiro'].label} · unavailable`}
            notOkTone="warning"
          />
        }
        description="Which AI agent CLI runs this project's work — only CLIs installed in the deployment are selectable."
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              Object.entries(AGENT_CLI_CONFIG) as [AgentCli, (typeof AGENT_CLI_CONFIG)[AgentCli]][]
            ).map(([key, cfg]) => {
              const isAvailable = isCliAvailable(key);
              const unavailableReason = cliUnavailableReason(key);
              const isSelected = editAgentCli === key;
              const isCurrent = project.agentCli === key;
              const isSelectable = (isAvailable || isCurrent) && canEdit && !savingCli;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => isSelectable && setEditAgentCli(key)}
                  disabled={!isSelectable}
                  className={cn(
                    'relative rounded-xl border p-3.5 text-left transition-all',
                    isSelected
                      ? 'border-primary/60 bg-primary/[0.04] shadow-sm ring-1 ring-primary/40'
                      : isSelectable
                        ? 'border-border hover:border-primary/25 hover:bg-muted/40'
                        : 'border-border bg-muted/40 opacity-60 cursor-not-allowed',
                  )}
                >
                  {isSelected && (
                    <CheckCircle2 className="absolute right-3 top-3 h-4 w-4 text-primary" />
                  )}
                  <p className="text-xs font-semibold text-foreground">{cfg.label}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {cfg.description}
                  </p>
                  {!isAvailable && (
                    <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-agent-warning/15 px-2 py-0.5 text-[10px] font-medium leading-4 text-amber-600 dark:text-amber-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      {unavailableReason ?? 'not available'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {canEdit ? (
            <SaveStatusButton
              onClick={saveCli}
              disabled={editAgentCli === project.agentCli}
              saving={savingCli}
              label="Save Agent CLI"
              result={cliResult}
              errorMessage={cliError}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Only owners and admins can change the agent CLI.
            </p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        icon={<Cpu />}
        title="Model Override"
        description="Optional project-specific model — otherwise the Admin global default, then the CLI's own default."
      >
        <div className="space-y-4">
          <div className="space-y-3">
            {MODEL_CLI_KEYS.map((cli) => {
              const isSelected = editAgentCli === cli;
              const isEditable = canEdit && isSelected && runtimeModelOverride[cli];
              const options = modelOptions[cli] ?? [];
              const current = editCliModels[cli] || '';
              // The discovered list may not include a previously-saved custom
              // id; surface it so the dropdown can still show + keep it.
              const optionIds = new Set(options.map((o) => o.id));
              const extraOption: AgentModel[] =
                current && !optionIds.has(current)
                  ? [{ id: current, name: `${current} (custom)` }]
                  : [];
              const defaultLabel = globalCliModels[cli]
                ? `Default — global (${globalCliModels[cli]})`
                : cli === 'kiro'
                  ? 'Default — Kiro auto'
                  : 'Default — runtime';
              return (
                <div key={cli} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`model-${cli}`} className="text-xs">
                        {MODEL_CLI_LABELS[cli]}
                      </Label>
                      {isSelected && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium leading-4 text-primary">
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                          selected
                        </span>
                      )}
                    </div>
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
                  {options.length > 0 ? (
                    <Select
                      value={current || MODEL_DEFAULT_SENTINEL}
                      onValueChange={(v) =>
                        setEditCliModels((cur) => ({
                          ...cur,
                          [cli]: v === MODEL_DEFAULT_SENTINEL ? '' : v,
                        }))
                      }
                      disabled={!isEditable || savingModels}
                    >
                      <SelectTrigger id={`model-${cli}`} className="text-sm">
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
                    // Fallback to free-text when the model list couldn't be
                    // discovered (runtime unreachable / no Bedrock access).
                    <Input
                      id={`model-${cli}`}
                      value={current}
                      onChange={(e) =>
                        setEditCliModels((cur) => ({
                          ...cur,
                          [cli]: e.target.value,
                        }))
                      }
                      placeholder={
                        globalCliModels[cli] ? `Default: ${globalCliModels[cli]}` : 'Default'
                      }
                      className="font-mono text-sm h-9"
                      disabled={!isEditable || savingModels}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {/* Effective readout — what will actually run for the selected CLI. */}
          <div className="rounded-lg bg-muted/40 px-3.5 py-2.5 text-xs">
            <span className="text-muted-foreground">Effective for this project: </span>
            <span className="font-mono font-medium">
              {AGENT_CLI_CONFIG[editAgentCli]?.label ?? editAgentCli}
            </span>
            <span className="text-muted-foreground"> · </span>
            <span className="font-mono">{effectiveModelFor(editAgentCli)}</span>
          </div>
          {/* Per-tier overrides — win row/CLI-wise over the Admin tier config. */}
          <div className="border-t pt-3">
            <Collapsible open={tierOpen} onOpenChange={setTierOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  data-testid="project-tier-overrides-toggle"
                  className="flex w-full items-center gap-1.5 text-left"
                >
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                      tierOpen && 'rotate-90',
                    )}
                  />
                  <span className="text-sm font-medium text-foreground">Per-tier overrides</span>
                  <span className="text-xs text-muted-foreground">
                    {tierOverrideCount > 0 ? `${tierOverrideCount} set` : 'optional'}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-2 pt-3">
                  <p className="text-xs text-muted-foreground">
                    Pin a different model for a specific agent tier in this project — unset cells
                    inherit the Admin configuration.
                  </p>
                  <TierModelsSection
                    value={editTierModels}
                    onChange={setEditTierModels}
                    modelOptions={modelOptions}
                    modelsLoaded={runtimeClis !== null || Object.keys(modelOptions).length > 0}
                    disabled={!canEdit || savingModels}
                    idPrefix="project"
                    inheritedModels={{ ...globalCliModels, ...editCliModels }}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
          {canEdit ? (
            <SaveStatusButton
              onClick={saveModels}
              saving={savingModels}
              label="Save Model"
              result={modelsResult}
              errorMessage={modelsError}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Only owners and admins can change model overrides.
            </p>
          )}
        </div>
      </SettingsCard>

      {/* Custom MCP servers + rules — owner/admin only (read is restricted). */}
      {canEdit && (
        <>
          <CustomMcpServersSection
            value={customMcpServers}
            onChange={setCustomMcpServers}
            onSave={saveCustomMcpServers}
            canEdit={canEdit}
            globalServerNames={globalMcpServerNames}
            projectId={project.id}
            mcpSecretsSet={projectMcpSecretsSet}
            onSaveSecrets={saveProjectMcpSecrets}
            globalServerSecretRefs={globalMcpServerSecretRefs}
            description="Custom MCP servers injected into this project's agent sessions."
          />

          {customMsg && (
            <p
              className={cn(
                'text-xs',
                customMsg.kind === 'success' ? 'text-agent-success' : 'text-destructive',
              )}
            >
              {customMsg.text}
            </p>
          )}
          <CustomRulesSection
            docs={customRules}
            onPresign={presignCustomRules}
            onCommit={commitCustomRules}
            onRefresh={refreshCustomRules}
            canEdit={canEdit}
            description="Markdown documents loaded into the agent context for every stage in this project (coding standards, API references, framework guidelines, etc.)."
            onSuccess={(text) => setCustomMsg({ kind: 'success', text })}
            onError={(text) => setCustomMsg({ kind: 'error', text })}
            onClearMessages={() => setCustomMsg(null)}
          />
        </>
      )}
    </div>
  );
}
