// test/e2e/prGraph.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  repoFromPrUrl,
  extractPullRequests,
  assertPrsOnlyOnChangedRepos,
  assertE2EExpectations,
} from './prGraph.mjs';

test('repoFromPrUrl parses owner/repo', () => {
  assert.equal(
    repoFromPrUrl('https://github.com/eipasteur/retail-store-ui/pull/7'),
    'eipasteur/retail-store-ui',
  );
  assert.equal(repoFromPrUrl('not-a-url'), null);
});

test('extractPullRequests reads PullRequest nodes', () => {
  const graph = {
    nodes: [
      { type: 'Task', id: 't1' },
      {
        type: 'PullRequest',
        pr_url: 'https://github.com/eipasteur/retail-store-ui/pull/7',
        pr_number: '7',
      },
      {
        label: 'PullRequest',
        properties: {
          pr_url: 'https://github.com/eipasteur/retail-store-cart/pull/3',
          pr_number: '3',
        },
      },
    ],
  };
  assert.deepEqual(extractPullRequests(graph), [
    {
      prUrl: 'https://github.com/eipasteur/retail-store-ui/pull/7',
      prNumber: '7',
      repository: 'eipasteur/retail-store-ui',
    },
    {
      prUrl: 'https://github.com/eipasteur/retail-store-cart/pull/3',
      prNumber: '3',
      repository: 'eipasteur/retail-store-cart',
    },
  ]);
});

test('assertPrsOnlyOnChangedRepos flags violations and missing', () => {
  const prs = [
    { repository: 'eipasteur/retail-store-ui', prUrl: 'u' },
    { repository: 'eipasteur/retail-store-cart', prUrl: 'c' },
  ];
  const r = assertPrsOnlyOnChangedRepos(prs, [
    'eipasteur/retail-store-ui',
    'eipasteur/retail-store-catalog',
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ['eipasteur/retail-store-cart']);
  assert.deepEqual(r.missing, ['eipasteur/retail-store-catalog']);
});

test('assertPrsOnlyOnChangedRepos ok when exact match', () => {
  const prs = [{ repository: 'a/b', prUrl: 'u' }];
  const r = assertPrsOnlyOnChangedRepos(prs, ['a/b']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.missing, []);
});

test('assertE2EExpectations rejects construction completion with no running/tasks evidence', () => {
  const r = assertE2EExpectations({
    prs: [{ repository: 'a/b', prUrl: 'u' }],
    changedRepos: ['a/b'],
    expectPrs: true,
    phaseState: {
      sawRunning: false,
      sawTasksDone: false,
      completed: true,
      completedAfterRunning: false,
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(','), /phase-never-ran/);
  assert.match(r.violations.join(','), /phase-completed-without-transition/);
});

test('assertE2EExpectations accepts completion proven by tasks done even without observed RUNNING', () => {
  const r = assertE2EExpectations({
    prs: [{ repository: 'a/b', prUrl: 'u' }],
    changedRepos: ['a/b'],
    expectPrs: true,
    phaseState: {
      sawRunning: false,
      sawTasksDone: true,
      completed: true,
      completedAfterRunning: true,
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test('assertE2EExpectations allows no-change scenario without PRs', () => {
  const r = assertE2EExpectations({
    prs: [],
    changedRepos: [],
    expectPrs: false,
    phaseState: {
      sawRunning: true,
      sawTasksDone: false,
      completed: true,
      completedAfterRunning: true,
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('assertE2EExpectations passes when review produced both reviews', () => {
  const r = assertE2EExpectations({
    prs: [{ repository: 'a/b', prUrl: 'u' }],
    changedRepos: ['a/b'],
    expectPrs: true,
    phaseState: {
      sawRunning: true,
      sawTasksDone: true,
      completed: true,
      completedAfterRunning: true,
    },
    requireReview: true,
    reviewState: { hasBlind: true, hasFull: true, status: 'PASSED' },
  });
  assert.equal(r.ok, true);
});

test('assertE2EExpectations flags review-never-ran when review required but absent', () => {
  const r = assertE2EExpectations({
    prs: [{ repository: 'a/b', prUrl: 'u' }],
    changedRepos: ['a/b'],
    expectPrs: true,
    phaseState: {
      sawRunning: true,
      sawTasksDone: true,
      completed: true,
      completedAfterRunning: true,
    },
    requireReview: true,
    reviewState: null,
  });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(','), /review-never-ran/);
});

test('assertE2EExpectations flags review-incomplete when only one review present', () => {
  const r = assertE2EExpectations({
    prs: [{ repository: 'a/b', prUrl: 'u' }],
    changedRepos: ['a/b'],
    expectPrs: true,
    phaseState: {
      sawRunning: true,
      sawTasksDone: true,
      completed: true,
      completedAfterRunning: true,
    },
    requireReview: true,
    reviewState: { hasBlind: true, hasFull: false, status: 'PENDING' },
  });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(','), /review-incomplete/);
});

// C1: no token, multiple PRs, no expectedChangedRepos -> the per-repo allow-list
// must NOT be applied (it would flag every PR as a violation on a clean run).
test('assertE2EExpectations: no token, multiple PRs, no expectedChangedRepos -> ok:true', () => {
  const r = assertE2EExpectations({
    prs: [
      { repository: 'org/repo-a', prUrl: 'a' },
      { repository: 'org/repo-b', prUrl: 'b' },
    ],
    changedRepos: [],
    expectPrs: true,
    phaseState: {
      sawRunning: true,
      sawTasksDone: true,
      completed: true,
      completedAfterRunning: true,
    },
    enforceRepoAllowList: false,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.missing, []);
});

// C1 guard: with the allow-list enforced and an empty changedRepos, PRs ARE
// violations (this is why the no-token path must pass enforceRepoAllowList:false).
test('assertE2EExpectations: enforced allow-list with empty changedRepos flags PRs', () => {
  const r = assertE2EExpectations({
    prs: [{ repository: 'org/repo-a', prUrl: 'a' }],
    changedRepos: [],
    expectPrs: true,
    phaseState: {
      sawRunning: true,
      sawTasksDone: true,
      completed: true,
      completedAfterRunning: true,
    },
    enforceRepoAllowList: true,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ['org/repo-a']);
});

// H3: failed tasks must be rejected even when other completion signals are set.
test('assertE2EExpectations rejects tasksFailed', () => {
  const r = assertE2EExpectations({
    prs: [{ repository: 'a/b', prUrl: 'u' }],
    changedRepos: ['a/b'],
    expectPrs: true,
    phaseState: {
      sawRunning: true,
      sawTasksDone: true,
      tasksFailed: true,
      completed: true,
      completedAfterRunning: true,
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(','), /tasks-failed/);
});
