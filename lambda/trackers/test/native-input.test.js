import { expect, it, vi } from 'vitest';
import {
  captureTrackerInput,
  nativeTrackerCredentialIdentity,
  trackerBindingFingerprint,
} from '../native-input.js';

const fixture = (provider = 'jira-cloud') => {
  const binding = {
    id: 'binding',
    provider,
    externalProjectKey: 'project',
    connectionUserId: 'delegator',
    delegatedAt: 'original',
  };
  const event = { action: 'native-issue-snapshot', bindingId: binding.id, resourceId: '7' };
  const adapter = {
    getIssue: vi.fn(async () => ({
      resourceId: '7',
      title: 'Specification',
      body: 'Input text, not approval.',
    })),
    getIssueDiscussion: vi.fn(async () => [
      { id: '8', body: 'Required comment', author: { handle: 'member' } },
    ]),
  };
  const credentialIdentity = { parameterName: '/private/original', createdAt: 'original' };
  const recheck = vi.fn(async () => {});
  const run = () =>
    captureTrackerInput({
      event,
      binding,
      provider: adapter,
      context: {},
      credentialIdentity,
      recheck,
    });
  return { binding, event, adapter, credentialIdentity, recheck, run };
};
it.each(['github-issues', 'gitlab-issues', 'jira-cloud'])(
  'captures complete %s text and credential-bound provenance',
  async (provider) => {
    const f = fixture(provider);
    const captured = await f.run();
    expect(captured.text).toContain('Required comment');
    expect(captured.source.bindingFingerprint).toBe(
      trackerBindingFingerprint(f.binding, f.credentialIdentity),
    );
    expect(f.adapter.getIssueDiscussion).toHaveBeenCalledWith({}, 'project', '7', {
      complete: true,
    });
    expect(JSON.stringify(captured)).not.toContain('/private');
    Object.assign(f.event, {
      action: 'native-issue-check',
      bindingFingerprint: captured.source.bindingFingerprint,
    });
    f.adapter.getIssueDiscussion.mockClear();
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.adapter.getIssueDiscussion).not.toHaveBeenCalled();
    f.credentialIdentity.createdAt = 'reconnected';
    await expect(f.run()).rejects.toThrow();
  },
);
it.each(['issue', 'comments', 'membership', 'oversized', 'wrong issue'])(
  'does not label partial %s content successful',
  async (reason) => {
    const f = fixture();
    if (reason === 'issue') f.adapter.getIssue.mockRejectedValue(new Error('revoked'));
    if (reason === 'comments')
      f.adapter.getIssueDiscussion.mockRejectedValue(new Error('page failed'));
    if (reason === 'membership') f.recheck.mockRejectedValue(new Error('removed'));
    if (reason === 'oversized')
      f.adapter.getIssueDiscussion.mockResolvedValue([{ body: 'x'.repeat(5 * 1024 * 1024) }]);
    if (reason === 'wrong issue')
      f.adapter.getIssue.mockResolvedValue({ resourceId: 'another', title: 'Another' });
    await expect(f.run()).rejects.toThrow();
  },
);
it('retains Jira connection identity through token rotation and rejects replacement identity', async () => {
  const row = {
    userId: 'delegator',
    parameterName: '/private/original',
    cloudId: 'site',
    createdAt: 'first',
    accessToken: 'secret',
  };
  const binding = { provider: 'jira-cloud' };
  const context = { resolveConnection: vi.fn(async () => row) };
  const before = await nativeTrackerCredentialIdentity({ binding, context });
  row.accessToken = 'rotated';
  row.expiresAt = 12345;
  expect(await nativeTrackerCredentialIdentity({ binding, context })).toEqual(before);
  row.createdAt = 'replacement';
  expect(await nativeTrackerCredentialIdentity({ binding, context })).not.toEqual(before);
  expect(JSON.stringify(before)).not.toContain('secret');
});
