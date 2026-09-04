import { useEffect, useState } from 'react';
import { GitPullRequestArrow } from 'lucide-react';
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

type PlatformPrStrategy = NonNullable<AgentSettings['prStrategy']>;

export function PrStrategyCard() {
  const [saved, setSaved] = useState<PlatformPrStrategy>('intent-pr');
  const [value, setValue] = useState<PlatformPrStrategy>('intent-pr');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agentsService
      .getSettings()
      .then((settings) => {
        const strategy = settings.prStrategy ?? 'intent-pr';
        setSaved(strategy);
        setValue(strategy);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load setting'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setResult(null);
    setError(null);
    try {
      await agentsService.updateSettings({ prStrategy: value });
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
      icon={<GitPullRequestArrow />}
      title="Pull request delivery"
      description="Default delivery strategy for spaces that inherit the platform setting."
    >
      {loading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <div className="space-y-3">
          <Select
            value={value}
            onValueChange={(next) => setValue(next as PlatformPrStrategy)}
            disabled={saving}
          >
            <SelectTrigger aria-label="Platform PR strategy" className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="intent-pr">Intent PR</SelectItem>
              <SelectItem value="pr-per-unit">PR per unit</SelectItem>
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
