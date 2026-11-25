import { useState } from 'react';
import {
  agentsService,
  type AgentAuthChangeRequest,
  type AgentAuthenticationView,
  type AgentAuthImpactReview,
} from '@/services/agents';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { displayProvider } from '@/lib/displayNames';
import { AuthenticationImpactReview } from './AuthenticationImpactReview';
import { agentAuthProviderUi } from './agent-auth/registry';
import { summarizeConfiguration } from './agent-auth/summary';

const CONNECTION_STATES: Record<string, string> = {
  ready: 'Ready',
  'reconnect-required': 'Needs reconnecting by an administrator',
  revoked: 'No longer valid. An administrator needs to replace it',
  missing: 'Not set up yet',
};
const connectionStateLabel = (state?: string) =>
  state ? (CONNECTION_STATES[state] ?? state) : CONNECTION_STATES.missing;

export function AgentAuthenticationModeSettings({
  authentication,
  scope,
  projectId,
  hasOverride,
  onApplied,
}: {
  authentication: AgentAuthenticationView;
  scope: 'platform' | 'space' | 'personal';
  projectId?: string;
  hasOverride: boolean;
  onApplied: () => Promise<unknown>;
}) {
  const { policy, modes, connection } = authentication;
  const [mode, setMode] = useState(policy.mode);
  const [review, setReview] = useState<AgentAuthImpactReview | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelFor = (id: string) => modes.find((option) => option.id === id)?.label ?? id;
  // Platform admins set up the mode they pick; spaces only manage the active one.
  const target = scope === 'platform' ? mode : policy.mode;
  const targetUi = agentAuthProviderUi(target);
  const targetDefault = modes.find((option) => option.id === target)?.defaultConnectionId;
  const spaceProjectId = scope === 'space' ? projectId : undefined;
  const summary = connection
    ? summarizeConfiguration(agentAuthProviderUi(connection.mode), connection.configuration)
    : [];
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      setReview(null);
      setError(failure instanceof Error ? failure.message : 'Configuration changed; review again.');
    } finally {
      setBusy(false);
    }
  };
  const reconnectNotice = connection?.state === 'reconnect-required' && (
    <p role="status">
      An administrator must reconnect this shared connection before agents can start.
    </p>
  );
  // The personal view has no space context: the server returns the platform
  // default (or the person's own key in Keys mode), while a space can select its
  // own connection or key at run time. Say so instead of implying one answer.
  if (scope === 'personal') {
    if (policy.mode === 'keys')
      return connection && connection.state !== 'ready' ? (
        <p role="status" className="rounded-md bg-muted/40 p-3 text-xs">
          There is no platform Bedrock key. Agents use a space's key where one is set; otherwise add
          your own key below or ask an administrator.
        </p>
      ) : null;
    return (
      <section
        aria-label="Platform default Bedrock access"
        className="space-y-1 rounded-md bg-muted/40 p-3 text-xs"
      >
        <p className="font-medium">Platform default Bedrock access: {labelFor(policy.mode)}</p>
        <p>Your administrators manage this. A space can use its own access instead.</p>
        <p>Status: {connectionStateLabel(connection?.state)}</p>
        {summary.length > 0 && (
          <div className="break-all text-muted-foreground">
            {summary.map((line) => (
              <p key={line.label}>
                {line.label}: {line.value}
              </p>
            ))}
          </div>
        )}
        {connection?.state === 'reconnect-required' && (
          <p role="status">
            An administrator must reconnect the platform default before agents that use it can
            start.
          </p>
        )}
      </section>
    );
  }
  const preview = (request: AgentAuthChangeRequest) =>
    perform(async () => setReview(await agentsService.previewAuthenticationChange(request)));
  // Failures propagate so the provider's Setup can show them and stay open.
  const submitDraft = async (configuration: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      setReview(
        await agentsService.previewAuthenticationChange({
          kind: 'connection-draft',
          mode: target,
          ...(spaceProjectId ? { projectId: spaceProjectId } : {}),
          configuration,
        }),
      );
      setSetupOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 text-xs">
      {scope === 'platform' ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="agent-authentication-mode">Agent authentication mode</Label>
            <Select
              value={mode}
              disabled={busy}
              onValueChange={(next) => {
                setMode(next);
                setReview(null);
                setSetupOpen(false);
              }}
            >
              <SelectTrigger id="agent-authentication-mode" className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modes.map((option) => (
                  <SelectItem key={option.id} value={option.id} disabled={!option.available}>
                    {option.label}
                    {option.available ? '' : ' — not available yet'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!review &&
            (targetUi ? (
              <Button type="button" size="sm" disabled={busy} onClick={() => setSetupOpen(true)}>
                {`${mode === policy.mode ? 'Change' : 'Set up'} ${labelFor(mode)} connection`}
              </Button>
            ) : mode === policy.mode ? null : targetDefault ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void preview({ mode, defaultConnectionId: targetDefault })}
              >
                Review mode change
              </Button>
            ) : (
              <p>{labelFor(mode)} needs a ready platform connection before it can be selected.</p>
            ))}
        </>
      ) : (
        <p>
          <strong>Platform mode: {labelFor(policy.mode)}</strong>
          {scope === 'space' &&
            ` · ${hasOverride ? `Space ${targetUi?.noun ?? 'key'} override` : 'Inherits platform connection'}`}
        </p>
      )}
      {scope === 'space' &&
        targetUi &&
        (authentication.canManageConnections && spaceProjectId ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => setSetupOpen(true)}>
              {`${hasOverride ? 'Change' : 'Set'} space ${targetUi.noun}`}
            </Button>
            {hasOverride && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void preview({
                    kind: 'space-selection',
                    projectId: spaceProjectId,
                    connectionId: null,
                  })
                }
              >
                Use platform connection
              </Button>
            )}
          </div>
        ) : (
          <p>Only platform administrators can configure space connections.</p>
        ))}
      {connection && (
        <p>
          Connection: {displayProvider(connection.backend)} ·{' '}
          {connectionStateLabel(connection.state)}
        </p>
      )}
      {summary.length > 0 && (
        <div className="break-all">
          {summary.map((line) => (
            <p key={line.label}>
              {line.label}: {line.value}
            </p>
          ))}
        </div>
      )}
      {reconnectNotice}
      <Disclosure variant="inline" title="How this works">
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Mode changes apply to new work. Started runs keep their selected connection.</p>
          <p>Kiro uses its separate key settings.</p>
        </div>
      </Disclosure>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {review && (
        <AuthenticationImpactReview
          review={review}
          modes={modes}
          applying={busy}
          onApply={() =>
            void perform(async () => {
              await agentsService.applyAuthenticationChange(review.id);
              setReview(null);
              await onApplied();
            })
          }
          onCancel={() => setReview(null)}
        />
      )}
      {setupOpen && targetUi && (
        <targetUi.Setup
          scope={scope}
          projectId={spaceProjectId}
          initial={
            connection?.mode === target && connection.source === scope
              ? connection.configuration
              : undefined
          }
          onClose={() => setSetupOpen(false)}
          onSubmit={submitDraft}
        />
      )}
    </div>
  );
}
