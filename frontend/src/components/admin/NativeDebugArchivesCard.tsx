import { useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { agentsService } from '@/services/agents';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

type DebugPreferences = { enabled: boolean; days: number };

function readDebugPreferences(settings: unknown): DebugPreferences | null {
  if (!settings || typeof settings !== 'object') return null;
  if (
    !Object.hasOwn(settings, 'nativeDebugArchivesEnabled') ||
    !Object.hasOwn(settings, 'nativeDebugArchiveRetentionDays')
  )
    return null;
  const { nativeDebugArchivesEnabled: enabled, nativeDebugArchiveRetentionDays: days } =
    settings as Record<string, unknown>;
  if (
    typeof enabled !== 'boolean' ||
    typeof days !== 'number' ||
    !Number.isSafeInteger(days) ||
    days < 1
  )
    return null;
  return { enabled, days };
}

export function NativeDebugArchivesCard() {
  const [saved, setSaved] = useState<DebugPreferences | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState('7');
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agentsService
      .getSettings()
      .then((settings) => {
        // Missing fields mean this backend cannot yet save these preferences.
        const next = readDebugPreferences(settings);
        if (!next) return;
        setAvailable(true);
        setSaved(next);
        setEnabled(next.enabled);
        setDays(String(next.days));
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const retentionDays = Number(days);
  const validDays = /^[1-9]\d*$/.test(days) && Number.isSafeInteger(retentionDays);
  const unchanged = saved !== null && enabled === saved.enabled && retentionDays === saved.days;

  const save = async () => {
    if (loading || loadError || !available || saving || !validDays || unchanged) return;
    setSaving(true);
    setResult(null);
    setError(null);
    let putSucceeded = false;
    try {
      await agentsService.updateSettings({
        nativeDebugArchivesEnabled: enabled,
        nativeDebugArchiveRetentionDays: retentionDays,
      });
      putSucceeded = true;
      // Older servers can acknowledge unknown fields without persisting them.
      const verified = readDebugPreferences(await agentsService.getSettings());
      if (!verified || verified.enabled !== enabled || verified.days !== retentionDays) {
        throw new Error('Debug archive preferences did not match the saved request');
      }
      setSaved(verified);
      setResult('saved');
    } catch (err) {
      // A write or readback failure does not prove the previous values remain.
      setSaved(null);
      setResult('error');
      setError(
        putSucceeded
          ? 'Save could not be verified. The server may have changed; your draft is preserved. Reload or retry.'
          : err instanceof Error
            ? err.message
            : 'Failed to save debug archive preferences',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={<Archive />}
      title="Native execution debug archives"
      description="Preferences for optional snapshots and conversation archives used for debugging."
    >
      <div className="space-y-4">
        <p id="native-debug-recovery-note" className="text-xs text-muted-foreground">
          These settings never disable or shorten required recovery for unfinished or resumable
          work. They do not enable native execution.
        </p>
        <p className="text-xs text-muted-foreground">
          Archive capture is not connected yet; these preferences are saved for that integration.
        </p>
        {loading ? (
          <Skeleton className="h-9 w-full" />
        ) : loadError ? (
          <p role="alert" className="text-xs text-destructive">
            Could not load debug archive preferences. Reload this page to try again.
          </p>
        ) : !available ? (
          <p role="alert" className="text-xs text-muted-foreground">
            Native debug archive settings are unavailable from this server. Update the backend
            before editing these preferences.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="native-debug-archives-enabled" className="text-xs font-medium">
                Store native debug archives
              </label>
              <Switch
                id="native-debug-archives-enabled"
                aria-describedby="native-debug-recovery-note"
                checked={enabled}
                disabled={saving}
                onCheckedChange={(next) => {
                  setEnabled(next);
                  setResult(null);
                }}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="native-debug-archive-retention-days" className="text-xs font-medium">
                Debug archive retention (days)
              </label>
              <Input
                id="native-debug-archive-retention-days"
                className="max-w-40"
                type="number"
                min={1}
                step={1}
                value={days}
                disabled={saving}
                aria-invalid={!validDays}
                aria-describedby={`native-debug-retention-note${validDays ? '' : ' native-debug-retention-error'}`}
                onChange={(event) => {
                  setDays(event.target.value);
                  setResult(null);
                }}
              />
              <p id="native-debug-retention-note" className="text-xs text-muted-foreground">
                Saved even while debug archiving is off. Applies only to optional debug archives.
              </p>
              {!validDays && (
                <p
                  id="native-debug-retention-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  Enter a positive whole number of days.
                </p>
              )}
            </div>
            <SaveStatusButton
              onClick={save}
              disabled={!validDays || unchanged}
              saving={saving}
              label="Save debug archive preferences"
              result={result}
              errorMessage={error}
            />
          </>
        )}
      </div>
    </SettingsCard>
  );
}
