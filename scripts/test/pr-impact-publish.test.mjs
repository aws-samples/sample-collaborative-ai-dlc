import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishComplexityComment } from '../publish-complexity-comment.mjs';
import {
  COMMENT_MARKER,
  enrichReviewSignals,
  legacyQualityArtifact,
  publishReviewSignals,
  reviewMetadata,
  validateQualitySnapshot,
  validateReportArtifacts,
} from '../pr-impact/publish.mjs';

const repository = 'aws-samples/sample-collaborative-ai-dlc';
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const mergeBaseSha = 'c'.repeat(40);
const controllerSha = 'd'.repeat(40);
const toolSha = '2ec719904ac7dc30de08e152e4622fe8e02fa57a';
const hash = (text) => createHash('sha1').update(text).digest('hex');
const measured = (covered = 1, partial = false) => ({
  status: 'measured',
  total: 2,
  covered,
  uncovered: 2 - covered,
  percent: 50 * covered,
  partial,
});

function quality(coverage = false) {
  const before = coverage ? measured(2) : { status: 'unknown' };
  const after = coverage ? measured(1) : { status: 'unknown' };
  return {
    schemaVersion: 1,
    base: baseSha,
    baseRef: 'main',
    mergeBase: mergeBaseSha,
    pr: headSha,
    analyzer: { threshold: 15 },
    coverageNotes: [],
    files: [
      {
        path: 'lambda/demo/index.js',
        before: [{ coverage: before }],
        after: [{ coverage: after }],
      },
    ],
    findings: [
      {
        path: 'lambda/demo/index.js',
        function: 'view',
        line: 1,
        before: 20,
        after: 21,
        delta: 1,
        dependentFiles: 0,
        kind: 'increased',
        coverage: { before, after, change: null },
      },
    ],
    improvements: [],
  };
}

function impact() {
  return {
    schemaVersion: 1,
    repository,
    prNumber: 42,
    headSha,
    baseSha,
    mergeBaseSha,
    generatedAt: '2026-10-28T10:11:12.000Z',
    summary: { files: 1, added: 2, deleted: 1, testFiles: 0 },
    tool: { name: 'isobar', revision: toolSha },
    evidence: {
      version: 1,
      analysis: {
        toolRevision: toolSha,
        mapDigest: 'e'.repeat(64),
        declarationSelection: { eligibleFiles: 1, selectedFiles: 1, omittedFiles: 0 },
      },
      changes: [{ path: 'lambda/demo/index.js', leafId: 'runtime-core', role: 'source' }],
      annotations: [
        {
          key: 'A',
          path: 'lambda/demo/index.js',
          leafId: 'runtime-core',
          detail: '<img>@maintainers | [bad](https://attacker.invalid)',
        },
      ],
      summary: {
        productionChanges: 1,
        testChanges: 0,
        documentationChanges: 0,
        nameMatchTargets: 0,
        importFallbackTargets: 0,
        transitTargets: 0,
        productionReachFiles: 0,
        testReachFiles: 0,
        unavailableReachFiles: 0,
      },
    },
  };
}

function png() {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(800, 16);
  bytes.writeUInt32BE(500, 20);
  return bytes;
}

async function fixture(t) {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'review-signals-'));
  t.after(() => rm(reportDirectory, { recursive: true, force: true }));
  await mkdir(join(reportDirectory, 'impact'));
  await mkdir(join(reportDirectory, 'quality'));
  const pr = {
    number: 42,
    state: 'open',
    head: { sha: headSha, ref: 'feature', repo: { id: 2, full_name: 'contributor/fork' } },
    base: { sha: baseSha, ref: 'main', repo: { id: 1, full_name: repository } },
  };
  const metadata = {
    schemaVersion: 1,
    repository,
    prNumber: 42,
    headSha,
    baseSha,
    baseRef: 'main',
    mergeBaseSha,
    controllerSha,
    runId: 123,
    runAttempt: 1,
    headRepositoryId: 2,
  };
  const context = {
    eventName: 'pull_request_target',
    sha: controllerSha,
    runId: 123,
    repo: { owner: 'aws-samples', repo: 'sample-collaborative-ai-dlc' },
    payload: { repository: { id: 1, full_name: repository }, pull_request: structuredClone(pr) },
  };
  const writes = [];
  const comments = [];
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  let branch;
  let sequence = 0;
  let conflicts = 0;
  const listComments = () => {};
  const listPulls = () => {};
  const github = {
    paginate: async (method) => (method === listComments ? comments : [pr]),
    rest: {
      pulls: { list: listPulls, get: async () => ({ data: pr }) },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          assert.equal(basehead, `main...${pr.head.sha}`);
          return { data: { merge_base_commit: { sha: mergeBaseSha } } };
        },
        getContent: async ({ path, ref }) => {
          assert.match(ref, /^[a-f0-9]{40}$/);
          assert.match(path, /^pr-42\/(map.png|impact.json|quality.json)$/);
          const tree = trees.get(commits.get(ref));
          const sha = tree?.get(path);
          if (!sha) throw Object.assign(new Error('Missing saved file'), { status: 404 });
          const bytes = blobs.get(sha);
          return {
            data: {
              type: 'file',
              sha,
              size: bytes.length,
              encoding: 'base64',
              content: bytes.toString('base64'),
            },
          };
        },
      },
      issues: {
        listComments,
        createComment: async (input) => {
          writes.push({ action: 'comment', ...input });
          comments.push({
            id: 11,
            user: { login: 'github-actions[bot]', type: 'Bot' },
            body: input.body,
          });
        },
        updateComment: async (input) => {
          writes.push({ action: 'comment', ...input });
          comments.find((comment) => comment.id === input.comment_id).body = input.body;
        },
        deleteComment: async () => {
          throw new Error('Combined map must not be deleted');
        },
      },
      git: {
        createBlob: async ({ content, encoding }) => {
          assert.equal(encoding, 'base64');
          const bytes = Buffer.from(content, encoding);
          const sha = hash(bytes);
          blobs.set(sha, bytes);
          writes.push({ action: 'blob' });
          return { data: { sha } };
        },
        getRef: async ({ ref }) => {
          assert.equal(ref, 'heads/pr-impact-assets');
          if (!branch) throw Object.assign(new Error('Missing branch'), { status: 404 });
          return { data: { object: { sha: branch } } };
        },
        getCommit: async ({ commit_sha }) => ({ data: { tree: { sha: commits.get(commit_sha) } } }),
        createTree: async ({ base_tree, tree }) => {
          const files = new Map(trees.get(base_tree) ?? []);
          for (const entry of tree) {
            assert.match(entry.path, /^pr-42\/(map.png|impact.json|quality.json)$/);
            assert.equal(entry.mode, '100644');
            files.set(entry.path, entry.sha);
          }
          const sha = hash(`tree${sequence++}`);
          trees.set(sha, files);
          writes.push({ action: 'tree', entries: tree });
          return { data: { sha } };
        },
        createCommit: async ({ tree, parents }) => {
          if (branch) assert.deepEqual(parents, [branch]);
          const sha = hash(`commit${sequence++}`);
          commits.set(sha, tree);
          writes.push({ action: 'commit' });
          return { data: { sha } };
        },
        createRef: async ({ ref, sha }) => {
          assert.equal(ref, 'refs/heads/pr-impact-assets');
          branch = sha;
          writes.push({ action: 'ref' });
        },
        updateRef: async ({ ref, sha, force }) => {
          assert.equal(ref, 'heads/pr-impact-assets');
          assert.equal(force, false);
          if (conflicts-- > 0) throw Object.assign(new Error('Conflict'), { status: 409 });
          branch = sha;
          writes.push({ action: 'ref' });
        },
      },
    },
  };
  const writeQuality = async (data) =>
    writeFile(join(reportDirectory, 'quality/comparison.json'), JSON.stringify(data));
  const writeContext = async () =>
    writeFile(join(reportDirectory, 'context.json'), JSON.stringify(metadata));
  await writeContext();
  await writeQuality(quality());
  await writeFile(join(reportDirectory, 'impact/report.json'), JSON.stringify(impact()));
  await writeFile(join(reportDirectory, 'impact/map.png'), png());
  const f = {
    github,
    context,
    reportDirectory,
    attempt: 1,
    warn: () => {},
    now: () => '2026-10-28T10:15:00.000Z',
    pr,
    metadata,
    writes,
    comments,
    writeQuality,
    writeContext,
    conflicts: (count) => {
      conflicts = count;
    },
  };
  f.nextRun = async (id) => {
    metadata.runId = id;
    context.runId = id;
    await writeContext();
  };
  f.enrich = async (data = quality(true), id = 124) => {
    const reportPath = join(reportDirectory, 'quality/comparison.json');
    if (data) await writeQuality(data);
    else await rm(reportPath);
    const qualityContext = {
      ...context,
      eventName: 'workflow_run',
      payload: {
        repository: context.payload.repository,
        workflow_run: {
          id,
          run_attempt: 1,
          event: 'pull_request',
          name: 'PR Quality',
          repository: { id: 1 },
          head_repository: { id: 2 },
          head_sha: headSha,
        },
      },
    };
    await publishComplexityComment({ github, context: qualityContext, reportPath, warn: () => {} });
  };
  return f;
}

test('trusted target event publishes one fork report without mistaking controller SHA for PR head', async (t) => {
  const f = await fixture(t);
  const result = await publishReviewSignals(f);
  assert.equal(result.published, true);
  const body = f.comments[0].body;
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.match(body, /Revision: `aaaaaaa`/);
  assert.match(body, new RegExp(`${result.assetSha}/pr-42/map.png`));
  assert.equal(reviewMetadata(f.comments[0]).assetSha, result.assetSha);
  assert.doesNotMatch(body, /@maintainers|<img>|\[bad\]/);
});

test('artifact PR or controller identity cannot choose an unrelated destination', async (t) => {
  for (const change of [
    (f) => {
      f.metadata.prNumber = 999;
    },
    (f) => {
      f.metadata.controllerSha = headSha;
    },
    (f) => {
      f.metadata.headRepositoryId = 999;
    },
    (f) => {
      f.metadata.runAttempt = 2;
    },
    (f) => {
      f.metadata.repository = 'attacker/repo';
    },
  ]) {
    const f = await fixture(t);
    change(f);
    await f.writeContext();
    await assert.rejects(() => publishReviewSignals(f), /Invalid PR impact artifact/);
    assert.deepEqual(f.writes, []);
  }
});

test('stale or closed PRs cannot write assets or comments', async (t) => {
  for (const change of [
    (f) => {
      f.pr.state = 'closed';
    },
    (f) => {
      f.pr.head.sha = 'f'.repeat(40);
    },
    (f) => {
      f.pr.base.ref = 'release';
    },
    (f) => {
      f.pr.head.repo.id = 999;
    },
  ]) {
    const f = await fixture(t);
    change(f);
    assert.equal((await publishReviewSignals(f)).published, false);
    assert.deepEqual(f.writes, []);
  }
});

test('unrelated base advancement with unchanged merge base remains publishable', async (t) => {
  const f = await fixture(t);
  f.pr.base.sha = 'f'.repeat(40);
  assert.equal((await publishReviewSignals(f)).published, true);
});

test('invalid image, malformed file coverage and symlink artifacts are rejected before writes', async (t) => {
  const oversized = png();
  oversized.writeUInt32BE(10000, 16);
  const f = await fixture(t);
  await writeFile(join(f.reportDirectory, 'impact/map.png'), oversized);
  assert.equal((await publishReviewSignals(f)).published, false);
  assert.deepEqual(f.writes, []);
  await writeFile(join(f.reportDirectory, 'impact/map.png'), png());
  const badQuality = quality();
  badQuality.files[0].after[0].coverage = { status: 'measured', covered: 'injected' };
  await f.writeQuality(badQuality);
  assert.equal((await publishReviewSignals(f)).published, false);
  assert.deepEqual(f.writes, []);
  await f.writeQuality(quality());
  await rm(join(f.reportDirectory, 'impact/map.png'));
  await symlink(join(f.reportDirectory, 'context.json'), join(f.reportDirectory, 'impact/map.png'));
  assert.equal((await publishReviewSignals(f)).published, false);
  assert.deepEqual(f.writes, []);
  assert.throws(() => validateQualitySnapshot(badQuality), /file coverage/);
  assert.throws(
    () => validateReportArtifacts(Buffer.from(JSON.stringify(impact())), oversized),
    /dimensions/,
  );
});

test('approved coverage enriches the existing marked report using the pinned PNG', async (t) => {
  const f = await fixture(t);
  await publishReviewSignals(f);
  const initial = reviewMetadata(f.comments[0]).assetSha;
  f.writes.length = 0;
  await f.enrich();
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /100.0% → 50.0%/);
  const after = reviewMetadata(f.comments[0]).assetSha;
  assert.notEqual(after, initial);
  assert.match(f.comments[0].body, new RegExp(`${after}/pr-42/map.png`));
  assert.ok(
    f.writes
      .find((write) => write.action === 'tree')
      .entries.some((entry) => entry.path.endsWith('/map.png')),
  );
});

test('late static-only rerun retains comparable coverage already published for the head', async (t) => {
  const f = await fixture(t);
  await publishReviewSignals(f);
  await f.enrich();
  await f.writeQuality(quality());
  await f.nextRun(125);
  assert.equal((await publishReviewSignals(f)).published, true);
  assert.match(f.comments[0].body, /100.0% → 50.0%/);
});

test('late completion of an earlier approved run can enrich a newer static report', async (t) => {
  const f = await fixture(t);
  await f.nextRun(125);
  await publishReviewSignals(f);
  await f.enrich(quality(true), 124);
  assert.match(f.comments[0].body, /100.0% → 50.0%/);
});

test('failed latest coverage keeps the map and marks quality unavailable', async (t) => {
  const f = await fixture(t);
  await publishReviewSignals(f);
  await f.enrich();
  await f.enrich(null, 126);
  assert.match(f.comments[0].body, /Quality report unavailable/);
  assert.match(f.comments[0].body, /!\[PR impact map\]/);
  assert.doesNotMatch(f.comments[0].body, /100.0% → 50.0%/);
});

test('older coverage cannot resurrect measurements after a newer producer failed', async (t) => {
  const f = await fixture(t);
  await publishReviewSignals(f);
  await f.enrich(quality(true), 124);
  await f.enrich(null, 126);
  await f.writeQuality(quality());
  await f.nextRun(127);
  await publishReviewSignals(f);
  f.writes.length = 0;
  await f.enrich(quality(true), 124);
  assert.deepEqual(f.writes, []);
  assert.doesNotMatch(f.comments[0].body, /100.0% → 50.0%/);
  assert.deepEqual(reviewMetadata(f.comments[0]).qualityRun, { id: 126, attempt: 1 });
});

test('zero source metrics preserve infrastructure map and do not delete the combined report', async (t) => {
  const f = await fixture(t);
  const empty = { ...quality(), files: [], findings: [] };
  await f.writeQuality(empty);
  await publishReviewSignals(f);
  assert.match(f.comments[0].body, /No production JS\/TS/);
  await f.enrich(empty);
  assert.match(f.comments[0].body, /!\[PR impact map\]/);
});

test('human markers and older target runs cannot replace the bot-owned result', async (t) => {
  const f = await fixture(t);
  f.comments.push({ id: 10, user: { login: 'human', type: 'User' }, body: COMMENT_MARKER });
  await publishReviewSignals(f);
  assert.equal(f.comments.length, 2);
  assert.equal(f.comments[0].body, COMMENT_MARKER);
  f.writes.length = 0;
  await f.nextRun(122);
  assert.equal((await publishReviewSignals(f)).reason, 'older run');
  assert.deepEqual(f.writes, []);
});

test('asset updates retry conflicts with non-force writes and preserve the destination', async (t) => {
  const f = await fixture(t);
  await publishReviewSignals(f);
  await f.nextRun(124);
  f.conflicts(1);
  assert.equal((await publishReviewSignals(f)).published, true);
});

test('head change after asset upload prevents a stale comment update', async (t) => {
  const f = await fixture(t);
  const createRef = f.github.rest.git.createRef;
  f.github.rest.git.createRef = async (input) => {
    await createRef(input);
    f.pr.head.sha = 'f'.repeat(40);
  };
  const result = await publishReviewSignals(f);
  assert.equal(result.reason, 'stale PR before comment write');
  assert.equal(f.comments.length, 0);
});

test('publication preflight rejects an invalid render before asset or comment writes', async (t) => {
  const f = await fixture(t);
  f.now = () => 'invalid-update-time';
  await assert.rejects(() => publishReviewSignals(f), /Invalid review update time/);
  assert.deepEqual(f.writes, []);
});

test('enrichment still handles a head change after asset upload without replacing the comment', async (t) => {
  const f = await fixture(t);
  await publishReviewSignals(f);
  const original = f.comments[0].body;
  f.writes.length = 0;
  const updateRef = f.github.rest.git.updateRef;
  f.github.rest.git.updateRef = async (input) => {
    await updateRef(input);
    f.pr.head.sha = 'f'.repeat(40);
  };
  const handled = await enrichReviewSignals({
    github: f.github,
    context: f.context,
    pr: f.pr,
    run: { id: 124, run_attempt: 1 },
    report: quality(true),
    existing: f.comments[0],
  });
  assert.equal(handled, true);
  assert.ok(f.writes.some((write) => write.action === 'ref'));
  assert.ok(f.writes.every((write) => write.action !== 'comment'));
  assert.equal(f.comments[0].body, original);
});

test('oversized quality tables retain the published map, credits, revision and artifact link', async (t) => {
  const f = await fixture(t);
  const large = quality();
  large.findings = Array.from({ length: 1500 }, (_, index) => ({
    ...large.findings[0],
    function: `function${index}`,
    line: index + 1,
  }));
  await f.writeQuality(large);
  assert.equal((await publishReviewSignals(f)).published, true);
  const body = f.comments[0].body;
  assert.ok(body.length < 55000);
  assert.match(body, /Display truncated/);
  assert.match(body, /!\[PR impact map\]/);
  assert.match(body, /\[Isobar\]/);
  assert.match(body, /\[r3al1tym\]/);
  assert.match(body, /Revision: `aaaaaaa`/);
  assert.match(body, /Full report artifacts/);
  assert.equal(
    (body.match(/<details(?: open)?>/g) ?? []).length,
    (body.match(/<\/details>/g) ?? []).length,
  );
});

function legacyRun(f, runId = 120) {
  if (
    !f.comments.some(
      (comment) =>
        comment.user?.login === 'github-actions[bot]' && comment.body.startsWith(COMMENT_MARKER),
    )
  )
    f.comments.push({
      id: 10,
      user: { login: 'github-actions[bot]', type: 'Bot' },
      body: `${COMMENT_MARKER}\n<!-- quality-run:${runId}:1 -->\nExisting quality table`,
    });
  const run = {
    id: runId,
    run_attempt: 2,
    event: 'pull_request',
    name: 'PR Quality',
    path: '.github/workflows/pr-quality.yml',
    status: 'completed',
    repository: { id: 1 },
    head_repository: { id: 2 },
    head_sha: headSha,
  };
  const jobs = [
    { name: 'report', run_attempt: 1, conclusion: 'success' },
    { name: 'report', run_attempt: 2, conclusion: 'success' },
  ];
  const artifacts = [
    { name: 'pr-quality-1', expired: false },
    { name: 'pr-quality-2', expired: false },
  ];
  const listJobs = () => {};
  const listArtifacts = () => {};
  f.github.rest.actions = {
    getWorkflowRun: async ({ run_id }) => {
      assert.equal(run_id, runId);
      return { data: run };
    },
    listJobsForWorkflowRun: listJobs,
    listWorkflowRunArtifacts: listArtifacts,
  };
  const paginate = f.github.paginate;
  f.github.paginate = async (method, input) =>
    method === listJobs ? jobs : method === listArtifacts ? artifacts : paginate(method, input);
  return { run, jobs, artifacts };
}

test('legacy recovery selects the latest successful artifact and keeps approved coverage in the first map', async (t) => {
  const f = await fixture(t);
  legacyRun(f);
  const selected = await legacyQualityArtifact(f);
  assert.deepEqual(selected, {
    runId: 120,
    artifactName: 'pr-quality-2',
    qualityRun: { id: 120, attempt: 2 },
  });
  assert.deepEqual(f.writes, []);
  f.loadLegacyQuality = async (artifact) => {
    assert.deepEqual(artifact, selected);
    return quality(true);
  };
  await publishReviewSignals(f);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /100.0% → 50.0%/);
  assert.match(f.comments[0].body, /!\[PR impact map\]/);
  assert.deepEqual(reviewMetadata(f.comments[0]).qualityRun, { id: 120, attempt: 2 });
});

test('recovered quality retains its older base tip when the head, target and merge base match', async (t) => {
  const f = await fixture(t);
  const recovered = { ...quality(true), base: 'e'.repeat(40) };
  legacyRun(f);
  f.loadLegacyQuality = async () => recovered;
  assert.equal((await publishReviewSignals(f)).published, true);
  assert.match(f.comments[0].body, /100.0% → 50.0%/);
  const pinned = reviewMetadata(f.comments[0]);
  const { data } = await f.github.rest.repos.getContent({
    path: 'pr-42/quality.json',
    ref: pinned.assetSha,
  });
  assert.equal(
    JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')).base,
    recovered.base,
  );
});

test('earlier static run attaches its map after a later coverage run publishes the same head', async (t) => {
  const f = await fixture(t);
  await f.enrich(quality(true), 124);
  assert.match(f.comments[0].body, /100.0% → 50.0%/);
  assert.doesNotMatch(f.comments[0].body, /PR impact map/);
  const state = legacyRun(f, 124);
  state.run.run_attempt = 1;
  state.jobs.pop();
  state.artifacts.pop();
  f.loadLegacyQuality = async () => quality(true);
  assert.equal((await publishReviewSignals(f)).published, true);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /100.0% → 50.0%/);
  assert.match(f.comments[0].body, /!\[PR impact map\]/);
  assert.deepEqual(reviewMetadata(f.comments[0]).staticRun, { id: 123, attempt: 1 });
  assert.deepEqual(reviewMetadata(f.comments[0]).qualityRun, { id: 124, attempt: 1 });
});

test('first map recovers coverage that arrived after static collection', async (t) => {
  const f = await fixture(t);
  await f.enrich(quality(true), 124);
  legacyRun(f, 124);
  await f.writeQuality(quality());
  let selected;
  f.loadLegacyQuality = async (artifact) => {
    selected = artifact;
    return { ...quality(true), base: 'e'.repeat(40) };
  };
  assert.equal((await publishReviewSignals(f)).published, true);
  assert.equal(selected.runId, 124);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /100.0% → 50.0%/);
  assert.match(f.comments[0].body, /!\[PR impact map\]/);
});

test('a later comment-only attempt recovers the latest successful coverage producer', async (t) => {
  const f = await fixture(t);
  const state = legacyRun(f, 124);
  state.run.run_attempt = 3;
  f.comments[0].body = `${COMMENT_MARKER}\n<!-- quality-run:124:3 -->\nExisting quality table`;
  f.loadLegacyQuality = async (selected) => {
    assert.equal(selected.artifactName, 'pr-quality-2');
    return quality(true);
  };
  assert.equal((await publishReviewSignals(f)).published, true);
  assert.match(f.comments[0].body, /100.0% → 50.0%/);
  assert.deepEqual(reviewMetadata(f.comments[0]).qualityRun, { id: 124, attempt: 2 });
});

test('first map does not erase newer legacy coverage when bounded recovery is unavailable', async (t) => {
  for (const recovered of [undefined, { ...quality(true), pr: 'f'.repeat(40) }]) {
    const f = await fixture(t);
    await f.enrich(quality(true), 124);
    legacyRun(f, 124);
    const original = f.comments[0].body;
    await f.writeQuality(quality());
    if (recovered) f.loadLegacyQuality = async () => recovered;
    f.writes.length = 0;
    const result = await publishReviewSignals(f);
    assert.equal(result.reason, 'newer legacy quality requires recovery');
    assert.deepEqual(f.writes, []);
    assert.equal(f.comments[0].body, original);
  }
});

test('latest validated unknown coverage allows the first map and blocks older known measurements', async (t) => {
  const f = await fixture(t);
  await f.enrich(quality(true), 124);
  await f.enrich(quality(), 125);
  legacyRun(f, 125);
  f.loadLegacyQuality = async () => quality();
  assert.equal((await publishReviewSignals(f)).published, true);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /!\[PR impact map\]/);
  assert.match(f.comments[0].body, /Coverage unavailable/);
  assert.doesNotMatch(f.comments[0].body, /100.0% → 50.0%/);
  assert.deepEqual(reviewMetadata(f.comments[0]).qualityRun, { id: 125, attempt: 2 });
  f.writes.length = 0;
  await f.enrich(quality(true), 124);
  assert.deepEqual(f.writes, []);
  assert.doesNotMatch(f.comments[0].body, /100.0% → 50.0%/);
});

test('legacy recovery rejects mismatched, failed, expired, foreign and non-target state without writes', async (t) => {
  for (const change of [
    (_f, state) => {
      state.run.head_sha = 'f'.repeat(40);
    },
    (_f, state) => {
      state.run.head_repository.id = 999;
    },
    (_f, state) => {
      state.run.repository.id = 999;
    },
    (_f, state) => {
      state.run.event = 'pull_request_target';
    },
    (_f, state) => {
      state.run.path = '.github/workflows/attacker.yml';
    },
    (_f, state) => {
      state.run.status = 'in_progress';
    },
    (_f, state) => {
      state.jobs[1].conclusion = 'failure';
    },
    (_f, state) => {
      state.artifacts[1].expired = true;
    },
    (f) => {
      f.comments[0].user.type = 'User';
    },
    (f) => {
      f.comments[0].body += '\n<!-- review-assets:ignored -->';
    },
    (f) => {
      f.context.eventName = 'workflow_run';
    },
  ]) {
    const f = await fixture(t);
    const state = legacyRun(f);
    change(f, state);
    assert.equal(await legacyQualityArtifact(f), null);
    assert.deepEqual(f.writes, []);
  }
});
