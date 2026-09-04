import { describe, it, expect } from 'vitest';
import {
  artifactAppliesToKind,
  pruneOutputArtifactsForUnit,
  stageIsNoopForUnit,
} from '../unit-kind-pruning.js';

const outputs = [
  { artifact: 'business-logic-model' },
  { artifact: 'frontend-components', optional: true },
  { artifact: 'decisions' },
];
const producesKinds = {
  'business-logic-model': ['service', 'ui', 'library'],
  'frontend-components': ['ui'],
  // `decisions` unlisted → applies to every kind
};

describe('artifactAppliesToKind', () => {
  it('an untagged unit gets the full matrix', () => {
    expect(artifactAppliesToKind(producesKinds, 'frontend-components', null)).toBe(true);
  });

  it('an unlisted artifact applies to every kind', () => {
    expect(artifactAppliesToKind(producesKinds, 'decisions', 'spec')).toBe(true);
  });

  it('a listed artifact applies only to its kinds', () => {
    expect(artifactAppliesToKind(producesKinds, 'frontend-components', 'ui')).toBe(true);
    expect(artifactAppliesToKind(producesKinds, 'frontend-components', 'service')).toBe(false);
  });

  it('no producesKinds map means nothing prunes', () => {
    expect(artifactAppliesToKind(null, 'anything', 'spec')).toBe(true);
  });
});

describe('pruneOutputArtifactsForUnit', () => {
  it('prunes non-matching artifacts, keeping entry objects (flags intact)', () => {
    const { outputs: kept, pruned } = pruneOutputArtifactsForUnit(
      outputs,
      producesKinds,
      'service',
    );
    expect(kept.map((o) => o.artifact)).toEqual(['business-logic-model', 'decisions']);
    expect(pruned).toEqual(['frontend-components']);
  });

  it('keeps everything for a matching kind / untagged unit / no map', () => {
    expect(pruneOutputArtifactsForUnit(outputs, producesKinds, 'ui').pruned).toEqual([]);
    expect(pruneOutputArtifactsForUnit(outputs, producesKinds, null).pruned).toEqual([]);
    expect(pruneOutputArtifactsForUnit(outputs, null, 'spec').pruned).toEqual([]);
  });
});

describe('stageIsNoopForUnit', () => {
  it('true when EVERY required output prunes away for the unit kind', () => {
    const uiOnly = [
      { artifact: 'frontend-components' }, // required here
      { artifact: 'component-styles', optional: true },
    ];
    const kinds = { 'frontend-components': ['ui'], 'component-styles': ['ui'] };
    expect(stageIsNoopForUnit(uiOnly, kinds, 'service')).toBe(true);
    expect(stageIsNoopForUnit(uiOnly, kinds, 'ui')).toBe(false);
  });

  it('false when any required output survives', () => {
    expect(stageIsNoopForUnit(outputs, producesKinds, 'service')).toBe(false);
  });

  it('never no-ops an untagged unit or a stage with no required outputs', () => {
    expect(stageIsNoopForUnit(outputs, producesKinds, null)).toBe(false);
    expect(stageIsNoopForUnit([{ artifact: 'x', optional: true }], { x: ['ui'] }, 'service')).toBe(
      false,
    );
  });
});
