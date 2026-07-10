// Stage Skipping card — the platform-wide toggle for per-intent stage
// skipping: deselecting CONDITIONAL stages at intent creation and the
// "skip to stage X" option on validation gates. Disabled by default —
// skipping bypasses parts of the methodology, so an operator must opt in.
//
// Only CONDITIONAL stages are ever skippable (upstream rule — the same one
// the construction fan-out's per-unit skip matrix enforces); ALWAYS and
// initialization stages always run. Projects can override this platform
// value in their own settings. The effective value is snapshotted onto each
// intent at create, so a flip applies to the NEXT intent — never a run
// mid-flight.

import { useEffect, useState } from 'react';
import { SkipForward } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { agentsService } from '@/services/agents';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

type Mode = 'enabled' | 'disabled';

export function StageSkippingCard() {
  const [savedMode, setSavedMode] = useState<Mode>('disabled');
  const [mode, setMode] = useState<Mode>('disabled');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);

  useEffect(() => {
    agentsService
      .getSettings()
      .then((s) => {
        const value: Mode = s.stageSkipping === 'enabled' ? 'enabled' : 'disabled';
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
      await agentsService.updateSettings({ stageSkipping: mode });
      setSavedMode(mode);
      setSaveResult('saved');
    } catch (e) {
      console.error('Failed to save stage skipping mode:', e);
      setSaveResult('error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  return (
    <SettingsCard
      icon={<SkipForward />}
      title="Stage Skipping"
      description="Let users skip CONDITIONAL workflow stages — deselect them when creating an intent, or jump ahead from a stage's approval gate."
    >
      {loading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="stage-skipping-switch" className="text-xs font-medium">
                Allow per-intent stage skipping
              </label>
              <p className="text-[11px] text-muted-foreground">
                Only CONDITIONAL stages are skippable — required stages (requirements analysis, code
                generation, build &amp; test, …) and initialization always run. Downstream stages
                treat a skipped stage&apos;s outputs as absent by design. Projects can override this
                in their settings; applies to intents created after saving.
              </p>
            </div>
            <Switch
              id="stage-skipping-switch"
              checked={mode === 'enabled'}
              onCheckedChange={(checked) => setMode(checked ? 'enabled' : 'disabled')}
            />
          </div>
          <SaveStatusButton
            onClick={save}
            disabled={mode === savedMode}
            saving={saving}
            label="Save Stage Skipping"
            result={saveResult}
          />
        </div>
      )}
    </SettingsCard>
  );
}
