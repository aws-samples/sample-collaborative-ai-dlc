import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, KeyRound, Loader2, XCircle } from 'lucide-react';
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
import { SettingsDisclosureCard } from '@/components/settings/SettingsDisclosureCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SecretField } from '@/components/settings/SecretField';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { agentCredentialFormatWarning } from '@/lib/agentCredentialFormat';
import { queryClient } from '@/lib/queryClient';
import { qk } from '@/lib/queryKeys';
import { bedrockGatewayHost, bedrockKeyFieldCopy } from '@/lib/bedrockGateway';

// Credential storage scopes. Intents pin an opaque binding to one of these;
// they do not store a separate secret.
type Scope = 'platform' | 'space' | 'personal';
type SecretName = 'bedrockBearerToken' | 'kiroApiKey';
/** Key families a CLI needs: Kiro uses its own key, every other CLI uses Bedrock. */
export type CredentialProvider = 'bedrock' | 'kiro';

interface Props {
  scope: Scope;
  projectId?: string;
  /**
   * `card`: always-open settings card (platform admin, account page).
   * `disclosure`: collapsed while this scope only inherits; opens when it
   * overrides a key or when a required key is missing at every level.
   */
  presentation?: 'card' | 'disclosure';
  /**
   * Space scope only: the key families the CLIs enabled in this space need.
   * A missing key is a warning only when neither the space nor the platform
   * holds it; unknown (omitted) never warns.
   */
  requiredProviders?: readonly CredentialProvider[];
}

const COPY: Record<Scope, { title: string; description: string }> = {
  platform: {
    title: 'Platform Agent Credentials',
    description: 'Fallback credentials used when no personal or space credential is configured.',
  },
  space: {
    title: 'Agent credentials',
    description: 'Used for members without a personal credential; overrides the platform fallback.',
  },
  personal: {
    title: 'Your agent keys',
    description:
      'Optional. Agents you run use your own keys in every space. Without them, the space or platform key is used.',
  },
};

// Why a connection mode needs no Bedrock key at this scope.
const BEDROCK_ACCESS_COPY: Record<Scope, (mode: string) => string> = {
  personal: (mode) =>
    `Your administrators provide Bedrock access through ${mode}, so you don't need a Bedrock key.`,
  space: (mode) =>
    `Agents in this space get Bedrock access through ${mode}, so a space Bedrock key is not used.`,
  platform: (mode) =>
    `Agents get Bedrock access through ${mode}, so a platform Bedrock key is not used.`,
};

/**
 * Disclosure header meta for phones: the summary and status pill share the
 * title row from `sm` up and move under the description below it, so the
 * title is never truncated while the status stays visible when collapsed.
 */
function stackedDisclosureMeta(input: {
  summary?: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
}) {
  const hasMeta = Boolean(input.summary || input.status);
  return {
    summary: input.summary ? <span className="max-sm:hidden">{input.summary}</span> : undefined,
    status: input.status ? (
      <span className="contents max-sm:hidden">{input.status}</span>
    ) : undefined,
    description: (
      <>
        {input.description}
        {hasMeta ? (
          <span className="mt-1.5 flex flex-wrap items-center gap-2 sm:hidden">
            {input.summary ? <span>{input.summary}</span> : null}
            {input.status}
          </span>
        ) : null}
      </>
    ),
  };
}

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

// The entry each scope's service read fills (agentsService.getSettings,
// getPersonalCredentials, getProjectCredentials), peeked for the first frame.
function cachedCredentials(scope: Scope, projectId?: string): AgentCredentialStatus | undefined {
  const key =
    scope === 'platform'
      ? qk.agentsSettings()
      : scope === 'personal'
        ? qk.personalCredentials()
        : projectId
          ? qk.projectCredentials(projectId)
          : null;
  if (!key) return undefined;
  const snapshot = queryClient.getQueryState<AgentCredentialStatus>(key);
  return snapshot?.data;
}

const loadErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Failed to load agent credentials';

const fallbackOf = (scope: Scope, status: AgentCredentialStatus | undefined) =>
  scope === 'space' && status
    ? ((status as SpaceAgentCredentialStatus).platformFallback ?? null)
    : null;

export function AgentCredentialScopeCard({
  scope,
  projectId,
  presentation = 'card',
  requiredProviders,
}: Props) {
  const identity = `${scope}\0${projectId ?? ''}`;
  const activeIdentityRef = useRef<string | null>(null);
  const isCurrentIdentity = useCallback(() => activeIdentityRef.current === identity, [identity]);
  useLayoutEffect(() => {
    activeIdentityRef.current = identity;
    return () => {
      if (activeIdentityRef.current === identity) activeIdentityRef.current = null;
    };
  }, [identity]);

  const [settings, setSettings] = useState<AgentCredentialStatus | null>(
    () => cachedCredentials(scope, projectId) ?? null,
  );
  const [platformFallback, setPlatformFallback] = useState<AgentCredentialStatus | null>(() =>
    fallbackOf(scope, cachedCredentials(scope, projectId)),
  );
  const [loading, setLoading] = useState(() => cachedCredentials(scope, projectId) === undefined);
  const [pendingReview, setPendingReview] = useState<{
    review: AgentAuthImpactReview;
    update: AgentCredentialUpdate;
  } | null>(null);
  const [bearerToken, setBearerToken] = useState('');
  const [kiroApiKey, setKiroApiKey] = useState('');
  // Fields open for editing. A stored secret is a summary row with Rotate and
  // Clear; a missing one a row with Add. The input appears on request only.
  const [editing, setEditing] = useState<Partial<Record<SecretName, boolean>>>({});
  // The input replaces its row's Rotate/Add button, and Cancel or a save removes
  // the input again: focus returns to the row of the field last opened so
  // keyboard and screen reader users keep their place.
  const rowButtons = useRef<Partial<Record<SecretName, HTMLButtonElement | null>>>({});
  const lastOpened = useRef<SecretName | null>(null);
  const [focusRow, setFocusRow] = useState<SecretName | null>(null);
  const closeEditing = () => {
    setEditing({});
    setFocusRow(lastOpened.current);
  };
  const [saving, setSaving] = useState(false);
  const [clearingSecret, setClearingSecret] = useState<SecretName | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);
  const [note, setNote] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // A failed read is reported apart from save results: with a record already
  // shown, it means the shown status may be out of date, not that a save failed.
  const [loadError, setLoadError] = useState<string | null>(null);

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
    // A cached record shows at once; load() then revalidates it in place.
    const cached = cachedCredentials(scope, projectId);
    setLoading(cached === undefined);
    setSettings(cached ?? null);
    setPendingReview(null);
    setPlatformFallback(fallbackOf(scope, cached));
    setBearerToken('');
    setKiroApiKey('');
    setEditing({});
    setSaving(false);
    setClearingSecret(null);
    setSaveResult(null);
    setNote(null);
    setErrorMessage(null);
    setLoadError(null);
    load()
      .catch((error) => {
        if (!isCurrentIdentity()) return;
        console.error(`Failed to load ${scope} agent credentials:`, error);
        setLoadError(loadErrorMessage(error));
      })
      .finally(() => {
        if (isCurrentIdentity()) setLoading(false);
      });
  }, [identity, isCurrentIdentity, load, projectId, scope]);

  // Rereads after a save or on Retry. False when the read failed (reported in
  // loadError) or the card moved to another scope meanwhile.
  const reload = async (): Promise<boolean> => {
    setLoadError(null);
    try {
      return await load();
    } catch (error) {
      if (isCurrentIdentity()) setLoadError(loadErrorMessage(error));
      return false;
    }
  };

  const retryLoad = () => {
    if (!settings) setLoading(true);
    void reload().finally(() => {
      if (isCurrentIdentity()) setLoading(false);
    });
  };

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
      if (!result.saved || !isCurrentIdentity()) return;
      await reload();
      if (!isCurrentIdentity()) return;
      setBearerToken('');
      setKiroApiKey('');
      closeEditing();
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
      if (!result.saved || !isCurrentIdentity()) return;
      await reload();
      if (!isCurrentIdentity()) return;
      if (field === 'bedrockBearerToken') setBearerToken('');
      else setKiroApiKey('');
      setEditing((current) => ({ ...current, [field]: false }));
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
      closeEditing();
      await reload();
      if (!isCurrentIdentity()) return;
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
        : 'Your administrators provide Bedrock access. You can still add your own Kiro key for the agents you run.';
  const personalKeysLabel =
    configuredCount > 1
      ? 'Using your own keys'
      : settings?.bedrockBearerTokenSet
        ? 'Using your own Bedrock key'
        : 'Using your own Kiro key';
  // With a Bedrock gateway the same field holds a gateway key, which only Claude Code can use.
  const gatewayHost = bedrockGatewayHost(settings?.bedrockGatewayUrl);
  const bedrockKeyField = bedrockKeyFieldCopy(gatewayHost);
  const fallbackText = (provider: CredentialProvider) => {
    if (scope !== 'space') return null;
    const available =
      provider === 'bedrock'
        ? platformFallback?.bedrockBearerTokenSet
        : platformFallback?.kiroApiKeySet;
    return available ? ' A platform fallback is available.' : ' No platform fallback is set.';
  };
  const keySetAnywhere = (provider: CredentialProvider) =>
    provider === 'bedrock'
      ? Boolean(settings?.bedrockBearerTokenSet || platformFallback?.bedrockBearerTokenSet)
      : Boolean(settings?.kiroApiKeySet || platformFallback?.kiroApiKeySet);
  const missingProviders =
    scope === 'space' ? (requiredProviders ?? []).filter((p) => !keySetAnywhere(p)) : [];
  const missingLabel =
    missingProviders.length === 2
      ? 'Keys missing'
      : missingProviders[0] === 'kiro'
        ? 'Kiro key missing'
        : 'Bedrock key missing';
  const platformHasKey = Boolean(
    platformFallback?.bedrockBearerTokenSet || platformFallback?.kiroApiKeySet,
  );

  const statusBadge =
    !loading &&
    (connectionMode ? (
      <ConfigStatusBadge
        ok={connectionReady}
        // The personal view only knows the platform default; a space may use its own.
        okLabel={
          scope === 'personal'
            ? 'Platform default ready'
            : inheritsConnection
              ? 'Using platform connection'
              : `${modeLabel} configured`
        }
        notOkLabel={
          scope === 'personal' ? 'Platform default needs attention' : `${modeLabel} needs attention`
        }
        notOkTone="warning"
      />
    ) : scope === 'personal' ? (
      <ConfigStatusBadge
        ok={configuredCount > 0}
        okLabel={personalKeysLabel}
        notOkLabel="Not set: shared keys are used"
      />
    ) : scope === 'space' ? (
      // The rows already say which keys are set, so a space with its keys shows no status.
      // A key of the space's own does not help when the agents need the other one.
      (configuredCount === 0 || missingProviders.length > 0) && (
        <ConfigStatusBadge
          notOkLabel={
            missingProviders.length
              ? missingLabel
              : platformHasKey
                ? 'Uses platform keys'
                : 'No keys set'
          }
          notOkTone={missingProviders.length ? 'warning' : 'neutral'}
        />
      )
    ) : (
      configuredCount === 0 && <ConfigStatusBadge notOkLabel="No credentials" notOkTone="warning" />
    ));

  // Open only when this scope deviates from inheritance or something is missing.
  const needsAttention = connectionMode ? !connectionReady : missingProviders.length > 0;
  const revealOpen = !loading && (hasOverride || configuredCount > 0 || needsAttention);

  const anyEditing = Boolean(editing.bedrockBearerToken || editing.kiroApiKey);
  const busy = saving || clearingSecret !== null;
  // A busy row's button is disabled and cannot take focus yet.
  useEffect(() => {
    if (!focusRow || busy) return;
    rowButtons.current[focusRow]?.focus();
    setFocusRow(null);
  }, [busy, focusRow]);
  const keyRow = (input: {
    field: SecretName;
    label: string;
    shortName: string;
    isSet: boolean;
    helpText: ReactNode;
  }) => (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex items-center gap-2 text-xs font-medium text-foreground">
          {input.label}
          <ConfigStatusBadge ok={input.isSet} okLabel="Set" notOkLabel="Not set" />
        </p>
        <p className="text-2xs text-muted-foreground">{input.helpText}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-label={`${input.isSet ? 'Rotate' : 'Add'} ${input.shortName}`}
          ref={(button) => {
            rowButtons.current[input.field] = button;
          }}
          disabled={busy}
          onClick={() => {
            lastOpened.current = input.field;
            setEditing((current) => ({ ...current, [input.field]: true }));
            setSaveResult(null);
            setNote(null);
          }}
        >
          {input.isSet ? 'Rotate' : 'Add'}
        </Button>
        {input.isSet && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Clear ${input.shortName}`}
            disabled={busy}
            onClick={() => void clearSecret(input.field)}
          >
            {clearingSecret === input.field ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <XCircle className="h-3 w-3" aria-hidden="true" />
            )}
            Clear
          </Button>
        )}
      </div>
    </div>
  );
  const bedrockShortName = gatewayHost ? 'gateway key' : 'Bedrock key';
  const bedrockHelp = `${bedrockKeyField.helpText}${fallbackText('bedrock') ?? ''}`;
  const kiroHelp = `Enables the Kiro CLI.${fallbackText('kiro') ?? ''}`;

  const body = loading ? (
    <div className="space-y-3">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="mt-4 h-4 w-40" />
      <Skeleton className="h-9 w-full" />
    </div>
  ) : !settings && loadError ? (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5"
    >
      <p className="flex items-center gap-2 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        {loadError}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={retryLoad}>
        Retry
      </Button>
    </div>
  ) : (
    <div className="space-y-5">
      {loadError && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5"
        >
          <p className="flex items-start gap-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Couldn't refresh credentials. What is shown may be out of date. {loadError}</span>
          </p>
          <Button type="button" variant="outline" size="sm" onClick={retryLoad}>
            Retry
          </Button>
        </div>
      )}
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
      {connectionMode ? (
        // The server rejects every Bedrock key write in a connection mode,
        // clearing included, so offer neither an input nor a Clear button.
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">Bedrock key</p>
          <p className="text-2xs text-muted-foreground">
            {BEDROCK_ACCESS_COPY[scope](modeLabel ?? '')}
          </p>
          {settings?.bedrockBearerTokenSet && (
            <p className="text-2xs text-muted-foreground">
              A Bedrock key is still saved here, but it is not used while {modeLabel} is active.
            </p>
          )}
        </div>
      ) : editing.bedrockBearerToken ? (
        <SecretField
          id={`${scope}-bedrock-bearer-token`}
          label={bedrockKeyField.label}
          isSet={Boolean(settings?.bedrockBearerTokenSet)}
          value={bearerToken}
          onChange={(value) => {
            setBearerToken(value);
            setPendingReview(null);
            setNote(null);
          }}
          emptyPlaceholder={
            gatewayHost ? 'Paste your gateway key' : 'Paste your Bedrock bearer token'
          }
          rotatePlaceholder={
            gatewayHost ? 'Paste the new gateway key' : 'Paste the new Bedrock bearer token'
          }
          onClear={() => clearSecret('bedrockBearerToken')}
          clearing={clearingSecret === 'bedrockBearerToken'}
          disabled={busy}
          autoFocus
          helpText={bedrockHelp}
          warningText={agentCredentialFormatWarning(
            'bedrockBearerToken',
            bearerToken,
            Boolean(gatewayHost),
          )}
        />
      ) : (
        keyRow({
          field: 'bedrockBearerToken',
          label: bedrockKeyField.label,
          shortName: bedrockShortName,
          isSet: Boolean(settings?.bedrockBearerTokenSet),
          helpText: bedrockHelp,
        })
      )}
      {editing.kiroApiKey ? (
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
          emptyPlaceholder="Paste your Kiro API key"
          rotatePlaceholder="Paste the new Kiro API key"
          onClear={() => clearSecret('kiroApiKey')}
          clearing={clearingSecret === 'kiroApiKey'}
          disabled={busy}
          autoFocus
          helpText={kiroHelp}
          warningText={agentCredentialFormatWarning('kiroApiKey', kiroApiKey, Boolean(gatewayHost))}
        />
      ) : (
        keyRow({
          field: 'kiroApiKey',
          label: 'Kiro API Key',
          shortName: 'Kiro key',
          isSet: Boolean(settings?.kiroApiKeySet),
          helpText: kiroHelp,
        })
      )}
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
          {anyEditing ? (
            <div className="flex flex-wrap items-center gap-3">
              <SaveStatusButton
                onClick={save}
                disabled={!hasChanges || clearingSecret !== null}
                saving={saving}
                label="Save credentials"
                result={saveResult}
                errorMessage={errorMessage}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="mt-1"
                disabled={busy}
                onClick={() => {
                  closeEditing();
                  setBearerToken('');
                  setKiroApiKey('');
                  setPendingReview(null);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : saveResult === 'error' ? (
            <p role="alert" className="text-xs text-destructive">
              {errorMessage || 'Failed to save'}
            </p>
          ) : (
            saveResult === 'saved' && <p className="text-xs text-agent-success">Saved</p>
          )}
          {note && (
            <p role="status" className="text-xs text-muted-foreground">
              {note}
            </p>
          )}
        </div>
      )}
    </div>
  );

  if (presentation === 'disclosure') {
    return (
      <SettingsDisclosureCard
        icon={<KeyRound />}
        title={COPY[scope].title}
        {...stackedDisclosureMeta({ status: statusBadge, description })}
        defaultOpen={revealOpen}
      >
        {body}
      </SettingsDisclosureCard>
    );
  }

  return (
    <SettingsCard
      icon={<KeyRound />}
      title={COPY[scope].title}
      description={description}
      badge={statusBadge}
    >
      {body}
    </SettingsCard>
  );
}
