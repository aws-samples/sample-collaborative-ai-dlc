// Agent CLIs card — platform-wide enable/disable switch per agent CLI.
//
// A disabled CLI is not offered for new intents (compose page), DRAFT compose
// or discussion assists, or as a space's recommended CLI; the backend rejects
// selecting it with `agent_cli_disabled`. Intents that already pinned a CLI keep
// running on it. At least one CLI must stay enabled.

import { useEffect, useState } from 'react';
import { Terminal } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { agentsService } from '@/services/agents';
import type { AgentCli } from '@/services/projects';
import { AGENT_CLIS, AGENT_CLI_METADATA } from '@/lib/agentCli';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

const sameSet = (a: AgentCli[], b: AgentCli[]) =>
  a.length === b.length && a.every((cli) => b.includes(cli));

export function AgentClisCard() {
  const [savedDisabled, setSavedDisabled] = useState<AgentCli[]>([]);
  const [disabled, setDisabled] = useState<AgentCli[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Without the stored list, saving would overwrite it with whatever the
  // form shows (everything enabled), so a failed load blocks saving.
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    agentsService
      .getSettings()
      .then((s) => {
        const value = (s.disabledClis ?? []).filter((cli) => AGENT_CLIS.includes(cli));
        setSavedDisabled(value);
        setDisabled(value);
      })
      .catch((e) => {
        console.error('Failed to load agent settings:', e);
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  }, []);

  const enabledCount = AGENT_CLIS.length - disabled.length;

  const toggle = (cli: AgentCli, enabled: boolean) =>
    setDisabled((prev) =>
      enabled ? prev.filter((c) => c !== cli) : prev.includes(cli) ? prev : [...prev, cli],
    );

  const save = async () => {
    setSaving(true);
    setSaveResult(null);
    setSaveError(null);
    try {
      const next = AGENT_CLIS.filter((cli) => disabled.includes(cli));
      await agentsService.updateSettings({ disabledClis: next });
      setSavedDisabled(next);
      setDisabled(next);
      setSaveResult('saved');
    } catch (e) {
      console.error('Failed to save agent CLI availability:', e);
      setSaveError(e instanceof Error ? e.message : 'Failed to save agent CLIs');
      setSaveResult('error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  return (
    <SettingsCard
      icon={<Terminal />}
      title="Agent CLIs"
      description="Choose which agent CLIs users can select for new intents across the platform."
    >
      {loading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="space-y-3">
            {AGENT_CLIS.map((cli) => {
              const enabled = !disabled.includes(cli);
              const isLastEnabled = enabled && enabledCount === 1;
              const id = `agent-cli-enabled-${cli}`;
              return (
                <div key={cli} className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <label htmlFor={id} className="text-xs font-medium">
                      {AGENT_CLI_METADATA[cli].label}
                    </label>
                    <p className="text-[11px] text-muted-foreground">
                      {AGENT_CLI_METADATA[cli].description}
                      {isLastEnabled ? ' — at least one CLI must stay enabled.' : ''}
                    </p>
                  </div>
                  <Switch
                    id={id}
                    checked={enabled}
                    disabled={saving || loadFailed || isLastEnabled}
                    onCheckedChange={(checked) => toggle(cli, checked)}
                  />
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Disabled CLIs can&apos;t be selected when starting or composing an intent, or as a
            space&apos;s recommended CLI. Intents that already started keep their CLI.
          </p>
          {loadFailed && (
            <p role="alert" className="text-[11px] text-destructive">
              Couldn&apos;t load the current CLI settings. Reload the page before saving.
            </p>
          )}
          <SaveStatusButton
            onClick={save}
            disabled={loadFailed || sameSet(disabled, savedDisabled)}
            saving={saving}
            label="Save Agent CLIs"
            result={saveResult}
            errorMessage={saveError}
          />
        </div>
      )}
    </SettingsCard>
  );
}
