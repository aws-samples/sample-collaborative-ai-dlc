import { useState } from 'react';
import {
  agentsService,
  type AgentAuthenticationView,
  type AgentAuthImpactReview,
  type BedrockIamConfig,
} from '@/services/agents';
import { Button } from '@/components/ui/button';
import { AuthenticationImpactReview } from './AuthenticationImpactReview';
import { BedrockIamWizard } from './BedrockIamWizard';

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
  const [mode, setMode] = useState(authentication.policy.mode);
  const [review, setReview] = useState<AgentAuthImpactReview | null>(null);
  const [wizard, setWizard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = authentication.connection;
  const canManage = scope === 'platform' || authentication.canManageIam === true;
  const iamActive = authentication.policy.mode === 'iam';
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
  const previewIam = async (configuration: BedrockIamConfig) => {
    setReview(
      await agentsService.previewAuthenticationChange({
        kind: 'iam-connection',
        configuration,
        ...(scope === 'space' ? { projectId } : {}),
      }),
    );
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
          <p>Mode changes apply to new work. Started runs keep their selected connection.</p>
          {mode === 'iam' && !review && (
            <Button type="button" size="sm" disabled={busy} onClick={() => setWizard(true)}>
              {iamActive ? 'Change IAM connection' : 'Set up Bedrock IAM'}
            </Button>
          )}
          {mode !== authentication.policy.mode && mode === 'keys' && !review && (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  setReview(
                    await agentsService.previewAuthenticationChange({
                      mode: 'keys',
                      defaultConnectionId: 'legacy-platform-bedrock',
                    }),
                  );
                })
              }
            >
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
            ` · ${hasOverride ? (iamActive ? 'Space IAM override' : 'Space key override') : 'Inherits platform connection'}`}
        </p>
      )}
      {scope === 'personal' && (
        <p>
          {iamActive
            ? 'Personal Bedrock API keys are disabled while the platform uses IAM.'
            : 'Personal overrides use API keys.'}{' '}
          IAM roles are managed by platform administrators.
        </p>
      )}
      {scope === 'space' &&
        iamActive &&
        (canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => setWizard(true)}>
              {hasOverride ? 'Change space IAM role' : 'Set space IAM role'}
            </Button>
            {hasOverride && projectId && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    setReview(
                      await agentsService.previewAuthenticationChange({
                        kind: 'space-inherit',
                        projectId,
                      }),
                    );
                  })
                }
              >
                Use platform IAM role
              </Button>
            )}
          </div>
        ) : (
          <p>Only platform administrators can configure space IAM roles.</p>
        ))}
      {connection && (
        <p>
          Connection: {connection.backend} · {connection.state}
        </p>
      )}
      {connection?.configuration.roleArn && (
        <p className="break-all">
          Role: {connection.configuration.roleArn} · Region: {connection.configuration.region}
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
      {wizard && (
        <BedrockIamWizard
          projectId={scope === 'space' ? projectId : undefined}
          initial={
            connection?.mechanism === 'assume-role' && (scope === 'platform' || hasOverride)
              ? (connection.configuration as BedrockIamConfig)
              : undefined
          }
          onClose={() => setWizard(false)}
          onSave={previewIam}
        />
      )}
    </div>
  );
}
