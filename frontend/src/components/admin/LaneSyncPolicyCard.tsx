import { useEffect, useState } from 'react';
import { GitMerge } from 'lucide-react';
import { agentsService, type AgentSettings } from '@/services/agents';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { Skeleton } from '@/components/ui/skeleton';

type PlatformLaneSyncPolicy = NonNullable<AgentSettings['laneSyncPolicy']>;

export function LaneSyncPolicyCard() {
  const [saved, setSaved] = useState<PlatformLaneSyncPolicy>('none');
  const [value, setValue] = useState<PlatformLaneSyncPolicy>('none');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agentsService
      .getSettings()
      .then((settings) => {
        const policy = settings.laneSyncPolicy === 'before-stage' ? 'before-stage' : 'none';
        setSaved(policy);
        setValue(policy);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load setting'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setResult(null);
    setError(null);
    try {
      await agentsService.updateSettings({ laneSyncPolicy: value });
      setSaved(value);
      setResult('saved');
    } catch (err) {
      setResult('error');
      setError(err instanceof Error ? err.message : 'Failed to save setting');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={<GitMerge />}
      title="Lane sync"
      description="Whether a unit lane takes the intent branch's latest changes before each stage, for spaces that inherit the platform setting."
    >
      {loading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <div className="space-y-3">
          <Select
            value={value}
            onValueChange={(next) => setValue(next as PlatformLaneSyncPolicy)}
            disabled={saving}
          >
            <SelectTrigger aria-label="Platform lane sync" className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">At merge-back only</SelectItem>
              <SelectItem value="before-stage">Before each stage</SelectItem>
            </SelectContent>
          </Select>
          <SaveStatusButton
            onClick={save}
            disabled={value === saved}
            saving={saving}
            label="Save default"
            result={result}
            errorMessage={error}
          />
        </div>
      )}
    </SettingsCard>
  );
}
