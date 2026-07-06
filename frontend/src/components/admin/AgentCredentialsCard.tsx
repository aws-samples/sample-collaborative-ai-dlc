// Agent credentials card — Bedrock bearer token + Kiro API key, stored in AWS
// SSM Parameter Store (write-only from the browser). Extracted from the old
// monolithic Admin page.

import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { KeyRound } from 'lucide-react';
import { agentsService, type AgentSettings } from '@/services/agents';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SecretField } from '@/components/settings/SecretField';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

type SecretName = 'bedrockBearerToken' | 'kiroApiKey';

export function AgentCredentialsCard() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [bearerToken, setBearerToken] = useState('');
  const [kiroApiKey, setKiroApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearingSecret, setClearingSecret] = useState<SecretName | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);

  useEffect(() => {
    agentsService
      .getSettings()
      .then(setSettings)
      .catch((e) => console.error('Failed to load agent settings:', e))
      .finally(() => setLoading(false));
  }, []);

  const hasChanges = bearerToken !== '' || kiroApiKey !== '';

  const save = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      const update: { bedrockBearerToken?: string; kiroApiKey?: string } = {};
      // Only send secret fields the user actually typed.
      if (bearerToken !== '') update.bedrockBearerToken = bearerToken;
      if (kiroApiKey !== '') update.kiroApiKey = kiroApiKey;
      await agentsService.updateSettings(update);
      const fresh = await agentsService.getSettings();
      setSettings(fresh);
      setBearerToken('');
      setKiroApiKey('');
      setSaveResult('saved');
    } catch (e) {
      console.error('Failed to save agent credentials:', e);
      setSaveResult('error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  // Clear a stored secret by sending an empty string; the backend resets the
  // SSM parameter to its "placeholder" sentinel (treated as not configured).
  const clearSecret = async (field: SecretName) => {
    setClearingSecret(field);
    setSaveResult(null);
    try {
      await agentsService.updateSettings({ [field]: '' });
      const fresh = await agentsService.getSettings();
      setSettings(fresh);
      if (field === 'bedrockBearerToken') setBearerToken('');
      else setKiroApiKey('');
      setSaveResult('saved');
    } catch (e) {
      console.error('Failed to clear secret:', e);
      setSaveResult('error');
    } finally {
      setClearingSecret(null);
      setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  const bothSet = !!settings?.bedrockBearerTokenSet && !!settings?.kiroApiKeySet;

  return (
    <SettingsCard
      icon={<KeyRound />}
      title="Agent Credentials"
      badge={
        !loading && (
          <ConfigStatusBadge
            ok={bothSet}
            okLabel="All set"
            notOkLabel={settings?.bedrockBearerTokenSet ? 'Kiro key missing' : 'Setup needed'}
            notOkTone={settings?.bedrockBearerTokenSet ? 'neutral' : 'warning'}
          />
        )
      }
      description="Stored in AWS SSM Parameter Store — applied on the next agent start."
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-4 w-40 mt-4" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <div className="space-y-5">
          <SecretField
            id="bedrock-bearer-token"
            label="Bedrock Bearer Token"
            isSet={!!settings?.bedrockBearerTokenSet}
            notSetLabel="Required"
            value={bearerToken}
            onChange={setBearerToken}
            emptyPlaceholder="Enter AWS_BEARER_TOKEN_BEDROCK value"
            rotatePlaceholder="Enter new token to rotate, or leave blank"
            onClear={() => clearSecret('bedrockBearerToken')}
            clearing={clearingSecret === 'bedrockBearerToken'}
            disabled={saving || clearingSecret !== null}
            helpText={
              <>
                Used by Claude Code and OpenCode agents as{' '}
                <code className="bg-muted px-1 rounded text-[10px]">AWS_BEARER_TOKEN_BEDROCK</code>{' '}
                — without it they won't start.
              </>
            }
          />
          <SecretField
            id="kiro-api-key"
            label="Kiro API Key"
            isSet={!!settings?.kiroApiKeySet}
            value={kiroApiKey}
            onChange={setKiroApiKey}
            emptyPlaceholder="Enter KIRO_API_KEY value"
            rotatePlaceholder="Enter new key to rotate, or leave blank"
            onClear={() => clearSecret('kiroApiKey')}
            clearing={clearingSecret === 'kiroApiKey'}
            disabled={saving || clearingSecret !== null}
            helpText="Required for the Kiro CLI — from your Kiro account settings."
          />
          <SaveStatusButton
            onClick={save}
            disabled={!hasChanges || clearingSecret !== null}
            saving={saving}
            label="Save Credentials"
            result={saveResult}
          />
        </div>
      )}
    </SettingsCard>
  );
}
