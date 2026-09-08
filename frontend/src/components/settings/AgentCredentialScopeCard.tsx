import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronRight, KeyRound } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  agentsService,
  type AgentCredentialStatus,
  type AgentSettingsUpdate,
  type BedrockPreflightFailure,
  type SpaceAgentCredentialStatus,
} from '@/services/agents';
import { ApiError } from '@/services/api';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SecretField } from '@/components/settings/SecretField';
import { RevealableValue } from '@/components/settings/RevealableValue';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { credentialBadgeLabel } from '@/lib/agentCli';

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
    description:
      'Kiro fallback and the platform Bedrock mode. A platform IAM role overrides stored Bedrock keys unless the space has its own IAM role.',
  },
  space: {
    title: 'Space Agent Credentials',
    description:
      'A space IAM role overrides the platform role. While IAM applies, stored personal and space Bedrock keys remain encrypted but inactive.',
  },
  personal: {
    title: 'Personal Agent Credentials',
    description:
      'API keys use personal precedence, except a Bedrock key is inactive wherever a space or platform IAM role applies.',
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
  const [bearerToken, setBearerToken] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [kiroApiKey, setKiroApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearingSecret, setClearingSecret] = useState<SecretName | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<BedrockPreflightFailure | null>(null);
  // Held separately from `settings` so it survives a REJECTED save: the operator
  // needs the value precisely when the preflight has just failed, because that is
  // the trust policy they are about to write
  // (specs/bedrock-iam-role-credential-mode: dec-external-id-storage).
  const [externalId, setExternalId] = useState<string | null>(null);
  // A scope stores exactly ONE Bedrock value in one SSM parameter, so this is a
  // genuine either/or rather than two independent fields. The radio makes that
  // model visible and shows only the inputs the chosen method needs.
  const [bedrockMethod, setBedrockMethod] = useState<'role' | 'bearer'>('role');
  // The principal and external ID are read-only reference values, needed only while
  // writing a trust policy — collapsed by default so they do not crowd the inputs.
  const [trustDetailsOpen, setTrustDetailsOpen] = useState(false);

  // Role mode is deliberately unavailable at personal scope: that endpoint is gated
  // only on authentication, so any member could otherwise name a role ARN
  // (dec-user-scope-role-deferred).
  const roleSupported = scope !== 'personal';

  const load = useCallback(async () => {
    if (!isCurrentIdentity()) return false;
    const applied = (result: AgentCredentialStatus) => {
      setSettings(result);
      // Start on the method this scope is ALREADY using, so the form describes the
      // stored state rather than a default. An unconfigured scope starts on the
      // recommended method.
      if (result.bedrockMode === 'bearer' || result.bedrockMode === 'role') {
        setBedrockMethod(result.bedrockMode);
      }
      // An idempotent read, not a one-time reveal: recovering the value is a plain
      // read rather than a rotation (dec-external-id-not-secret).
      //
      // ABSENT and NULL mean different things and are treated differently. The field
      // is absent on any read not gated to a principal who may modify the binding,
      // and losing the value then would strand an operator mid-bootstrap — so absent
      // keeps what is in hand. An explicit null is the gated, authoritative answer
      // "this binding sends no external ID", which happens after a rebind to a
      // same-account role, and keeping the old value there would leave the trust
      // policy panel telling the operator to require an sts:ExternalId that the
      // binding will never send.
      setExternalId((current) =>
        result.bedrockExternalId === undefined ? current : result.bedrockExternalId,
      );
    };
    if (scope === 'platform') {
      const result = await agentsService.getSettings();
      if (!isCurrentIdentity()) return false;
      applied(result);
      setPlatformFallback(null);
      return true;
    }
    if (scope === 'personal') {
      // Platform IAM mode is authoritative for every space that can use this
      // personal key. Load its non-secret set-state beside the personal scope so
      // the account form cannot offer a write the effective mode will ignore.
      const [result, platform] = await Promise.all([
        agentsService.getPersonalCredentials(),
        agentsService.getSettings(),
      ]);
      if (!isCurrentIdentity()) return false;
      applied(result);
      setPlatformFallback(platform);
      return true;
    }
    if (!projectId) throw new Error('projectId is required for space credentials');
    const result: SpaceAgentCredentialStatus = await agentsService.getProjectCredentials(projectId);
    if (!isCurrentIdentity()) return false;
    applied(result);
    setPlatformFallback(result.platformFallback);
    return true;
  }, [isCurrentIdentity, projectId, scope]);

  useEffect(() => {
    setLoading(true);
    setSettings(null);
    setPlatformFallback(null);
    setBearerToken('');
    setRoleArn('');
    setKiroApiKey('');
    setSaving(false);
    setClearingSecret(null);
    setSaveResult(null);
    setErrorMessage(null);
    setPreflight(null);
    setExternalId(null);
    setBedrockMethod(scope === 'personal' ? 'bearer' : 'role');
    setTrustDetailsOpen(false);
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

  type CredentialUpdate = Pick<
    AgentSettingsUpdate,
    'bedrockMode' | 'bedrockBearerToken' | 'kiroApiKey'
  >;
  const update = async (value: CredentialUpdate) => {
    if (scope === 'platform') return agentsService.updateSettings(value);
    if (scope === 'personal') {
      return agentsService.updatePersonalCredentials({
        ...(value.bedrockBearerToken !== undefined
          ? { bedrockBearerToken: value.bedrockBearerToken }
          : {}),
        ...(value.kiroApiKey !== undefined ? { kiroApiKey: value.kiroApiKey } : {}),
      });
    }
    if (!projectId) throw new Error('projectId is required for space credentials');
    return agentsService.updateProjectCredentials(projectId, value);
  };

  const trimmedRoleArn = roleArn.trim();
  const bedrockMode = settings?.bedrockMode ?? null;
  // An inherited platform role cannot be displaced by a space or personal key.
  // A same-scope role can be switched back to API-key mode through the selector,
  // so its input becomes editable only after that explicit selection.
  const inheritedBedrockRole =
    (scope === 'space' || scope === 'personal') && platformFallback?.bedrockMode === 'role';
  const bedrockKeyControlsDisabled =
    inheritedBedrockRole || (roleSupported && bedrockMethod === 'role');
  const bedrockKeyLabel = roleSupported
    ? 'Amazon Bedrock API Key'
    : 'Amazon Bedrock API Key (deprecated)';
  // The radio makes a role ARN and a bearer token mutually exclusive by
  // construction, so only the selected method's input can contribute a change.
  const bedrockInput = bedrockMethod === 'role' ? trimmedRoleArn : bearerToken;
  const modeChanged = roleSupported && bedrockMode !== null && bedrockMethod !== bedrockMode;
  // The single Bedrock parameter holds either a role or a key, so every mode
  // switch requires the replacement value shown by the selected input.
  const hasChanges = bedrockInput !== '' || kiroApiKey !== '';

  const save = async () => {
    setSaving(true);
    setSaveResult(null);
    setErrorMessage(null);
    setPreflight(null);
    try {
      const value: CredentialUpdate = {};
      // The role binding travels in the SAME field as the bearer token. The
      // selected mode makes the replacement value unambiguous.
      if (roleSupported && bedrockInput !== '') {
        value.bedrockMode = bedrockMethod;
      }
      // The external ID is never sent — the server generates and attaches its own.
      if (bedrockInput !== '') {
        value.bedrockBearerToken =
          bedrockMethod === 'role' ? JSON.stringify({ roleArn: trimmedRoleArn }) : bearerToken;
      }
      if (kiroApiKey !== '') value.kiroApiKey = kiroApiKey;
      const result = await update(value);
      if (result?.bedrockExternalId) setExternalId(result.bedrockExternalId);
      if (!isCurrentIdentity() || !(await load())) return;
      setBearerToken('');
      setRoleArn('');
      setKiroApiKey('');
      setSaveResult('saved');
    } catch (error) {
      if (!isCurrentIdentity()) return;
      console.error(`Failed to save ${scope} agent credentials:`, error);
      // A rejected preflight is an INPUT error, so it is rendered as guidance the
      // operator can act on rather than as a generic failure. The external ID comes
      // back with the rejection precisely so the trust policy can be fixed, and the
      // reference values are opened because that is exactly when they are needed.
      if (error instanceof ApiError && error.body?.code === 'BEDROCK_ROLE_PREFLIGHT_FAILED') {
        const body = error.body as {
          preflight?: BedrockPreflightFailure;
          bedrockExternalId?: string | null;
        };
        if (body.preflight) setPreflight(body.preflight);
        if (body.bedrockExternalId) setExternalId(body.bedrockExternalId);
        setTrustDetailsOpen(true);
      }
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
      await update({ [field]: '' });
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

  // req-configured-semantics: configured means a USABLE BINDING exists, not that a
  // secret is set. A scope holding only a role ARN has no secret at all, and
  // counting only secrets would render it as having no credentials.
  const bedrockConfigured = settings?.bedrockMode
    ? settings.bedrockMode !== null
    : Boolean(settings?.bedrockBearerTokenSet);
  const configuredCount = Number(bedrockConfigured) + Number(Boolean(settings?.kiroApiKeySet));
  const localBedrockKind =
    bedrockMode ?? (settings?.bedrockBearerTokenSet ? ('bearer' as const) : null);
  const platformBedrockKind =
    platformFallback?.bedrockMode ??
    (platformFallback?.bedrockBearerTokenSet ? ('bearer' as const) : null);
  // This readout names the scope that controls the shared Bedrock mode. API keys
  // remain ordinary fallbacks (a personal key can still win); a role is
  // authoritative and makes covered keys inactive. Personal settings have no
  // project context, so they intentionally do not claim a space-wide controller.
  const bedrockControl: { source: 'space' | 'platform'; kind: 'role' | 'bearer' } | null =
    scope === 'platform'
      ? localBedrockKind
        ? { source: 'platform', kind: localBedrockKind }
        : null
      : scope === 'space'
        ? localBedrockKind === 'role'
          ? { source: 'space', kind: 'role' }
          : platformBedrockKind === 'role'
            ? { source: 'platform', kind: 'role' }
            : localBedrockKind === 'bearer'
              ? { source: 'space', kind: 'bearer' }
              : platformBedrockKind === 'bearer'
                ? { source: 'platform', kind: 'bearer' }
                : null
        : null;
  const bedrockControlLabel = bedrockControl
    ? credentialBadgeLabel(bedrockControl.source, bedrockControl.kind)
    : null;
  const bedrockControlDescription = !bedrockControl
    ? 'No shared Amazon Bedrock credential is configured for this scope.'
    : bedrockControl.kind === 'role'
      ? `${bedrockControlLabel} controls Amazon Bedrock${
          bedrockControl.source === 'platform' && scope === 'platform'
            ? ' by default; a Space IAM role can override it.'
            : ' for this space.'
        } Stored Bedrock API keys are inactive. Paused intents store no temporary AWS credentials and receive fresh role credentials when they resume.`
      : `${bedrockControlLabel} is the shared fallback for Amazon Bedrock. A member's Personal API key can still take precedence until an IAM role is selected. Paused intents re-read the binding when they resume.`;
  const fallbackText = (provider: 'bedrock' | 'kiro') => {
    if (scope !== 'space') return null;
    if (provider === 'bedrock') {
      if (bedrockMode === 'role') {
        return platformFallback?.bedrockMode === 'role'
          ? ' This space IAM role overrides the platform IAM role.'
          : '';
      }
      if (platformFallback?.bedrockMode === 'role') {
        return ' A platform IAM role is active and overrides stored personal and space Bedrock keys.';
      }
      const available = Boolean(platformFallback?.bedrockBearerTokenSet);
      return available
        ? ' A platform Bedrock key fallback is available.'
        : ' No platform Bedrock fallback is set.';
    }
    return platformFallback?.kiroApiKeySet
      ? ' A platform Kiro fallback is available.'
      : ' No platform Kiro fallback is set.';
  };
  const bedrockKeyHelp = bedrockKeyControlsDisabled
    ? inheritedBedrockRole
      ? 'A platform IAM role is effective for Amazon Bedrock. Any stored key remains encrypted but inactive; a platform administrator must switch Bedrock to API Key mode before this key can be changed. Kiro API key controls remain available.'
      : 'IAM Role is selected for Amazon Bedrock. Saving it replaces any API key at this scope; choose API Key mode and enter a new key to switch back. Kiro API key controls remain available.'
    : `Enables Claude Code, OpenCode and Codex.${
        // Personal scope has no role option (dec-user-scope-role-deferred), so
        // the deprecation names where the supported alternative lives.
        roleSupported
          ? ''
          : ' Deprecated: a long-lived key stored as a secret. An IAM role needs none, and is configured at space or platform scope.'
      }${fallbackText('bedrock') ?? ''}`;

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
          {roleSupported && (
            <div
              className="rounded-md border border-border bg-muted/30 px-3 py-2.5"
              data-testid={`${scope}-bedrock-effective-status`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-medium text-foreground">
                  Effective Amazon Bedrock status
                </p>
                {bedrockControlLabel && (
                  <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {bedrockControlLabel}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{bedrockControlDescription}</p>
            </div>
          )}

          {roleSupported ? (
            <fieldset className="space-y-2.5" data-testid={`${scope}-bedrock-auth`}>
              <legend className="text-xs font-medium text-foreground">
                Amazon Bedrock credential mode
              </legend>
              <p className="text-[11px] text-muted-foreground">
                IAM Role is available only for Amazon Bedrock. Kiro always uses the separate API Key
                below.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(['role', 'bearer'] as const).map((method) => {
                  const selected = bedrockMethod === method;
                  const label = method === 'role' ? 'IAM Role' : 'API Key';
                  const descriptionId = `${scope}-bedrock-method-${method}-description`;
                  return (
                    <label
                      key={method}
                      className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 transition-colors ${
                        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                      }`}
                      htmlFor={`${scope}-bedrock-method-${method}`}
                    >
                      <input
                        id={`${scope}-bedrock-method-${method}`}
                        type="radio"
                        name={`${scope}-bedrock-method`}
                        aria-label={label}
                        aria-describedby={descriptionId}
                        checked={selected}
                        onChange={() => setBedrockMethod(method)}
                        disabled={saving || clearingSecret !== null}
                        className="mt-1 accent-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground">
                          {label}
                          <span
                            className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${
                              method === 'role'
                                ? 'bg-primary/10 text-primary'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {method === 'role' ? 'Recommended' : 'Deprecated'}
                          </span>
                          <ConfigStatusBadge
                            ok={
                              bedrockMode === method &&
                              !(method === 'bearer' && bedrockKeyControlsDisabled)
                            }
                            okLabel="Set"
                            notOkLabel={
                              method === 'bearer' && bedrockKeyControlsDisabled
                                ? 'Inactive'
                                : 'Not set'
                            }
                          />
                        </span>
                        <span
                          id={descriptionId}
                          className="mt-1 block text-[11px] text-muted-foreground"
                        >
                          {method === 'role'
                            ? 'The role trusts only the credential broker. The broker supports roles in this AWS account or another and issues short-lived credentials per invocation; the runtime cannot assume the role.'
                            : 'Stores a long-lived Amazon Bedrock API key as a secret. Existing deployments remain supported, but IAM avoids secret storage and rotation.'}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {modeChanged && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">
                  {bedrockMethod === 'role'
                    ? 'Saving IAM Role replaces the API key at this scope. Keys at lower scopes remain stored but inactive while IAM applies.'
                    : 'Switching to API Key mode replaces the IAM role; enter the new key to save the change.'}
                </p>
              )}
            </fieldset>
          ) : null}

          {roleSupported && bedrockMethod === 'role' && (
            <div className="space-y-1.5" data-testid={`${scope}-bedrock-role`}>
              <label
                htmlFor={`${scope}-bedrock-role-arn`}
                className="text-xs font-medium text-foreground"
              >
                Role ARN
              </label>
              {settings?.bedrockRoleArn && (
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {settings.bedrockRoleArn}
                </p>
              )}
              <Input
                id={`${scope}-bedrock-role-arn`}
                value={roleArn}
                onChange={(e) => setRoleArn(e.target.value)}
                disabled={saving || clearingSecret !== null}
                placeholder={
                  bedrockMode === 'role'
                    ? 'Enter a new role ARN to replace it, or leave blank'
                    : 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference'
                }
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                Enables Claude Code, OpenCode and Codex.{fallbackText('bedrock') ?? ''}
              </p>
              {(settings?.bedrockBrokerRoleArn || externalId) && (
                <Collapsible open={trustDetailsOpen} onOpenChange={setTrustDetailsOpen}>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      data-testid={`${scope}-trust-details-toggle`}
                      className="flex w-full items-center gap-1.5 pt-1 text-left"
                    >
                      <ChevronRight
                        className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${trustDetailsOpen ? 'rotate-90' : ''}`}
                      />
                      <span className="text-xs font-medium text-foreground">
                        Trust policy details
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {externalId
                          ? 'principal and external ID to allow in the role'
                          : 'principal to allow in the role'}
                      </span>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="space-y-3 pt-3">
                      {settings?.bedrockBrokerRoleArn && (
                        <RevealableValue
                          id={`${scope}-bedrock-broker-role`}
                          label="Principal to trust"
                          value={settings.bedrockBrokerRoleArn}
                          masked={false}
                          helpText="The role's trust policy must allow sts:AssumeRole for this principal. Add an sts:RoleSessionName condition to limit which spaces may use the role."
                        />
                      )}
                      {externalId && (
                        <RevealableValue
                          id={`${scope}-bedrock-external-id`}
                          label="External ID"
                          value={externalId}
                          helpText="Add this as an sts:ExternalId condition in the role's trust policy. Generated by the platform, required for a role in another AWS account, and safe to read again at any time."
                        />
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
              {preflight && (
                <div
                  role="alert"
                  className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5"
                >
                  <p className="text-[11px] font-medium text-destructive">
                    The role could not be assumed ({preflight.cause}). The binding was not saved.
                  </p>
                  {preflight.candidates?.length ? (
                    <ul className="list-inside list-disc space-y-0.5 text-[11px] text-muted-foreground">
                      {preflight.candidates.map((candidate) => (
                        <li key={candidate.candidate}>{candidate.detail}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}
            </div>
          )}

          <SecretField
            id={`${scope}-bedrock-bearer-token`}
            label={`${bedrockKeyLabel}${bedrockKeyControlsDisabled ? ' (inactive)' : ''}`}
            isSet={Boolean(settings?.bedrockBearerTokenSet)}
            inactive={bedrockKeyControlsDisabled}
            value={bearerToken}
            onChange={setBearerToken}
            emptyPlaceholder={
              bedrockKeyControlsDisabled
                ? 'Unavailable while IAM role mode is active'
                : 'Enter AWS_BEARER_TOKEN_BEDROCK value'
            }
            rotatePlaceholder={
              bedrockKeyControlsDisabled
                ? 'Unavailable while IAM role mode is active'
                : 'Enter a new token to rotate, or leave blank'
            }
            onClear={() => clearSecret('bedrockBearerToken')}
            clearing={clearingSecret === 'bedrockBearerToken'}
            disabled={bedrockKeyControlsDisabled || saving || clearingSecret !== null}
            helpText={bedrockKeyHelp}
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
