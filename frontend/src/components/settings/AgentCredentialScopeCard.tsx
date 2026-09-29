import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, KeyRound } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  agentsService,
  type AgentCredentialStatus,
  type SpaceAgentCredentialStatus,
  type AgentCredentialUpdate,
  type AgentAuthImpactReview,
} from '@/services/agents';
import { AuthenticationImpactReview } from './AuthenticationImpactReview';
import { AgentAuthenticationModeSettings } from './AgentAuthenticationModeSettings';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SecretField } from '@/components/settings/SecretField';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { agentCredentialFormatWarning } from '@/lib/agentCredentialFormat';
import { ApiError } from '@/services/api';

// Credential storage scopes. Intents pin an opaque binding to one of these;
// they do not store a separate secret.
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
  const identity = `${scope}\0${projectId ?? ''}`;
  const activeIdentityRef = useRef<string | null>(null);
  const isCurrentIdentity = useCallback(() => activeIdentityRef.current === identity, [identity]);
  useLayoutEffect(() => {
    activeIdentityRef.current = identity;
    return () => {
      if (activeIdentityRef.current === identity) activeIdentityRef.current = null;
    };
  }, [identity]);

  const [settings, setSettings] = useState<AgentCredentialStatus | null>(null);
  const [platformFallback, setPlatformFallback] = useState<AgentCredentialStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingReview, setPendingReview] = useState<{
    review: AgentAuthImpactReview;
    update: AgentCredentialUpdate;
  } | null>(null);
  const [bearerToken, setBearerToken] = useState('');
  const [kiroApiKey, setKiroApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearingSecret, setClearingSecret] = useState<SecretName | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isCurrentIdentity()) return false;
    if (scope === 'platform') {
      const result = await agentsService.getSettings();
      if (!isCurrentIdentity()) return false;
      setSettings(result);
      setPlatformFallback(null);
      return true;
    }
    if (scope === 'personal') {
      const result = await agentsService.getPersonalCredentials();
      if (!isCurrentIdentity()) return false;
      setSettings(result);
      setPlatformFallback(null);
      return true;
    }
    if (!projectId) throw new Error('projectId is required for space credentials');
    const result: SpaceAgentCredentialStatus = await agentsService.getProjectCredentials(projectId);
    if (!isCurrentIdentity()) return false;
    setSettings(result);
    setPlatformFallback(result.platformFallback);
    return true;
  }, [isCurrentIdentity, projectId, scope]);

  useEffect(() => {
    setLoading(true);
    setSettings(null);
    setPendingReview(null);
    setPlatformFallback(null);
    setBearerToken('');
    setKiroApiKey('');
    setSaving(false);
    setClearingSecret(null);
    setSaveResult(null);
    setErrorMessage(null);
    load()
      .catch((error) => {
        if (!isCurrentIdentity()) return;
        console.error(`Failed to load ${scope} agent credentials:`, error);
        setErrorMessage(
          error instanceof Error ? error.message : 'Failed to load agent credentials',
        );
      })
      .finally(() => {
        if (isCurrentIdentity()) setLoading(false);
      });
  }, [identity, isCurrentIdentity, load, scope]);

  const update = async (value: AgentCredentialUpdate) => {
    if (settings?.authentication?.reviewRequired && !value.reviewId) {
      const review = await agentsService.previewCredentialUpdate(scope, projectId, value);
      if (isCurrentIdentity()) setPendingReview({ review, update: value });
      return { saved: false };
    }
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
      if (!(await update(value)).saved) return;
      if (!isCurrentIdentity() || !(await load())) return;
      setBearerToken('');
      setKiroApiKey('');
      setSaveResult('saved');
    } catch (error) {
      if (!isCurrentIdentity()) return;
      console.error(`Failed to save ${scope} agent credentials:`, error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save agent credentials');
      setSaveResult('error');
    } finally {
      if (isCurrentIdentity()) {
        setSaving(false);
        window.setTimeout(() => {
          if (isCurrentIdentity()) {
            setSaveResult((current) => (current === 'saved' ? null : current));
          }
        }, 4000);
      }
    }
  };

  const clearSecret = async (field: SecretName) => {
    setClearingSecret(field);
    setSaveResult(null);
    setErrorMessage(null);
    try {
      if (!(await update({ [field]: '' })).saved) return;
      if (!isCurrentIdentity() || !(await load())) return;
      if (field === 'bedrockBearerToken') setBearerToken('');
      else setKiroApiKey('');
      setSaveResult('saved');
    } catch (error) {
      if (!isCurrentIdentity()) return;
      console.error(`Failed to clear ${scope} agent credential:`, error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to clear agent credential');
      setSaveResult('error');
    } finally {
      if (isCurrentIdentity()) {
        setClearingSecret(null);
        window.setTimeout(() => {
          if (isCurrentIdentity()) {
            setSaveResult((current) => (current === 'saved' ? null : current));
          }
        }, 4000);
      }
    }
  };

  const applyReview = async () => {
    if (!pendingReview) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      await update({ ...pendingReview.update, reviewId: pendingReview.review.id });
      if (!isCurrentIdentity()) return;
      setPendingReview(null);
      setBearerToken('');
      setKiroApiKey('');
      await load();
      setSaveResult('saved');
    } catch (error) {
      if (!isCurrentIdentity()) return;
      // The API carries the auth error code in the response body, not on the error.
      if (error instanceof ApiError && error.body?.code === 'AGENT_AUTH_REVIEW_STALE')
        setPendingReview(null);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Failed to finish the reviewed change. Apply it again to retry.',
      );
      setSaveResult('error');
    } finally {
      if (isCurrentIdentity()) setSaving(false);
    }
  };

  const configuredCount =
    Number(Boolean(settings?.bedrockBearerTokenSet)) + Number(Boolean(settings?.kiroApiKeySet));
  const authentication = settings?.authentication;
  const policyMode = authentication?.policy.mode;
  // Keys is the built-in legacy-key owner; every other mode authenticates
  // Bedrock agents through a connection, so saved Bedrock keys are inert.
  const connectionMode = policyMode !== undefined && policyMode !== 'keys';
  const modeLabel =
    authentication?.modes.find((option) => option.id === policyMode)?.label ?? policyMode;
  const hasOverride = authentication?.hasOverride ?? Boolean(settings?.bedrockBearerTokenSet);
  const connectionReady =
    authentication?.connection?.mode === policyMode &&
    authentication?.connection?.state === 'ready';
  const inheritsConnection = scope !== 'platform' && !hasOverride;
  const description = !connectionMode
    ? COPY[scope].description
    : scope === 'platform'
      ? `Agents use the platform ${modeLabel} connection. Kiro keeps its separate API key.`
      : scope === 'space'
        ? `Agents inherit the platform ${modeLabel} connection unless this space has its own. Kiro keeps its separate API key.`
        : `Agents use the ${modeLabel} connection managed by administrators. Kiro keeps your personal API key.`;
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
      description={description}
      badge={
        !loading &&
        (connectionMode ? (
          <ConfigStatusBadge
            ok={connectionReady}
            okLabel={inheritsConnection ? 'Using platform connection' : `${modeLabel} configured`}
            notOkLabel={`${modeLabel} needs attention`}
            notOkTone="warning"
          />
        ) : (
          <ConfigStatusBadge
            ok={configuredCount > 0}
            okLabel={`${configuredCount} provider${configuredCount === 1 ? '' : 's'} configured`}
            notOkLabel="No credentials"
            notOkTone="warning"
          />
        ))
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
                .catch((error) => {
                  if (!isCurrentIdentity()) return;
                  setErrorMessage(
                    error instanceof Error ? error.message : 'Failed to load agent credentials',
                  );
                })
                .finally(() => {
                  if (isCurrentIdentity()) setLoading(false);
                });
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          {authentication && (
            <AgentAuthenticationModeSettings
              key={`${identity}:${authentication.policy.revision}`}
              authentication={authentication}
              scope={scope}
              projectId={projectId}
              hasOverride={hasOverride}
              onApplied={load}
            />
          )}
          {pendingReview && (
            <AuthenticationImpactReview
              review={pendingReview.review}
              applying={saving}
              onApply={() => void applyReview()}
              onCancel={() => setPendingReview(null)}
            />
          )}
          <SecretField
            id={`${scope}-bedrock-bearer-token`}
            label="Bedrock Bearer Token"
            isSet={Boolean(settings?.bedrockBearerTokenSet)}
            value={bearerToken}
            onChange={(value) => {
              setBearerToken(value);
              setPendingReview(null);
            }}
            emptyPlaceholder="Enter AWS_BEARER_TOKEN_BEDROCK value"
            rotatePlaceholder="Enter a new token to rotate, or leave blank"
            onClear={() => clearSecret('bedrockBearerToken')}
            clearing={clearingSecret === 'bedrockBearerToken'}
            disabled={saving || clearingSecret !== null || connectionMode}
            helpText={
              connectionMode
                ? `Agents authenticate with ${modeLabel}. Saved Bedrock keys are not used in this mode.`
                : `Enables Claude Code, OpenCode and Codex.${fallbackText('bedrock') ?? ''}`
            }
            warningText={agentCredentialFormatWarning('bedrockBearerToken', bearerToken)}
          />
          <SecretField
            id={`${scope}-kiro-api-key`}
            label="Kiro API Key"
            isSet={Boolean(settings?.kiroApiKeySet)}
            value={kiroApiKey}
            onChange={(value) => {
              setKiroApiKey(value);
              setPendingReview(null);
            }}
            emptyPlaceholder="Enter KIRO_API_KEY value"
            rotatePlaceholder="Enter a new key to rotate, or leave blank"
            onClear={() => clearSecret('kiroApiKey')}
            clearing={clearingSecret === 'kiroApiKey'}
            disabled={saving || clearingSecret !== null}
            helpText={`Enables the Kiro CLI.${fallbackText('kiro') ?? ''}`}
            warningText={agentCredentialFormatWarning('kiroApiKey', kiroApiKey)}
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
