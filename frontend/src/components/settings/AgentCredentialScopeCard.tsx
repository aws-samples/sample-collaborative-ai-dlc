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
import {
  APPLIES_AT_NEXT_START,
  NOT_AFFECTED_MESSAGE,
  authChangeErrorMessage,
  credentialChangeEffect,
  isStaleReviewError,
  reviewHasNoImpact,
} from './agent-auth/impact';
import { AgentAuthenticationModeSettings } from './AgentAuthenticationModeSettings';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SecretField } from '@/components/settings/SecretField';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { agentCredentialFormatWarning } from '@/lib/agentCredentialFormat';

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
    title: 'Your agent keys',
    description:
      'Optional. Agents you run use your own keys in every space. Without them, the space or platform key is used.',
  },
};

const SOURCE: Record<Scope, 'platform' | 'space' | 'user'> = {
  platform: 'platform',
  space: 'space',
  personal: 'user',
};

// What a saved change now means for whoever runs agents. `checked` is true only
// when the server's preview found no work that had already started.
const savedNote = (scope: Scope, value: AgentCredentialUpdate, checked: boolean) => {
  const changes = (['bedrockBearerToken', 'kiroApiKey'] as const).flatMap((field) =>
    typeof value[field] === 'string' ? [{ field, clear: value[field] === '' }] : [],
  );
  if (!changes.length) return null;
  return [
    ...(changes.every((change) => change.clear) ? ['Removed.'] : []),
    ...changes.map((change) =>
      credentialChangeEffect(SOURCE[scope], change.field, change.clear ? 'clear' : 'rotate'),
    ),
    APPLIES_AT_NEXT_START,
    ...(checked ? [NOT_AFFECTED_MESSAGE] : []),
    'You can change or remove keys here at any time.',
  ].join(' ');
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
  const [note, setNote] = useState<string | null>(null);
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
    setNote(null);
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

  const write = (value: AgentCredentialUpdate) => {
    if (scope === 'platform') return agentsService.updateSettings(value);
    if (scope === 'personal') return agentsService.updatePersonalCredentials(value);
    if (!projectId) throw new Error('projectId is required for space credentials');
    return agentsService.updateProjectCredentials(projectId, value);
  };

  // Where the server requires a review, it first prepares one. When it found no
  // work that already started, the change is applied with that same prepared
  // review: the server still rejects it if anything changed in between. Only a
  // review that affects started work waits for the person to confirm.
  const update = async (
    value: AgentCredentialUpdate,
  ): Promise<{ saved: boolean; note?: string | null }> => {
    if (!settings?.authentication?.reviewRequired) {
      const result = await write(value);
      return { ...result, note: savedNote(scope, value, false) };
    }
    const review = await agentsService.previewCredentialUpdate(scope, projectId, value);
    if (!isCurrentIdentity()) return { saved: false };
    if (!reviewHasNoImpact(review)) {
      setPendingReview({ review, update: value });
      return { saved: false };
    }
    const result = await write({ ...value, reviewId: review.id });
    return { ...result, note: savedNote(scope, value, true) };
  };

  const hasChanges = bearerToken !== '' || kiroApiKey !== '';

  const save = async () => {
    setSaving(true);
    setSaveResult(null);
    setNote(null);
    setErrorMessage(null);
    try {
      const value: { bedrockBearerToken?: string; kiroApiKey?: string } = {};
      if (bearerToken !== '') value.bedrockBearerToken = bearerToken;
      if (kiroApiKey !== '') value.kiroApiKey = kiroApiKey;
      const result = await update(value);
      if (!result.saved) return;
      if (!isCurrentIdentity() || !(await load())) return;
      setBearerToken('');
      setKiroApiKey('');
      setNote(result.note ?? null);
      setSaveResult('saved');
    } catch (error) {
      if (!isCurrentIdentity()) return;
      console.error(`Failed to save ${scope} agent credentials:`, error);
      setErrorMessage(authChangeErrorMessage(error, 'Failed to save agent credentials'));
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
    setNote(null);
    setErrorMessage(null);
    try {
      const result = await update({ [field]: '' });
      if (!result.saved) return;
      if (!isCurrentIdentity() || !(await load())) return;
      if (field === 'bedrockBearerToken') setBearerToken('');
      else setKiroApiKey('');
      setNote(result.note ?? null);
      setSaveResult('saved');
    } catch (error) {
      if (!isCurrentIdentity()) return;
      console.error(`Failed to clear ${scope} agent credential:`, error);
      setErrorMessage(authChangeErrorMessage(error, 'Failed to clear agent credential'));
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
      await write({ ...pendingReview.update, reviewId: pendingReview.review.id });
      if (!isCurrentIdentity()) return;
      setPendingReview(null);
      setBearerToken('');
      setKiroApiKey('');
      await load();
      setNote(savedNote(scope, pendingReview.update, false));
      setSaveResult('saved');
    } catch (error) {
      if (!isCurrentIdentity()) return;
      if (isStaleReviewError(error)) setPendingReview(null);
      setErrorMessage(
        authChangeErrorMessage(error, 'Failed to save the change. Confirm it again to retry.'),
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
        : `Administrators manage Bedrock access (${modeLabel}), so you don't need a Bedrock key. You can still add your own Kiro key.`;
  const personalKeysLabel =
    configuredCount > 1
      ? 'Using your own keys'
      : settings?.bedrockBearerTokenSet
        ? 'Using your own Bedrock key'
        : 'Using your own Kiro key';
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
        ) : scope === 'personal' ? (
          <ConfigStatusBadge
            ok={configuredCount > 0}
            okLabel={personalKeysLabel}
            notOkLabel="Not set: shared keys are used"
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
          <SecretField
            id={`${scope}-bedrock-bearer-token`}
            label="Bedrock Bearer Token"
            isSet={Boolean(settings?.bedrockBearerTokenSet)}
            value={bearerToken}
            onChange={(value) => {
              setBearerToken(value);
              setPendingReview(null);
              setNote(null);
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
              setNote(null);
            }}
            emptyPlaceholder="Enter KIRO_API_KEY value"
            rotatePlaceholder="Enter a new key to rotate, or leave blank"
            onClear={() => clearSecret('kiroApiKey')}
            clearing={clearingSecret === 'kiroApiKey'}
            disabled={saving || clearingSecret !== null}
            helpText={`Enables the Kiro CLI.${fallbackText('kiro') ?? ''}`}
            warningText={agentCredentialFormatWarning('kiroApiKey', kiroApiKey)}
          />
          {pendingReview ? (
            <div className="space-y-2">
              <AuthenticationImpactReview
                review={pendingReview.review}
                applying={saving}
                onApply={() => void applyReview()}
                onCancel={() => setPendingReview(null)}
              />
              {errorMessage && (
                <p role="alert" className="text-xs text-destructive">
                  {errorMessage}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <SaveStatusButton
                onClick={save}
                disabled={!hasChanges || clearingSecret !== null}
                saving={saving}
                label="Save Credentials"
                result={saveResult}
                errorMessage={errorMessage}
              />
              {note && (
                <p role="status" className="text-xs text-muted-foreground">
                  {note}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
