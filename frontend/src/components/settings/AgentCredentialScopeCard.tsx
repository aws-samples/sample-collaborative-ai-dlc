import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronRight, KeyRound } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  agentsService,
  type AgentCredentialStatus,
  type BedrockPreflightFailure,
  type SpaceAgentCredentialStatus,
} from '@/services/agents';
import { ApiError } from '@/services/api';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SecretField } from '@/components/settings/SecretField';
import { RevealableValue } from '@/components/settings/RevealableValue';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

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
      const result = await agentsService.getPersonalCredentials();
      if (!isCurrentIdentity()) return false;
      applied(result);
      setPlatformFallback(null);
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

  const update = async (value: { bedrockBearerToken?: string; kiroApiKey?: string }) => {
    if (scope === 'platform') return agentsService.updateSettings(value);
    if (scope === 'personal') return agentsService.updatePersonalCredentials(value);
    if (!projectId) throw new Error('projectId is required for space credentials');
    return agentsService.updateProjectCredentials(projectId, value);
  };

  const trimmedRoleArn = roleArn.trim();
  // The radio makes a role ARN and a bearer token mutually exclusive by
  // construction, so only the selected method's input can contribute a change.
  const bedrockInput = bedrockMethod === 'role' ? trimmedRoleArn : bearerToken;
  const hasChanges = bedrockInput !== '' || kiroApiKey !== '';

  const save = async () => {
    setSaving(true);
    setSaveResult(null);
    setErrorMessage(null);
    setPreflight(null);
    try {
      const value: { bedrockBearerToken?: string; kiroApiKey?: string } = {};
      // The role binding travels in the SAME field as the bearer token: which shape
      // the value holds is a property of the value, so no new field, no new
      // parameter and no new provider (req-single-parameter-encoding). The external
      // ID is never sent — the server generates and attaches its own.
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
  const bedrockMode = settings?.bedrockMode ?? null;
  const fallbackText = (provider: 'bedrock' | 'kiro') => {
    if (scope !== 'space') return null;
    const available =
      provider === 'bedrock'
        ? Boolean(platformFallback?.bedrockMode ?? platformFallback?.bedrockBearerTokenSet)
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
          {roleSupported ? (
            <div className="space-y-2.5" data-testid={`${scope}-bedrock-auth`}>
              <p className="text-xs font-medium text-foreground">Bedrock authentication</p>
              {(['role', 'bearer'] as const).map((method) => {
                const selected = bedrockMethod === method;
                return (
                  <label
                    key={method}
                    className="flex cursor-pointer items-start gap-2"
                    htmlFor={`${scope}-bedrock-method-${method}`}
                  >
                    <input
                      id={`${scope}-bedrock-method-${method}`}
                      type="radio"
                      name={`${scope}-bedrock-method`}
                      // The visible label carries a badge and a description, so an
                      // explicit accessible name keeps the control addressable.
                      aria-label={method === 'role' ? 'IAM role' : 'Bearer token'}
                      checked={selected}
                      onChange={() => setBedrockMethod(method)}
                      disabled={saving || clearingSecret !== null}
                      className="mt-1 accent-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                        {method === 'role' ? 'IAM role' : 'Bearer token'}
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
                          ok={bedrockMode === method}
                          okLabel="Set"
                          notOkLabel="Not set"
                        />
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {method === 'role'
                          ? 'Short-lived credentials are minted per invocation by assuming a role. No secret is stored.'
                          : 'A long-lived key stored as a secret, where an IAM role needs none.'}
                      </span>
                    </span>
                  </label>
                );
              })}
              {/* One SSM parameter holds the Bedrock value, so switching method and
                  saving REPLACES the other one. Said plainly rather than discovered. */}
              {bedrockMode && bedrockMode !== bedrockMethod && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">
                  Saving replaces the {bedrockMode === 'role' ? 'IAM role binding' : 'bearer token'}{' '}
                  currently in use for this scope.
                </p>
              )}
            </div>
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

          {(!roleSupported || bedrockMethod === 'bearer') && (
            <SecretField
              id={`${scope}-bedrock-bearer-token`}
              label={roleSupported ? 'Bearer token value' : 'Bedrock Bearer Token (deprecated)'}
              isSet={bedrockMode === 'bearer'}
              value={bearerToken}
              onChange={setBearerToken}
              emptyPlaceholder="Enter AWS_BEARER_TOKEN_BEDROCK value"
              rotatePlaceholder="Enter a new token to rotate, or leave blank"
              onClear={() => clearSecret('bedrockBearerToken')}
              clearing={clearingSecret === 'bedrockBearerToken'}
              disabled={saving || clearingSecret !== null}
              helpText={`Enables Claude Code, OpenCode and Codex.${
                // Personal scope has no role option (dec-user-scope-role-deferred), so
                // the deprecation is stated with WHERE the alternative lives — marking
                // it deprecated without naming an alternative would be unactionable.
                roleSupported
                  ? ''
                  : ' Deprecated: a long-lived key stored as a secret. An IAM role needs none, and is configured at space or platform scope.'
              }${fallbackText('bedrock') ?? ''}`}
            />
          )}
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
