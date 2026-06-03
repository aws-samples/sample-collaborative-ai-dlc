// test/e2e/scenarios.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScenarioConfig } from './scenarios.mjs';

const baseCfg = (over = {}) => ({
  repos: ['org/ui', 'org/infra'],
  phaseSelection: '',
  scenarioName: 'multi-changed',
  expectedChangedRepos: [],
  expectPrs: true,
  requireTaskCompletion: true,
  requireRunningTransition: true,
  description: '',
  questionStrategy: '',
  clarifyingQuestions: 2,
  ...over,
});

test('default description names the actual repos', () => {
  const s = resolveScenarioConfig(baseCfg());
  assert.match(s.description, /org\/ui/);
  assert.match(s.description, /org\/infra/);
});

test('default description bounds clarifying questions', () => {
  const s = resolveScenarioConfig(baseCfg({ clarifyingQuestions: 2 }));
  assert.match(s.description, /at most 2 concise clarifying questions/i);
});

test('clarifyingQuestions=0 forbids questions for a fast path to construction', () => {
  const s = resolveScenarioConfig(baseCfg({ clarifyingQuestions: 0 }));
  assert.match(s.description, /Do NOT ask clarifying questions/i);
});

test('clarifyingQuestions=1 uses singular phrasing', () => {
  const s = resolveScenarioConfig(baseCfg({ clarifyingQuestions: 1 }));
  assert.match(s.description, /at most 1 concise clarifying question\b/i);
});

test('review-cycle appends review phase and requires review', () => {
  const s = resolveScenarioConfig(baseCfg({ scenarioName: 'review-cycle' }));
  assert.ok(s.phases.includes('review'));
  assert.equal(s.expectations.requireReview, true);
});

test('explicit description overrides the default', () => {
  const s = resolveScenarioConfig(baseCfg({ description: 'custom prompt' }));
  assert.equal(s.description, 'custom prompt');
});

test('unsupported scenario throws', () => {
  assert.throws(
    () => resolveScenarioConfig(baseCfg({ scenarioName: 'nope' })),
    /Unsupported E2E_SCENARIO/,
  );
});
