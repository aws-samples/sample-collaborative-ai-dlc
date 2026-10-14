import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { getProvider } from '../git-providers.js';

const provider = getProvider('bitbucket');
const input = {
  branch: 'aidlc/example',
  baseBranch: 'main',
  title: 'Example',
  body: 'Example work',
  draft: true,
};
const pullRequest = {
  id: 42,
  state: 'OPEN',
  draft: true,
  links: { html: { href: 'https://example.invalid/pr/42' } },
  source: { branch: { name: input.branch }, commit: { hash: 'a'.repeat(40) } },
  destination: { branch: { name: input.baseBranch }, commit: { hash: 'b'.repeat(40) } },
};

// Real HTTP bodies and connection loss, with every provider request redirected
// to this task-owned loopback fixture before any network operation.
const withProvider = async ({ pr, loseAcknowledgement = false }, run) => {
  const requests = [];
  let exists = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && url.pathname.endsWith('/refs/branches')) {
      res.end(JSON.stringify({ values: [] }));
    } else if (req.method === 'GET' && url.pathname.endsWith('/pullrequests')) {
      res.end(JSON.stringify({ values: exists ? [pr] : [] }));
    } else if (req.method === 'POST' && url.pathname.endsWith('/pullrequests')) {
      exists = true;
      if (loseAcknowledgement) res.destroy();
      else {
        res.writeHead(409);
        res.end(JSON.stringify({ error: { message: 'Pull request already exists' } }));
      }
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const ctx = {
      token: 'inert-loopback-token',
      fetchImpl: (url, options) => {
        const target = new URL(url);
        expect(target.origin).toBe('https://api.bitbucket.org');
        expect(target.pathname.startsWith('/2.0/repositories/ws/repo/')).toBe(true);
        return fetch(
          `http://127.0.0.1:${server.address().port}${target.pathname}${target.search}`,
          { ...options, redirect: 'error', signal: AbortSignal.timeout(3000) },
        );
      },
    };
    await run(ctx, requests);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
};

it.each([
  { requestedDraft: true, remoteDraft: true, hashes: true },
  { requestedDraft: true, remoteDraft: false, hashes: true },
  { requestedDraft: true, remoteDraft: true, hashes: false },
  { requestedDraft: false, remoteDraft: false, hashes: true },
])('preserves the recovered 409 PR facts: %j', async ({ requestedDraft, remoteDraft, hashes }) => {
  const pr = structuredClone(pullRequest);
  pr.draft = remoteDraft;
  if (!hashes) {
    delete pr.source.commit;
    delete pr.destination.commit;
  }
  await withProvider({ pr }, async (ctx, requests) => {
    const request = { ...input, draft: requestedDraft };
    const recovered = await provider.createPullRequest(ctx, 'ws/repo', request);
    expect(recovered).toEqual({
      prUrl: pr.links.html.href,
      prNumber: pr.id,
      existing: true,
      ...(requestedDraft
        ? {
            providerId: pr.id,
            headSha: hashes ? pr.source.commit.hash : null,
            targetSha: hashes ? pr.destination.commit.hash : null,
            draft: remoteDraft,
          }
        : {}),
    });
    // An explicit repeat finds the same PR without another remote write.
    expect(await provider.createPullRequest(ctx, 'ws/repo', request)).toEqual(recovered);
    const writes = requests.filter((entry) => entry.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].body)).toMatchObject({
      source: { branch: { name: input.branch } },
      destination: { branch: { name: input.baseBranch } },
      draft: requestedDraft,
    });
    expect(requests.every((entry) => entry.authorization === 'Bearer inert-loopback-token')).toBe(
      true,
    );
  });
});

it('surfaces a lost creation acknowledgement and finds the stored PR on an explicit retry', async () => {
  await withProvider({ pr: pullRequest, loseAcknowledgement: true }, async (ctx, requests) => {
    await expect(provider.createPullRequest(ctx, 'ws/repo', input)).rejects.toThrow();
    expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(1);
    expect(await provider.createPullRequest(ctx, 'ws/repo', input)).toMatchObject({
      prNumber: pullRequest.id,
      providerId: pullRequest.id,
      headSha: pullRequest.source.commit.hash,
      targetSha: pullRequest.destination.commit.hash,
      existing: true,
      draft: true,
    });
    expect(requests.filter((entry) => entry.method !== 'GET')).toHaveLength(1);
  });
});
