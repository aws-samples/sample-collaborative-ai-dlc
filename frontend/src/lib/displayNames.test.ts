import { describe, expect, it } from 'vitest';
import {
  commonSuffix,
  displayCli,
  displayModel,
  displayModels,
  displayPhase,
  displayProvider,
  displayStageName,
  humanizeSlug,
  stripCommonSuffix,
} from './displayNames';

describe('humanizeSlug', () => {
  it.each([
    ['reverse-engineering', 'Reverse Engineering'],
    ['requirements_analysis', 'Requirements Analysis'],
    ['unitsGeneration', 'Units Generation'],
    ['aws-iam-setup', 'AWS IAM Setup'],
    ['ai-dlc-principles', 'AI-DLC Principles'],
    ['ci-cd-patterns', 'CI/CD Patterns'],
    ['ui-ux-review', 'UI/UX Review'],
    ['cicd-pipeline', 'CI/CD Pipeline'],
    ['github-graphql-grpc-iac', 'GitHub GraphQL gRPC IaC'],
    ['apis-and-sdks', 'APIs and SDKs'],
    ['and-more', 'And More'],
    ['unit-of-work-vs-buy', 'Unit of Work vs Buy'],
    ['  ', ''],
  ])('%s → %s', (slug, expected) => {
    expect(humanizeSlug(slug)).toBe(expected);
  });
});

describe('displayStageName', () => {
  it.each([
    [undefined, 'Reverse Engineering'],
    ['Reverse engineering', 'Reverse engineering'],
    [{ name: 'Reverse engineering' }, 'Reverse engineering'],
    ['  ', 'Reverse Engineering'],
    [{ name: null }, 'Reverse Engineering'],
    ['reverse-engineering', 'Reverse Engineering'],
  ])('prefers a real compiled name (%o) → %s', (compiled, expected) => {
    expect(displayStageName('reverse-engineering', compiled)).toBe(expected);
  });
});

describe('displayPhase', () => {
  it('drops an ordering prefix from phases', () => {
    expect(displayPhase('02-construction')).toBe('Construction');
  });
});

describe('displayModel', () => {
  it.each([
    ['us.anthropic.claude-opus-4-6-v1', 'Claude Opus 4.6'],
    ['global.anthropic.claude-opus-4-6-v1:0', 'Claude Opus 4.6'],
    ['claude-opus-4-6', 'Claude Opus 4.6'],
    ['eu.anthropic.claude-sonnet-4-5-20250929-v1:0', 'Claude Sonnet 4.5'],
    ['claude-opus-4-20250514', 'Claude Opus 4'],
    ['claude-sonnet-4.5', 'Claude Sonnet 4.5'],
    ['amazon-bedrock/us.anthropic.claude-sonnet-4-6', 'Claude Sonnet 4.6'],
    ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'Claude 3.5 Sonnet'],
    [
      'arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.claude-opus-4-6-v1',
      'Claude Opus 4.6',
    ],
    ['claude-opus-4-6[1m]', 'Claude Opus 4.6 (1M context)'],
    ['gpt-5.4', 'GPT-5.4'],
    ['openai.gpt-5.5', 'GPT-5.5'],
    ['openai/gpt-5.4-codex', 'GPT-5.4 Codex'],
    ['gpt-5-codex-mini', 'GPT-5 Codex Mini'],
    ['openai.gpt-oss-120b-1:0', 'GPT-OSS 120B'],
    ['auto', 'auto'],
    ['mistral.mistral-large-2407-v1:0', 'mistral.mistral-large-2407-v1:0'],
    ['', ''],
  ])('%s → %s', (id, expected) => {
    expect(displayModel(id)).toBe(expected);
  });

  it('joins and deduplicates several ids', () => {
    expect(displayModels('us.anthropic.claude-opus-4-6-v1, us.anthropic.claude-sonnet-4-6')).toBe(
      'Claude Opus 4.6 · Claude Sonnet 4.6',
    );
    expect(displayModels(['claude-opus-4-6', 'global.anthropic.claude-opus-4-6-v1:0'])).toBe(
      'Claude Opus 4.6',
    );
    expect(displayModels([])).toBe('');
  });
});

describe('displayProvider / displayCli', () => {
  it.each([
    ['codecommit', 'AWS CodeCommit'],
    ['GitHub', 'GitHub'],
    ['azure-devops', 'Azure Devops'],
  ])('provider %s → %s', (slug, expected) => {
    expect(displayProvider(slug)).toBe(expected);
  });

  it.each([
    ['claude', 'Claude Code'],
    ['gemini-cli', 'Gemini CLI'],
  ])('cli %s → %s', (cli, expected) => {
    expect(displayCli(cli)).toBe(expected);
  });
});

describe('stripCommonSuffix', () => {
  it('removes a suffix shared by several labels', () => {
    const app = 'Retail Store Sample App';
    const labels = [`Architecture — ${app}`, `Code Structure — ${app}`, `API Docs — ${app}`];
    expect(commonSuffix(labels)).toBe(app);
    expect(stripCommonSuffix(labels)).toEqual(['Architecture', 'Code Structure', 'API Docs']);
  });

  it.each([
    [
      ['Plan: Shop', 'Design: Shop'],
      ['Plan', 'Design'],
    ],
    [
      ['Plan – Shop', 'Design - Shop'],
      ['Plan', 'Design'],
    ],
    [
      ['A — X', 'B — X', 'Overview'],
      ['A', 'B', 'Overview'],
    ],
    [['A — X'], ['A — X']],
    [
      ['A — X', 'B — Y'],
      ['A — X', 'B — Y'],
    ],
    [
      ['Design — X', 'Design — X'],
      ['Design — X', 'Design — X'],
    ],
    [
      ['Non-functional', 'Cross-functional'],
      ['Non-functional', 'Cross-functional'],
    ],
    [[], []],
  ])('%o → %o', (labels, expected) => {
    expect(stripCommonSuffix(labels)).toEqual(expected);
  });
});
