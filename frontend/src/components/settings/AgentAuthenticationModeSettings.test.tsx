import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentAuthenticationView, BedrockIamConfig } from '@/services/agents';
const preview = vi.fn();
const apply = vi.fn();
const config = { roleArn: 'arn:aws:iam::222222222222:role/Inference', region: 'eu-west-1' };
vi.mock('@/services/agents', () => ({
  agentsService: {
    previewAuthenticationChange: (...args: unknown[]) => preview(...args),
    applyAuthenticationChange: (...args: unknown[]) => apply(...args),
  },
}));
vi.mock('./BedrockIamWizard', () => ({
  BedrockIamWizard: ({
    onSave,
    onClose,
  }: {
    onSave: (config: BedrockIamConfig) => Promise<void>;
    onClose: () => void;
  }) => <button onClick={() => void onSave(config).then(onClose)}>Review verified role</button>,
}));
import { AgentAuthenticationModeSettings } from './AgentAuthenticationModeSettings';
const authentication: AgentAuthenticationView = {
  policy: { mode: 'iam', revision: 1, defaultConnectionId: 'iam-platform' },
  modes: [
    { id: 'keys', label: 'Keys', available: true },
    { id: 'iam', label: 'IAM', available: true },
  ],
  reviewRequired: true,
  canManageIam: true,
  personalMechanisms: [],
  connection: {
    id: 'iam-space',
    source: 'space',
    backend: 'bedrock',
    mechanism: 'assume-role',
    state: 'ready',
    configuration: config,
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  preview.mockResolvedValue({
    id: 'review',
    createdAt: new Date().toISOString(),
    policyRevision: 1,
    candidate: { kind: 'iam-connection', connection: { source: 'space', configuration: config } },
    complete: true,
    limitations: [],
    counts: {},
    items: [],
  });
  apply.mockResolvedValue({ saved: true });
});
describe('reviewed IAM controls', () => {
  it('previews a verified space role, displays its destination and applies only after confirmation', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn(async () => {});
    render(
      <AgentAuthenticationModeSettings
        authentication={authentication}
        scope="space"
        projectId="p"
        hasOverride
        onApplied={onApplied}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Change space IAM role' }));
    await user.click(screen.getByRole('button', { name: 'Review verified role' }));
    await screen.findByText(/Proposed space IAM role/);
    expect(preview).toHaveBeenCalledWith({
      kind: 'iam-connection',
      projectId: 'p',
      configuration: config,
    });
    expect(apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply reviewed change' }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith('review'));
    expect(onApplied).toHaveBeenCalledOnce();
  });
  it('keeps IAM management unavailable to space admins who are not platform admins', () => {
    render(
      <AgentAuthenticationModeSettings
        authentication={{ ...authentication, canManageIam: false }}
        scope="space"
        projectId="p"
        hasOverride
        onApplied={async () => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Change space IAM role' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only platform administrators/)).toBeInTheDocument();
  });
  it('reviews removal of a space override and switching the platform back to keys', async () => {
    const user = userEvent.setup();
    const result = render(
      <AgentAuthenticationModeSettings
        authentication={authentication}
        scope="space"
        projectId="p"
        hasOverride
        onApplied={async () => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Use platform IAM role' }));
    expect(preview).toHaveBeenCalledWith({ kind: 'space-inherit', projectId: 'p' });
    result.unmount();
    render(
      <AgentAuthenticationModeSettings
        authentication={authentication}
        scope="platform"
        hasOverride={false}
        onApplied={async () => {}}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Agent authentication mode'), 'keys');
    await user.click(screen.getByRole('button', { name: 'Review mode change' }));
    expect(preview).toHaveBeenLastCalledWith({
      mode: 'keys',
      defaultConnectionId: 'legacy-platform-bedrock',
    });
    expect(apply).not.toHaveBeenCalled();
  });
});
