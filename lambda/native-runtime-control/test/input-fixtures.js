import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { captureTrackerInput, trackerBindingFingerprint } from '../../trackers/native-input.js';
import { provider as gitlabIssues } from '../../trackers/providers/gitlab-issues.js';
import { provider as githubIssues } from '../../trackers/providers/github-issues.js';
import { provider as jiraIssues } from '../../trackers/providers/jira-cloud.js';
import { getProvider } from '../../shared/git-providers.js';

// Versioned local storage and finite provider responses. Real promotion,
// normalization, provider URL policy and materialization run against these ports.
export const inputFixture = (trackerProvider = 'gitlab-issues') => {
  let serial = 0;
  const objects = new Map();
  const put = (key, bytes, type = 'text/plain') => {
    const version = `input-version-${++serial}`;
    objects.set(`${key}:${version}`, { bytes: Buffer.from(bytes), type });
    objects.set(key, version);
    return version;
  };
  const calls = [];
  const s3 = {
    async send(command) {
      calls.push(command);
      const { Key, VersionId, Body, ContentType } = command.input;
      if (command instanceof PutObjectCommand) return { VersionId: put(Key, Body, ContentType) };
      if (command instanceof CopyObjectCommand) {
        const source = new URL(`https://storage.test/${command.input.CopySource}`);
        const key = source.pathname.split('/').slice(2).join('/');
        const object = objects.get(`${key}:${source.searchParams.get('versionId')}`);
        if (!object) throw new Error('Source version absent');
        return { VersionId: put(Key, object.bytes, ContentType || object.type) };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(`${Key}:${VersionId}`);
        return {};
      }
      const version = VersionId ?? objects.get(Key);
      const object = objects.get(`${Key}:${version}`);
      if (!object) throw Object.assign(new Error('Object absent'), { name: 'NoSuchKey' });
      const metadata = {
        VersionId: version,
        ContentLength: object.bytes.length,
        ContentType: object.type,
      };
      if (command instanceof HeadObjectCommand) return metadata;
      if (command instanceof GetObjectCommand)
        return { ...metadata, Body: Readable.from([object.bytes]) };
      throw new Error(`Unexpected input storage operation ${command.constructor.name}`);
    },
  };
  const state = {
    access: true,
    failDownload: false,
    commit: 'c'.repeat(40),
    credentialIdentity: { generation: 'original' },
    text: 'Original tracker specification.',
    attachment: Buffer.from('Original required attachment.\n'),
    binding: {
      id: 'tracker-one',
      provider: trackerProvider,
      instance: 'public',
      externalProjectKey: 'group/application',
      createdAt: '2026-11-06T00:00:00Z',
    },
  };
  const attachmentPath = `/group/application/uploads/${'a'.repeat(32)}/requirements.txt`;
  const provider = getProvider(trackerProvider === 'github-issues' ? 'github' : 'gitlab');
  const tracker = {
    'github-issues': githubIssues,
    'gitlab-issues': gitlabIssues,
    'jira-cloud': jiraIssues,
  }[trackerProvider];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    if (target.hostname === 'native-inputs.s3.amazonaws.com' && options.method === 'PUT') {
      const version = put(
        decodeURIComponent(target.pathname.slice(1)),
        options.body,
        options.headers['Content-Type'],
      );
      return new Response('', { status: 200, headers: { 'x-amz-version-id': version } });
    }
    if (!state.access) return new Response('', { status: 403 });
    if (
      ['api.github.com', 'gitlab.com', 'api.bitbucket.org'].includes(target.hostname) &&
      target.pathname.includes('/branches/')
    )
      return Response.json({
        name: 'main',
        commit: { sha: state.commit, id: state.commit },
        target: { hash: state.commit },
      });
    if (
      [
        '/api/v4/projects/group%2Fapplication',
        '/repos/group/application',
        '/2.0/repositories/group/application',
      ].includes(target.pathname)
    )
      return Response.json({ default_branch: 'main', mainbranch: { name: 'main' } });
    const githubUrl = 'https://github.com/user-attachments/files/123/requirements.txt';
    if (
      ['gitlab.com', 'api.github.com'].includes(target.hostname) &&
      target.pathname.endsWith('/issues/7')
    )
      return Response.json({
        iid: 7,
        number: 7,
        title: 'Tracker specification',
        description: `${state.text}\n[required input](https://gitlab.com${attachmentPath})`,
        body: `${state.text}\n[required input](${githubUrl})`,
        web_url: 'https://gitlab.com/group/application/-/issues/7',
        html_url: 'https://github.com/group/application/issues/7',
        state: 'opened',
      });
    if (
      ['gitlab.com', 'api.github.com'].includes(target.hostname) &&
      /\/issues\/7\/(notes|comments)$/.test(target.pathname)
    )
      return Response.json([
        {
          id: 10,
          body: 'Preserve explicit human gates.',
          author: { username: 'member' },
          user: { login: 'member' },
          created_at: '2026-11-06T00:00:00Z',
        },
      ]);
    if (
      (target.hostname === 'gitlab.com' &&
        target.pathname.includes(`/uploads/${'a'.repeat(32)}/requirements.txt`)) ||
      url === githubUrl ||
      (target.hostname === 'api.atlassian.com' &&
        target.pathname.endsWith('/attachment/content/123'))
    ) {
      await state.beforeDownload?.();
      return new Response(state.failDownload ? '' : state.attachment, {
        status: state.failDownload ? 403 : 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    if (target.hostname === 'api.atlassian.com' && target.pathname.endsWith('/issue/7'))
      return Response.json({
        key: '7',
        fields: {
          summary: 'Tracker specification',
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: state.text }] }],
          },
          project: { id: 'jira-project', key: 'PROJ' },
          attachment: [
            {
              id: '123',
              filename: 'requirements.txt',
              mimeType: 'text/plain',
              size: state.attachment.length,
            },
          ],
        },
      });
    if (target.hostname === 'api.atlassian.com' && target.pathname.endsWith('/issue/7/comment'))
      return Response.json({
        startAt: 0,
        total: 1,
        comments: [
          {
            id: '10',
            body: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Preserve explicit human gates.' }],
                },
              ],
            },
          },
        ],
      });
    throw new Error(`Unrecorded provider request: ${target.pathname}`);
  };
  const context = {
    sourceControl: async ({ repository, operation, args }) => {
      const ctx = { token: 'fixture-source-token', fetchImpl };
      if (operation === 'get-issue') return provider.getIssue(ctx, repository, args.number);
      if (operation === 'list-issue-comments')
        return provider.listIssueComments(ctx, repository, args.number, {
          complete: args.complete,
        });
      if (operation === 'issue-attachments')
        return provider.issueAttachments(ctx, repository, args);
      throw new Error('Unrecorded tracker operation');
    },
  };
  const jiraContext = {
    resolveConnection: async () => ({
      userId: 'member',
      parameterName: '/fixture/jira/token/member',
      oauthClientId: 'fixture-client',
      baseUrl: 'https://api.atlassian.com/ex/jira/site',
      cloudId: 'site',
      siteHost: 'fixture.atlassian.net',
    }),
    externalProjectId: 'jira-project',
    ssm: {
      send: async () => ({
        Parameter: {
          Value: JSON.stringify({ accessToken: 'fixture-token', expiresAt: Date.now() + 3600000 }),
        },
      }),
    },
    secrets: {
      send: async () => ({
        SecretString: JSON.stringify({
          client_id: 'fixture-client',
          client_secret: 'fixture-secret',
        }),
      }),
    },
  };
  const trackerContext = trackerProvider === 'jira-cloud' ? jiraContext : context;
  const invokeTracker = async (event) => {
    if (!state.access || event.bindingId !== state.binding.id || event.resourceId !== '7')
      return { status: 'failed', reason: 'Source access denied' };
    const recheck = async (fingerprint) => {
      if (
        !state.access ||
        trackerBindingFingerprint(state.binding, state.credentialIdentity) !== fingerprint
      )
        throw new Error('Source access changed');
    };
    if (event.action !== 'issue-attachments')
      return captureTrackerInput({
        event,
        binding: state.binding,
        provider: tracker,
        context: trackerContext,
        credentialIdentity: state.credentialIdentity,
        recheck,
      }).catch(() => ({ status: 'failed', reason: 'Tracker owner denied current access' }));
    if (
      event.bindingFingerprint !==
      trackerBindingFingerprint(state.binding, state.credentialIdentity)
    )
      return { status: 'failed', reason: 'Source binding changed' };
    const result = await tracker.issueAttachments(
      trackerContext,
      state.binding.externalProjectKey,
      event.resourceId,
      event,
    );
    await recheck(event.bindingFingerprint);
    return result;
  };
  return {
    state,
    s3,
    put,
    calls,
    objects,
    invokeTracker,
    fetchImpl,
    signUpload: async (key) => `https://native-inputs.s3.amazonaws.com/${key}`,
    trackerUpload: async (_bucket, key) => `https://native-inputs.s3.amazonaws.com/${key}`,
  };
};
