import { describe, expect, it } from 'vitest';
import { displayPhase, displayProvider, displayStageName, humanizeSlug } from './displayNames';

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

describe('displayProvider', () => {
  it.each([
    ['codecommit', 'AWS CodeCommit'],
    ['GitHub', 'GitHub'],
    ['azure-devops', 'Azure Devops'],
  ])('provider %s → %s', (slug, expected) => {
    expect(displayProvider(slug)).toBe(expected);
  });
});
