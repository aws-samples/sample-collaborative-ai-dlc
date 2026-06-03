// test/e2e/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from './config.mjs';

const base = {
  VITE_AWS_REGION: 'us-east-1',
  VITE_AWS_USER_POOL_ID: 'us-east-1_xxx',
  VITE_AWS_USER_POOL_CLIENT_ID: 'client123',
  VITE_API_BASE_URL: 'https://api.example.com/',
  E2E_USERNAME: 'u@example.com',
  E2E_PASSWORD: 'pw',
  E2E_REPOS: 'a/b, c/d ',
};

test('buildConfig parses and normalizes', () => {
  const cfg = buildConfig(base);
  assert.equal(cfg.apiBaseUrl, 'https://api.example.com'); // trailing slash stripped
  assert.deepEqual(cfg.repos, ['a/b', 'c/d']);
  assert.equal(cfg.agentCli, 'kiro'); // default
  assert.equal(cfg.baseBranch, 'main'); // default
  assert.equal(cfg.teardown, false);
  assert.equal(cfg.timeoutMs, 1800000);
  assert.equal(cfg.scenarioName, 'multi-changed');
  assert.deepEqual(cfg.expectedChangedRepos, []);
  assert.equal(cfg.skipCleanup, false);
  assert.equal(cfg.questionStrategy, 'default-answer');
  assert.equal(cfg.clarifyingQuestions, 2); // default
  assert.equal(cfg.expectPrs, true);
  assert.equal(cfg.requireTaskCompletion, true);
  assert.equal(cfg.requireRunningTransition, true);
});

test('buildConfig throws on missing required key', () => {
  const bad = { ...base };
  delete bad.E2E_PASSWORD;
  assert.throws(() => buildConfig(bad), /E2E_PASSWORD/);
});

test('buildConfig honors overrides', () => {
  const cfg = buildConfig({
    ...base,
    E2E_CLI: 'claude',
    E2E_TEARDOWN: 'true',
    E2E_TIMEOUT_MS: '600000',
    E2E_SCENARIO: 'review-cycle',
    E2E_EXPECTED_CHANGED_REPOS: 'a/b,c/d',
    E2E_SKIP_CLEANUP: 'yes',
    E2E_QUESTION_STRATEGY: 'custom-file',
    E2E_CLARIFYING_QUESTIONS: '0',
    E2E_EXPECT_PRS: 'false',
    E2E_REQUIRE_TASK_COMPLETION: 'false',
    E2E_REQUIRE_RUNNING_TRANSITION: 'false',
  });
  assert.equal(cfg.agentCli, 'claude');
  assert.equal(cfg.teardown, true);
  assert.equal(cfg.timeoutMs, 600000);
  assert.equal(cfg.scenarioName, 'review-cycle');
  assert.deepEqual(cfg.expectedChangedRepos, ['a/b', 'c/d']);
  assert.equal(cfg.skipCleanup, true);
  assert.equal(cfg.questionStrategy, 'custom-file');
  assert.equal(cfg.clarifyingQuestions, 0);
  assert.equal(cfg.expectPrs, false);
  assert.equal(cfg.requireTaskCompletion, false);
  assert.equal(cfg.requireRunningTransition, false);
});
