import { useState } from 'react';
import {
  agentsService,
  type AgentAuthenticationView,
  type AgentAuthImpactReview,
} from '@/services/agents';
import { Button } from '@/components/ui/button';
import { AuthenticationImpactReview } from './AuthenticationImpactReview';

export function AgentAuthenticationModeSettings({
  authentication,
  scope,
  hasOverride,
  onApplied,
}: {
  authentication: AgentAuthenticationView;
  scope: 'platform' | 'space' | 'personal';
  hasOverride: boolean;
  onApplied: () => Promise<unknown>;
}) {
  const [mode, setMode] = useState(authentication.policy.mode);
  const [review, setReview] = useState<AgentAuthImpactReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = authentication.connection;
  const perform = async (apply: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (apply && review) {
        await agentsService.applyAuthenticationChange(review.id);
        setReview(null);
        await onApplied();
      } else {
        setReview(
          await agentsService.previewAuthenticationChange({
            mode,
            defaultConnectionId: authentication.policy.defaultConnectionId,
          }),
        );
      }
    } catch (failure) {
      setReview(null);
      setError(failure instanceof Error ? failure.message : 'Configuration changed; review again.');
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
            }}
          >
            {authentication.modes.map((option) => (
              <option key={option.id} value={option.id} disabled={!option.available}>
                {option.label}
                {option.available ? '' : ' — provider not yet available'}
              </option>
            ))}
          </select>
          <p>Mode changes apply to new work. Existing runs keep their pinned connection.</p>
          {mode !== authentication.policy.mode && !review && (
            <Button type="button" size="sm" disabled={busy} onClick={() => void perform(false)}>
              Review mode change
            </Button>
          )}
        </>
      ) : (
        <p>
          <strong>
            Platform mode:{' '}
            {authentication.modes.find((option) => option.id === authentication.policy.mode)
              ?.label ?? authentication.policy.mode}
          </strong>
          {scope === 'space' &&
            ` · ${hasOverride ? 'Space key override' : 'Inherits platform connection'}`}
        </p>
      )}
      {scope === 'personal' && (
        <p>
          Personal overrides use API keys. IAM roles and shared OAuth connections are managed by
          administrators.
        </p>
      )}
      {connection && (
        <p>
          Connection: {connection.backend} · {connection.state}
        </p>
      )}
      {connection?.configuration.endpoint && <p>Gateway: {connection.configuration.endpoint}</p>}
      {connection?.configuration.issuer && (
        <p>Identity provider: {connection.configuration.issuer}</p>
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
          applying={busy}
          onApply={() => void perform(true)}
          onCancel={() => setReview(null)}
        />
      )}
    </div>
  );
}
