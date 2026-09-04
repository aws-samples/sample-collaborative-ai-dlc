// Composer card — the platform-wide toggle for the composer's deterministic
// keyword bypass. When enabled (the default) an intent whose text cleanly
// matches exactly ONE stock scope's keywords is composed without any LLM
// call; disabling it routes every compose through the composer agent (useful
// when keyword vocabularies overlap or scopes were heavily customized).

import { useEffect, useState } from 'react';
import { Wand2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { agentsService } from '@/services/agents';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

type Mode = 'enabled' | 'disabled';

export function ComposerCard() {
  const [savedMode, setSavedMode] = useState<Mode>('enabled');
  const [mode, setMode] = useState<Mode>('enabled');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);

  useEffect(() => {
    agentsService
      .getSettings()
      .then((s) => {
        const value: Mode = s.composeLlmBypass === 'disabled' ? 'disabled' : 'enabled';
        setSavedMode(value);
        setMode(value);
      })
      .catch((e) => console.error('Failed to load agent settings:', e))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      await agentsService.updateSettings({ composeLlmBypass: mode });
      setSavedMode(mode);
      setSaveResult('saved');
    } catch (e) {
      console.error('Failed to save composer bypass mode:', e);
      setSaveResult('error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  return (
    <SettingsCard
      icon={<Wand2 />}
      title="Composer"
      description="How intent composition picks a workflow projection: deterministic keyword matching first, or always the composer agent."
    >
      {loading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="compose-bypass-switch" className="text-xs font-medium">
                Deterministic keyword bypass
              </label>
              <p className="text-[11px] text-muted-foreground">
                When on, an intent whose text cleanly matches exactly one stock scope&apos;s
                keywords is composed without an LLM call. Turn off to route every compose through
                the composer agent. Either way, proposals are re-validated by the plan resolver and
                applied only after human approval.
              </p>
            </div>
            <Switch
              id="compose-bypass-switch"
              checked={mode === 'enabled'}
              onCheckedChange={(checked) => setMode(checked ? 'enabled' : 'disabled')}
            />
          </div>
          <SaveStatusButton
            onClick={save}
            disabled={mode === savedMode}
            saving={saving}
            label="Save Composer Settings"
            result={saveResult}
          />
        </div>
      )}
    </SettingsCard>
  );
}
