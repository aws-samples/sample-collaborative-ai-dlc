import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, KeyRound } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  agentsService,
  type AgentCredentialStatus,
  type SpaceAgentCredentialStatus,
} from '@/services/agents';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SecretField } from '@/components/settings/SecretField';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

type Scope = 'platform' | 'space' | 'personal';
type SecretName = 'bedrockBearerToken' | 'kiroApiKey';

interface Props {
  scope: Scope;
  projectId?: string;
}

const COPY: Record<Scope, { title: string; description: string }> = {
  platform: {
    title: 'Platform Agent Credentials',
    description: 'Fallback credentials used when no personal or space credential is configured.',
  },
  space: {
    title: 'Space Agent Credentials',
    description: 'Used for members without a personal credential; overrides the platform fallback.',
  },
  personal: {
    title: 'Personal Agent Credentials',
    description: 'Used for your agent runs in every space and overrides space and platform keys.',
  },
};

export function AgentCredentialScopeCard({ scope, projectId }: Props) {
  const [settings, setSettings] = useState<AgentCredentialStatus | null>(null);
  const [platformFallback, setPlatformFallback] = useState<AgentCredentialStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [bearerToken, setBearerToken] = useState('');
  const [kiroApiKey, setKiroApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearingSecret, setClearingSecret] = useState<SecretName | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (scope === 'platform') {
      const result = await agentsService.getSettings();
      setSettings(result);
      setPlatformFallback(null);
      return;
    }
    if (scope === 'personal') {
      setSettings(await agentsService.getPersonalCredentials());
      setPlatformFallback(null);
      return;
    }
    if (!projectId) throw new Error('projectId is required for space credentials');
    const result: SpaceAgentCredentialStatus = await agentsService.getProjectCredentials(projectId);
    setSettings(result);
    setPlatformFallback(result.platformFallback);
  }, [projectId, scope]);

  useEffect(() => {
    setLoading(true);
    setSettings(null);
    setPlatformFallback(null);
    setErrorMessage(null);
    load()
      .catch((error) => {
        console.error(`Failed to load ${scope} agent credentials:`, error);
        setErrorMessage(
          error instanceof Error ? error.message : 'Failed to load agent credentials',
        );
      })
      .finally(() => setLoading(false));
  }, [load, scope]);

  const update = async (value: { bedrockBearerToken?: string; kiroApiKey?: string }) => {
    if (scope === 'platform') return agentsService.updateSettings(value);
    if (scope === 'personal') return agentsService.updatePersonalCredentials(value);
    if (!projectId) throw new Error('projectId is required for space credentials');
    return agentsService.updateProjectCredentials(projectId, value);
  };

  const hasChanges = bearerToken !== '' || kiroApiKey !== '';

  const save = async () => {
    setSaving(true);
    setSaveResult(null);
    setErrorMessage(null);
    try {
      const value: { bedrockBearerToken?: string; kiroApiKey?: string } = {};
      if (bearerToken !== '') value.bedrockBearerToken = bearerToken;
      if (kiroApiKey !== '') value.kiroApiKey = kiroApiKey;
      await update(value);
      await load();
      setBearerToken('');
      setKiroApiKey('');
      setSaveResult('saved');
    } catch (error) {
      console.error(`Failed to save ${scope} agent credentials:`, error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save agent credentials');
      setSaveResult('error');
    } finally {
      setSaving(false);
      window.setTimeout(
        () => setSaveResult((current) => (current === 'saved' ? null : current)),
        4000,
      );
    }
  };

  const clearSecret = async (field: SecretName) => {
    setClearingSecret(field);
    setSaveResult(null);
    setErrorMessage(null);
    try {
      await update({ [field]: '' });
      await load();
      if (field === 'bedrockBearerToken') setBearerToken('');
      else setKiroApiKey('');
      setSaveResult('saved');
    } catch (error) {
      console.error(`Failed to clear ${scope} agent credential:`, error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to clear agent credential');
      setSaveResult('error');
    } finally {
      setClearingSecret(null);
      window.setTimeout(
        () => setSaveResult((current) => (current === 'saved' ? null : current)),
        4000,
      );
    }
  };

  const configuredCount =
    Number(Boolean(settings?.bedrockBearerTokenSet)) + Number(Boolean(settings?.kiroApiKeySet));
  const fallbackText = (provider: 'bedrock' | 'kiro') => {
    if (scope !== 'space') return null;
    const available =
      provider === 'bedrock'
        ? platformFallback?.bedrockBearerTokenSet
        : platformFallback?.kiroApiKeySet;
    return available ? ' A platform fallback is available.' : ' No platform fallback is set.';
  };

  return (
    <SettingsCard
      icon={<KeyRound />}
      title={COPY[scope].title}
      description={COPY[scope].description}
      badge={
        !loading && (
          <ConfigStatusBadge
            ok={configuredCount > 0}
            okLabel={`${configuredCount} provider${configuredCount === 1 ? '' : 's'} configured`}
            notOkLabel="No credentials"
            notOkTone="warning"
          />
        )
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="mt-4 h-4 w-40" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : !settings && errorMessage ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5"
        >
          <p className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {errorMessage}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              setErrorMessage(null);
              load()
                .catch((error) =>
                  setErrorMessage(
                    error instanceof Error ? error.message : 'Failed to load agent credentials',
                  ),
                )
                .finally(() => setLoading(false));
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <SecretField
            id={`${scope}-bedrock-bearer-token`}
            label="Bedrock Bearer Token"
            isSet={Boolean(settings?.bedrockBearerTokenSet)}
            value={bearerToken}
            onChange={setBearerToken}
            emptyPlaceholder="Enter AWS_BEARER_TOKEN_BEDROCK value"
            rotatePlaceholder="Enter a new token to rotate, or leave blank"
            onClear={() => clearSecret('bedrockBearerToken')}
            clearing={clearingSecret === 'bedrockBearerToken'}
            disabled={saving || clearingSecret !== null}
            helpText={`Enables Claude Code, OpenCode and Codex.${fallbackText('bedrock') ?? ''}`}
          />
          <SecretField
            id={`${scope}-kiro-api-key`}
            label="Kiro API Key"
            isSet={Boolean(settings?.kiroApiKeySet)}
            value={kiroApiKey}
            onChange={setKiroApiKey}
            emptyPlaceholder="Enter KIRO_API_KEY value"
            rotatePlaceholder="Enter a new key to rotate, or leave blank"
            onClear={() => clearSecret('kiroApiKey')}
            clearing={clearingSecret === 'kiroApiKey'}
            disabled={saving || clearingSecret !== null}
            helpText={`Enables the Kiro CLI.${fallbackText('kiro') ?? ''}`}
          />
          <SaveStatusButton
            onClick={save}
            disabled={!hasChanges || clearingSecret !== null}
            saving={saving}
            label="Save Credentials"
            result={saveResult}
            errorMessage={errorMessage}
          />
        </div>
      )}
    </SettingsCard>
  );
}
