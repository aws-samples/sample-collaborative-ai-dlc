import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const load = (name) =>
  yaml.load(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'));

test('static reporting accepts normal PR events with no maintainer or publication-variable gate', () => {
  const workflow = load('pr-impact.yml');
  assert.deepEqual(workflow.on.pull_request_target.types, [
    'opened',
    'synchronize',
    'reopened',
    'ready_for_review',
    'edited',
  ]);
  assert.equal(workflow.jobs.analyze.if, undefined);
  assert.equal(workflow.jobs.publish.if, undefined);
  assert.match(workflow['run-name'], /PR impact map #/);
  assert.doesNotMatch(JSON.stringify(workflow), /author_association|PR_IMPACT_PUBLISH|secrets\./);
});

test('contributor source never becomes the controller checkout or an executable installation', () => {
  const workflow = load('pr-impact.yml');
  assert.deepEqual(workflow.jobs.analyze.permissions, {
    contents: 'read',
    'pull-requests': 'read',
  });
  for (const step of workflow.jobs.analyze.steps.filter((s) =>
    s.uses?.startsWith('actions/checkout@'),
  )) {
    assert.equal(step.with.ref, '${{ github.sha }}');
    assert.equal(step.with['persist-credentials'], false);
  }
  const code = workflow.jobs.analyze.steps.map((s) => s.run ?? '').join('\n');
  assert.match(code, /npm ci --ignore-scripts/);
  assert.doesNotMatch(
    code,
    /npm test|npm run build|pull_request\.head|head\.repo\.clone_url|git checkout.*head/,
  );
});

test('write tokens are limited to dependency-free trusted publishers with a shared lock', () => {
  const initial = load('pr-impact.yml').jobs.publish;
  const same = load('pr-quality.yml').jobs.comment;
  const fork = load('pr-quality-comment.yml');
  assert.equal(initial.permissions.contents, 'write');
  assert.equal(same.permissions.contents, 'write');
  assert.equal(fork.permissions.contents, 'write');
  assert.equal(initial.concurrency.group, same.concurrency.group);
  for (const job of [initial, same, fork.jobs.comment]) {
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with['persist-credentials'], false);
    assert.match(checkout.with['sparse-checkout'], /pr-impact\/publish\.mjs/);
    assert.doesNotMatch(job.steps.map((s) => s.run ?? '').join('\n'), /npm|pip|git checkout/);
  }
  assert.equal(
    same.steps.find((s) => s.uses?.startsWith('actions/checkout@')).with.ref,
    '${{ github.event.repository.default_branch }}',
  );
});

test('fork tests retain their pull_request trigger and read-token execution boundary', () => {
  const workflow = load('pr-quality.yml');
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.permissions.contents, 'read');
  assert.match(workflow.jobs.coverage.steps.map((s) => s.run ?? '').join('\n'), /npm test/);
});
