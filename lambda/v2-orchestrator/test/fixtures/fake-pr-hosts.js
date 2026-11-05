// In-memory code hosts behind the real provider adapters. GitHub, GitLab and
// Bitbucket are served through `ctx.fetchImpl`; CodeCommit through `ctx.client`.
// Each host keeps one shared pull-request model and renders it in that
// provider's list/get/create wire shapes, including pagination and list order.
import { getProvider } from '../../../shared/git-providers.js';

export const REPOS = {
  github: 'owner/api',
  gitlab: 'group/api',
  bitbucket: 'ws/api',
  codecommit: 'arn:aws:codecommit:eu-west-1:123456789012:api',
};

const json = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
  headers: { get: () => null },
});

export const createFakeHost = (name, { order = 'newest', pageSize } = {}) => {
  const host = {
    name,
    repo: REPOS[name],
    provider: getProvider(name),
    prs: [],
    branches: new Map([
      ['develop', 'base1'],
      ['intent/feature', 'head1'],
    ]),
    order,
    // Provider clock relative to the local clock (skew), applied to new PRs.
    clockOffsetMs: 0,
    // Requests that fail before (failCreates) or after (loseResponses) the
    // provider created the pull request.
    failCreates: 0,
    loseResponses: 0,
    creates: 0,
  };
  let next = 1;
  host.add = ({ state = 'closed', body = '', ageMs = 0, source = 'intent/feature', target }) => {
    const pr = {
      number: next++,
      state,
      source,
      target: target ?? 'develop',
      body,
      title: 'AI-DLC',
      headSha: 'head1',
      createdAt: Date.now() + host.clockOffsetMs - ageMs,
      token: null,
    };
    host.prs.push(pr);
    return pr;
  };
  host.get = (number) => host.prs.find((pr) => pr.number === Number(number));
  const listed = (prs) =>
    [...prs].sort((a, b) => (host.order === 'oldest' ? a.number - b.number : b.number - a.number));
  const page = (rows, size, index) => rows.slice((index - 1) * size, index * size);
  const create = ({ source, target, body, title, token }) => {
    host.creates += 1;
    if (host.failCreates > 0) {
      host.failCreates -= 1;
      throw new Error('socket hang up');
    }
    const pr = host.add({ state: 'open', body, source, target });
    pr.title = title;
    pr.token = token ?? null;
    if (host.loseResponses > 0) {
      host.loseResponses -= 1;
      throw new Error('socket closed after the request was accepted');
    }
    return pr;
  };

  if (name === 'github') {
    const shape = (pr) => ({
      id: pr.number * 10,
      node_id: `PR_${pr.number}`,
      number: pr.number,
      html_url: `https://github.example/owner/api/pull/${pr.number}`,
      state: pr.state === 'open' ? 'open' : 'closed',
      merged_at: pr.state === 'merged' ? new Date(pr.createdAt).toISOString() : null,
      closed_at: pr.state === 'open' ? null : new Date(pr.createdAt).toISOString(),
      created_at: new Date(pr.createdAt).toISOString(),
      updated_at: new Date(pr.createdAt).toISOString(),
      head: { ref: pr.source, sha: pr.headSha },
      base: { ref: pr.target, sha: 'base1' },
      title: pr.title,
      body: pr.body,
      draft: false,
    });
    host.ctx = {
      token: 'test',
      fetchImpl: async (url, options = {}) => {
        const u = new URL(url);
        const path = u.pathname.replace('/repos/owner/api', '');
        if (options.method === 'POST' && path === '/pulls') {
          const input = JSON.parse(options.body);
          if (
            host.prs.some(
              (pr) => pr.state === 'open' && pr.source === input.head && pr.target === input.base,
            )
          )
            return json(
              {
                message: 'Validation Failed',
                errors: [{ message: 'A pull request already exists' }],
              },
              422,
            );
          return json(
            shape(
              create({
                source: input.head,
                target: input.base,
                body: input.body,
                title: input.title,
              }),
            ),
            201,
          );
        }
        if (path === '') return json({ default_branch: 'develop' });
        if (path.startsWith('/git/matching-refs/')) return json([]);
        if (path.startsWith('/git/ref/heads/')) {
          const sha = host.branches.get(decodeURIComponent(path.slice('/git/ref/heads/'.length)));
          return sha ? json({ object: { sha } }) : json({ message: 'Not Found' }, 404);
        }
        const one = path.match(/^\/pulls\/(\d+)$/);
        if (one) return host.get(one[1]) ? json(shape(host.get(one[1]))) : json({}, 404);
        if (path === '/pulls') {
          const head = u.searchParams.get('head');
          const state = u.searchParams.get('state') ?? 'open';
          const base = u.searchParams.get('base');
          const rows = listed(
            host.prs.filter(
              (pr) =>
                (!head || head === `owner:${pr.source}`) &&
                (!base || pr.target === base) &&
                (state === 'all' || (state === 'open') === (pr.state === 'open')),
            ),
          );
          const size = Math.min(Number(u.searchParams.get('per_page') ?? 30), pageSize ?? 100);
          return json(page(rows, size, Number(u.searchParams.get('page') ?? 1)).map(shape));
        }
        throw new Error(`fake GitHub: unexpected ${options.method ?? 'GET'} ${url}`);
      },
    };
  } else if (name === 'gitlab') {
    const shape = (pr) => ({
      id: pr.number * 10,
      iid: pr.number,
      web_url: `https://gitlab.example/group/api/-/merge_requests/${pr.number}`,
      state: pr.state === 'open' ? 'opened' : pr.state,
      created_at: new Date(pr.createdAt).toISOString(),
      updated_at: new Date(pr.createdAt).toISOString(),
      source_branch: pr.source,
      target_branch: pr.target,
      sha: pr.headSha,
      diff_refs: { head_sha: pr.headSha, base_sha: 'base1' },
      title: pr.title,
      description: pr.body,
      draft: false,
    });
    host.ctx = {
      token: 'test',
      fetchImpl: async (url, options = {}) => {
        const u = new URL(url);
        const path = u.pathname.replace('/api/v4/projects/group%2Fapi', '');
        if (options.method === 'POST' && path === '/merge_requests') {
          const input = JSON.parse(options.body);
          if (
            host.prs.some(
              (pr) =>
                pr.state === 'open' &&
                pr.source === input.source_branch &&
                pr.target === input.target_branch,
            )
          )
            return json({ message: ['Another open merge request already exists'] }, 409);
          return json(
            shape(
              create({
                source: input.source_branch,
                target: input.target_branch,
                body: input.description,
                title: input.title,
              }),
            ),
            201,
          );
        }
        if (path === '') return json({ default_branch: 'develop' });
        if (path === '/repository/branches') return json([]);
        if (path.startsWith('/repository/branches/')) {
          const sha = host.branches.get(
            decodeURIComponent(path.slice('/repository/branches/'.length)),
          );
          return sha ? json({ commit: { id: sha } }) : json({ message: 'Not Found' }, 404);
        }
        const one = path.match(/^\/merge_requests\/(\d+)$/);
        if (one) return host.get(one[1]) ? json(shape(host.get(one[1]))) : json({}, 404);
        if (path === '/merge_requests') {
          const source = u.searchParams.get('source_branch');
          const target = u.searchParams.get('target_branch');
          const state = u.searchParams.get('state') ?? 'all';
          const rows = listed(
            host.prs.filter(
              (pr) =>
                (!source || pr.source === source) &&
                (!target || pr.target === target) &&
                (state === 'all' || shape(pr).state === state),
            ),
          );
          const size = Math.min(Number(u.searchParams.get('per_page') ?? 20), pageSize ?? 100);
          return json(page(rows, size, Number(u.searchParams.get('page') ?? 1)).map(shape));
        }
        throw new Error(`fake GitLab: unexpected ${options.method ?? 'GET'} ${url}`);
      },
    };
  } else if (name === 'bitbucket') {
    const states = { open: 'OPEN', closed: 'DECLINED', merged: 'MERGED' };
    const shape = (pr) => ({
      id: pr.number,
      links: { html: { href: `https://bitbucket.example/ws/api/pull-requests/${pr.number}` } },
      state: states[pr.state],
      created_on: new Date(pr.createdAt).toISOString(),
      updated_on: new Date(pr.createdAt).toISOString(),
      source: { branch: { name: pr.source }, commit: { hash: pr.headSha } },
      destination: { branch: { name: pr.target }, commit: { hash: 'base1' } },
      title: pr.title,
      description: pr.body,
      draft: false,
    });
    host.ctx = {
      token: 'test',
      fetchImpl: async (url, options = {}) => {
        const u = new URL(url);
        const path = u.pathname.replace('/2.0/repositories/ws/api', '');
        if (options.method === 'POST' && path === '/pullrequests') {
          const input = JSON.parse(options.body);
          if (
            host.prs.some(
              (pr) =>
                pr.state === 'open' &&
                pr.source === input.source.branch.name &&
                pr.target === input.destination.branch.name,
            )
          )
            return json({ error: { message: 'There is already an open pull request' } }, 409);
          return json(
            shape(
              create({
                source: input.source.branch.name,
                target: input.destination.branch.name,
                body: input.description,
                title: input.title,
              }),
            ),
            201,
          );
        }
        if (path === '') return json({ mainbranch: { name: 'develop' } });
        if (path === '/refs/branches')
          return json({ values: [...host.branches.keys()].map((branch) => ({ name: branch })) });
        if (path.startsWith('/refs/branches/')) {
          const sha = host.branches.get(decodeURIComponent(path.slice('/refs/branches/'.length)));
          return sha ? json({ target: { hash: sha } }) : json({ error: {} }, 404);
        }
        const one = path.match(/^\/pullrequests\/(\d+)$/);
        if (one) return host.get(one[1]) ? json(shape(host.get(one[1]))) : json({}, 404);
        if (path === '/pullrequests') {
          const q = u.searchParams.get('q') ?? '';
          const source = q.match(/source\.branch\.name="([^"]+)"/)?.[1];
          const target = q.match(/destination\.branch\.name="([^"]+)"/)?.[1];
          const wanted = [...q.matchAll(/state="([A-Z]+)"/g)].map((m) => m[1]);
          const rows = listed(
            host.prs.filter(
              (pr) =>
                (!source || pr.source === source) &&
                (!target || pr.target === target) &&
                (!wanted.length || wanted.includes(states[pr.state])),
            ),
          );
          const size = Math.min(Number(u.searchParams.get('pagelen') ?? 10), pageSize ?? 50);
          const index = Number(u.searchParams.get('page') ?? 1);
          const nextUrl = new URL(url);
          nextUrl.searchParams.set('page', String(index + 1));
          return json({
            values: page(rows, size, index).map(shape),
            ...(index * size < rows.length ? { next: nextUrl.toString() } : {}),
          });
        }
        throw new Error(`fake Bitbucket: unexpected ${options.method ?? 'GET'} ${url}`);
      },
    };
  } else if (name === 'codecommit') {
    const raw = (pr) => ({
      pullRequestId: String(pr.number),
      pullRequestStatus: pr.state === 'open' ? 'OPEN' : 'CLOSED',
      title: pr.title,
      description: pr.body,
      creationDate: new Date(pr.createdAt),
      lastActivityDate: new Date(pr.createdAt),
      clientRequestToken: pr.token,
      revisionId: `rev-${pr.number}`,
      pullRequestTargets: [
        {
          repositoryName: 'api',
          sourceReference: `refs/heads/${pr.source}`,
          destinationReference: `refs/heads/${pr.target}`,
          sourceCommit: pr.headSha,
          destinationCommit: 'base1',
          mergeMetadata: { isMerged: pr.state === 'merged' },
        },
      ],
    });
    const notFound = (exception) =>
      Object.assign(new Error(exception), {
        name: exception,
        $metadata: { httpStatusCode: 400 },
      });
    host.ctx = {
      token: {
        assumedRoleArn: 'arn:aws:sts::123456789012:assumed-role/platform/session',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      },
      client: {
        send: async (command) => {
          const input = command.input ?? {};
          switch (command.constructor.name) {
            case 'GetRepositoryCommand':
              return { repositoryMetadata: { repositoryName: 'api', defaultBranch: 'develop' } };
            case 'GetBranchCommand': {
              const sha = host.branches.get(input.branchName);
              if (!sha) throw notFound('BranchDoesNotExistException');
              return { branch: { branchName: input.branchName, commitId: sha } };
            }
            case 'ListBranchesCommand':
              return { branches: [...host.branches.keys()] };
            case 'GetMergeOptionsCommand':
              return {
                mergeOptions: ['FAST_FORWARD_MERGE'],
                sourceCommitId: 'head1',
                destinationCommitId: 'base1',
                baseCommitId: 'base1',
              };
            case 'EvaluatePullRequestApprovalRulesCommand':
              return { evaluation: { approved: false, overridden: false } };
            case 'ListPullRequestsCommand': {
              const wanted = input.pullRequestStatus;
              const ids = listed(
                host.prs.filter((pr) => !wanted || raw(pr).pullRequestStatus === wanted),
              ).map((pr) => String(pr.number));
              const size = pageSize ?? 100;
              const index = Number(input.nextToken ?? 1);
              return {
                pullRequestIds: page(ids, size, index),
                ...(index * size < ids.length ? { nextToken: String(index + 1) } : {}),
              };
            }
            case 'GetPullRequestCommand': {
              const pr = host.get(input.pullRequestId);
              if (!pr) throw notFound('PullRequestDoesNotExistException');
              return { pullRequest: raw(pr) };
            }
            case 'CreatePullRequestCommand': {
              const replay = host.prs.find(
                (pr) => input.clientRequestToken && pr.token === input.clientRequestToken,
              );
              if (replay) return { pullRequest: raw(replay) };
              const [target] = input.targets;
              return {
                pullRequest: raw(
                  create({
                    source: target.sourceReference.replace('refs/heads/', ''),
                    target: target.destinationReference.replace('refs/heads/', ''),
                    body: input.description,
                    title: input.title,
                    token: input.clientRequestToken,
                  }),
                ),
              };
            }
            default:
              return {};
          }
        },
      },
    };
  }
  return host;
};

// The source-control service's provider dispatch for the operations final
// delivery uses (lambda/source-control/index.js callProvider). Branch
// comparison is not under test here and reports work ahead of the base.
export const hostOperation =
  (host, inspectDelivery) =>
  async ({ repo, operation, args }) => {
    if (operation === 'delivery-inspect')
      return inspectDelivery(host.provider, host.ctx, repo, args);
    if (operation === 'compare') return { status: 'ahead', base: args.base };
    if (operation === 'create-pr') {
      if (args.expectedHeadSha) {
        const head = await host.provider.getBranchHead(host.ctx, repo, args.branch);
        if (head !== args.expectedHeadSha) return { failed: true, reason: 'branch_changed' };
        if (
          !args.baseBranch ||
          !(await host.provider.getBranchHead(host.ctx, repo, args.baseBranch))
        )
          return { failed: true, reason: 'missing_base' };
      }
      return host.provider.createPullRequest(host.ctx, repo, args);
    }
    throw new Error(`unexpected operation ${operation}`);
  };
