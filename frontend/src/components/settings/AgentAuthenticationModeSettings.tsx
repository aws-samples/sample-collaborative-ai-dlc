import { useState } from 'react';
import {
  agentsService,
  type AgentAuthChangeRequest,
  type AgentAuthenticationView,
  type AgentAuthImpactReview,
} from '@/services/agents';
import { Button } from '@/components/ui/button';
import { AuthenticationImpactReview } from './AuthenticationImpactReview';
import { agentAuthProviderUi } from './agent-auth/registry';
import { summarizeConfiguration } from './agent-auth/summary';

const MECHANISM_LABELS: Record<string, string> = { 'api-key': 'API keys' };

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
    <div className="space-y-2 rounded-md bg-muted/40 p-3 text-xs">
      {scope === 'platform' ? (
        <>
          <label className="block font-medium" htmlFor="agent-authentication-mode">
            Agent authentication mode
          </label>
          <select
            id="agent-authentication-mode"
            className="rounded border bg-background p-2"
            value={mode}
            disabled={busy}
            onChange={(event) => {
              setMode(event.target.value);
              setReview(null);
              setSetupOpen(false);
            }}
          >
            {modes.map((option) => (
              <option key={option.id} value={option.id} disabled={!option.available}>
                {option.label}
                {option.available ? '' : ' — provider not yet available'}
              </option>
            ))}
          </select>
          <p>Mode changes apply to new work. Started runs keep their selected connection.</p>
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
      {scope === 'personal' && (
        <p>
          {authentication.personalMechanisms.length
            ? `Personal overrides use ${authentication.personalMechanisms
                .map((mechanism) => MECHANISM_LABELS[mechanism] ?? mechanism)
                .join(' or ')}.`
            : `Personal overrides are unavailable while the platform uses ${labelFor(policy.mode)}.`}{' '}
          Shared connections are managed by platform administrators.
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
          Connection: {connection.backend} · {connection.state}
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
      {connection?.state === 'reconnect-required' && (
        <p role="status">
          An administrator must reconnect this shared connection before new invocations can run.
        </p>
      )}
      <p>Kiro uses its separate key settings.</p>
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
      {setupOpen && targetUi && scope !== 'personal' && (
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
