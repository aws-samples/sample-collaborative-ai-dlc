import { describe, expect, it } from 'vitest';
import { buildBodyRef, buildScriptRef } from '../blocks.js';
import { renamedFromRelease, sameMethodologyContent } from '../native-export-blocks.js';

const RELEASE_SHA = '1111111111111111111111111111111111111111';

const releaseSensor = {
  type: 'SENSOR',
  id: 'linter',
  blockId: 'linter',
  tenantId: 'SYSTEM',
  version: 1,
  sourceRef: RELEASE_SHA,
  name: 'Linter',
  description: 'Runs the linter',
  severity: 'blocking',
  fireOn: ['code-generation'],
  command: 'npx tsx check.ts',
  bodyRef: buildBodyRef('# Linter\n'),
  scriptRef: buildScriptRef('console.log("ok");\n'),
};

// A user-library copy stored the way the block API stores it.
const userCopy = (overrides = {}) => ({
  ...releaseSensor,
  pk: 'BLOCK#default#SENSOR#linter',
  sk: 'V#3',
  GSI1PK: 'TENANT#default#SENSOR',
  GSI1SK: releaseSensor.name,
  tenantId: 'default',
  blockType: 'SENSOR',
  version: 3,
  sourceRef: undefined,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  ...overrides,
});

describe('native export block content', () => {
  it('treats a copy that only changes the display names as the release block', () => {
    const renamed = userCopy({ name: 'ACME Linter', displayName: 'ACME Linter' });

    expect(sameMethodologyContent(renamed, releaseSensor)).toBe(true);
    expect(renamedFromRelease(renamed, releaseSensor)).toBe(true);
  });

  it('ignores the storage envelope and the key order', () => {
    const reordered = Object.fromEntries(Object.entries(userCopy()).toReversed());

    expect(sameMethodologyContent(reordered, releaseSensor)).toBe(true);
    expect(renamedFromRelease(reordered, releaseSensor)).toBe(false);
  });

  it.each([
    ['an edited body', { bodyRef: buildBodyRef('# Linter\n\nStricter.\n') }],
    ['a body with CRLF line endings', { bodyRef: buildBodyRef('# Linter\r\n') }],
    ['an edited script', { scriptRef: buildScriptRef('process.exit(1);\n') }],
    ['a removed body', { bodyRef: undefined }],
    ['a changed severity', { severity: 'advisory' }],
    ['a changed fireOn', { fireOn: ['code-generation', 'build-and-test'] }],
    ['a changed command', { command: 'npx tsx other.ts' }],
    ['a changed description', { description: 'Runs the ACME linter' }],
    ['an empty value where the release has none', { examples: [] }],
  ])('reports %s as edited methodology', (_label, overrides) => {
    expect(
      sameMethodologyContent(userCopy({ name: 'ACME Linter', ...overrides }), releaseSensor),
    ).toBe(false);
  });

  it('reports a changed reference to another block as edited methodology', () => {
    const releaseStage = {
      type: 'STAGE',
      id: 'code-generation',
      name: 'Code Generation',
      leadAgent: 'aidlc-developer-agent',
      sensors: ['linter'],
      bodyRef: buildBodyRef('# Code generation\n'),
    };
    const stageCopy = (overrides) => ({ ...releaseStage, tenantId: 'default', ...overrides });

    expect(sameMethodologyContent(stageCopy({ name: 'ACME Code Generation' }), releaseStage)).toBe(
      true,
    );
    expect(
      sameMethodologyContent(stageCopy({ leadAgent: 'acme-developer-agent' }), releaseStage),
    ).toBe(false);
    expect(sameMethodologyContent(stageCopy({ sensors: ['acme-linter'] }), releaseStage)).toBe(
      false,
    );
  });

  it('never matches a missing pinned row or a block the release does not ship', () => {
    expect(
      sameMethodologyContent(
        { blockId: 'linter', id: 'linter', tenantId: 'default', missing: true },
        releaseSensor,
      ),
    ).toBe(false);
    expect(sameMethodologyContent(userCopy(), undefined)).toBe(false);
  });
});
