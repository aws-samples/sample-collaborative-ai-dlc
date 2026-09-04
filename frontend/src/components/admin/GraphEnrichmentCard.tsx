// Graph enrichment card — the derive-time LLM summary toggle. When enabled,
// each approved artifact gets ONE bounded one-shot summary call through the
// already-configured agent CLI (same credentials/model selection as stage
// runs — no separate inference path). Deterministic graph topology is
// unaffected either way; the toggle only adds/withholds summary metadata.
//
// The value is snapshotted onto each intent at create, so a flip applies to
// the NEXT intent — never a run mid-flight. Usefulness is measurable in the
// intent Audit view (enrichment token spend vs. compact-read adoption).

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { agentsService } from '@/services/agents';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

type Mode = 'off' | 'llm';

export function GraphEnrichmentCard() {
  const [savedMode, setSavedMode] = useState<Mode>('off');
  const [mode, setMode] = useState<Mode>('off');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);

  useEffect(() => {
    agentsService
      .getSettings()
      .then((s) => {
        const value: Mode = s.deriveEnrichment === 'llm' ? 'llm' : 'off';
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
      await agentsService.updateSettings({ deriveEnrichment: mode });
      setSavedMode(mode);
      setSaveResult('saved');
    } catch (e) {
      console.error('Failed to save graph enrichment mode:', e);
      setSaveResult('error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  return (
    <SettingsCard
      icon={<Sparkles />}
      title="Graph Enrichment"
      description="Optional LLM summaries (gist + key claims) on derived graph nodes, generated after each approved artifact."
    >
      {loading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="graph-enrichment-switch" className="text-xs font-medium">
                LLM summaries on derived artifacts
              </label>
              <p className="text-[11px] text-muted-foreground">
                One bounded call per approved artifact via the configured agent CLI — adds model
                cost, never changes graph topology. Applies to intents created after saving; spend
                and impact show up in each intent&apos;s Audit view.
              </p>
            </div>
            <Switch
              id="graph-enrichment-switch"
              checked={mode === 'llm'}
              onCheckedChange={(checked) => setMode(checked ? 'llm' : 'off')}
            />
          </div>
          <SaveStatusButton
            onClick={save}
            disabled={mode === savedMode}
            saving={saving}
            label="Save Enrichment"
            result={saveResult}
          />
        </div>
      )}
    </SettingsCard>
  );
}
