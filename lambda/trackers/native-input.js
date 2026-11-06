import { createHash } from 'node:crypto';
import { canonicalJson } from '../shared/workflow-checkpoint.js';
import { MAX_ATTACHMENT_BYTES } from '../shared/intent-attachments.js';

export const trackerBindingFingerprint = (binding, credentialIdentity = null) =>
  createHash('sha256')
    .update(
      canonicalJson({
        credentialIdentity,
        binding: Object.fromEntries(
          [
            'id',
            'provider',
            'instance',
            'externalProjectKey',
            'createdAt',
            'createdBy',
            'delegatedAt',
            'connectionUserId',
            'cloudId',
            'externalProjectId',
            'status',
          ].map((key) => [key, binding[key] ?? null]),
        ),
      }),
    )
    .digest('hex');
const unavailable = () =>
  Object.assign(new Error('Tracker input is unavailable'), {
    code: 'NATIVE_TRACKER_UNAVAILABLE',
  });
export const nativeTrackerCredentialIdentity = async ({ binding, context, readSourceAccess }) => {
  if (binding.provider === 'jira-cloud') {
    const connection = await context.resolveConnection();
    return Object.fromEntries(
      [
        'userId',
        'providerInstance',
        'oauthClientId',
        'parameterName',
        'cloudId',
        'baseUrl',
        'createdAt',
      ].map((key) => [key, connection[key] ?? null]),
    );
  }
  const result = await readSourceAccess({
    provider: binding.provider === 'github-issues' ? 'github' : 'gitlab',
    repository: binding.externalProjectKey,
  });
  if (!result?.ok || !result.source?.bindingRevision || !result.source?.credentialIdentity)
    throw unavailable();
  return {
    bindingRevision: result.source.bindingRevision,
    credentialIdentity: result.source.credentialIdentity,
  };
};
export const captureTrackerInput = async ({
  event,
  binding,
  provider,
  context,
  recheck,
  credentialIdentity = null,
}) => {
  if (!['github-issues', 'gitlab-issues', 'jira-cloud'].includes(binding.provider))
    throw unavailable();
  const fingerprint = trackerBindingFingerprint(binding, credentialIdentity);
  if (event.bindingFingerprint && event.bindingFingerprint !== fingerprint) throw unavailable();
  // Read the exact issue through the existing project-bound provider. The
  // check operation confirms current access without replacing captured text.
  const issue = await provider.getIssue(context, binding.externalProjectKey, event.resourceId);
  if (
    !issue ||
    String(issue.resourceId) !== String(event.resourceId) ||
    typeof issue.title !== 'string' ||
    !issue.title.trim()
  )
    throw unavailable();
  if (event.action === 'native-issue-check') {
    await recheck(fingerprint);
    return { ok: true, bindingFingerprint: fingerprint };
  }
  const comments = await provider.getIssueDiscussion(
    context,
    binding.externalProjectKey,
    event.resourceId,
    { complete: true },
  );
  if (!Array.isArray(comments)) throw unavailable();
  const text = [
    `# ${issue.title}\n\n${issue.body ?? ''}`,
    ...comments.map(
      (comment) =>
        `## Comment ${comment.id} by ${comment.author?.handle ?? 'unknown'} (${comment.createdAt ?? ''})\n\n${comment.body ?? ''}`,
    ),
  ].join('\n\n');
  if (Buffer.byteLength(text) > MAX_ATTACHMENT_BYTES || text.includes('\0')) throw unavailable();
  await recheck(fingerprint);
  return {
    ok: true,
    text,
    source: {
      provider: binding.provider,
      bindingId: binding.id,
      resourceId: String(event.resourceId),
      bindingFingerprint: fingerprint,
      title: issue.title,
    },
  };
};
