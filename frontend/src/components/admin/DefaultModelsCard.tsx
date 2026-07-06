// Default agent models card — per-CLI default model IDs used when a project
// doesn't set its own override. Extracted from the old monolithic Admin page.

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Cpu, ExternalLink } from 'lucide-react';
import { agentsService } from '@/services/agents';
import type { CliModels, RuntimeModelCli } from '@/services/projects';
import { AdminCard } from './shared/AdminCard';
import { SaveStatusButton, type SaveResult } from './shared/SaveStatusButton';

const MODEL_CLI_LABELS: Record<RuntimeModelCli, string> = {
  kiro: 'Kiro',
  claude: 'Claude',
  opencode: 'OpenCode',
};

const MODEL_CLI_KEYS = Object.keys(MODEL_CLI_LABELS) as RuntimeModelCli[];

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);

  useEffect(() => {
    agentsService
      .getSettings()
      .then((s) => {
        setSavedModels(s.cliModels || {});
        setCliModels(s.cliModels || {});
      })
      .catch((e) => console.error('Failed to load agent settings:', e))
      .finally(() => setLoading(false));
  }, []);

  const hasChanges =
    JSON.stringify(canonicalCliModels(cliModels)) !==
    JSON.stringify(canonicalCliModels(savedModels));

  const save = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      await agentsService.updateSettings({ cliModels });
      const fresh = await agentsService.getSettings();
      setSavedModels(fresh.cliModels || {});
      setCliModels(fresh.cliModels || {});
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
    <AdminCard
      icon={<Cpu />}
      title="Default Models"
      description="Fallback model per CLI when a project sets no override — applies to new agent runs."
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {MODEL_CLI_KEYS.map((cli) => (
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
                <Input
                  id={`default-model-${cli}`}
                  value={cliModels[cli] || ''}
                  onChange={(e) =>
                    setCliModels((current) => ({ ...current, [cli]: e.target.value }))
                  }
                  placeholder={MODEL_PLACEHOLDERS[cli]}
                  className="font-mono text-sm h-9"
                />
              </div>
            ))}
          </div>
          <SaveStatusButton
            onClick={save}
            disabled={!hasChanges}
            saving={saving}
            label="Save Models"
            result={saveResult}
          />
        </div>
      )}
    </AdminCard>
  );
}
