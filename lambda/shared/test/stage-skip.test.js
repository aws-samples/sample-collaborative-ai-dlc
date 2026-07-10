import { describe, it, expect } from 'vitest';
import {
  effectiveStageSkipping,
  stageSkipBlockReason,
  normalizeSkipStageIds,
  skipTargetsFrom,
  resolveSkipTo,
} from '../stage-skip.js';

const s = (stageId, execution = 'CONDITIONAL', phase = 'inception') => ({
  stageId,
  execution,
  phase,
});

describe('effectiveStageSkipping', () => {
  it('project override wins when explicit', () => {
    expect(effectiveStageSkipping('disabled', 'enabled')).toBe('enabled');
    expect(effectiveStageSkipping('enabled', 'disabled')).toBe('disabled');
  });
  it("'default' (or garbage) inherits the platform value", () => {
    expect(effectiveStageSkipping('enabled', 'default')).toBe('enabled');
    expect(effectiveStageSkipping('disabled', 'default')).toBe('disabled');
    expect(effectiveStageSkipping('enabled', undefined)).toBe('enabled');
    expect(effectiveStageSkipping('enabled', 'yolo')).toBe('enabled');
  });
  it('fails safe to disabled on a non-explicit platform value', () => {
    expect(effectiveStageSkipping(undefined, 'default')).toBe('disabled');
    expect(effectiveStageSkipping('garbage', 'default')).toBe('disabled');
  });
});

describe('stageSkipBlockReason', () => {
  it('allows CONDITIONAL non-initialization stages', () => {
    expect(stageSkipBlockReason(s('a'))).toBeNull();
  });
  it('blocks ALWAYS stages (upstream: only CONDITIONAL stages carry a skip condition)', () => {
    expect(stageSkipBlockReason(s('a', 'ALWAYS'))).toMatch(/only CONDITIONAL/);
  });
  it('blocks stages with no execution field (treated as ALWAYS)', () => {
    expect(stageSkipBlockReason({ stageId: 'a', phase: 'inception' })).toMatch(/ALWAYS/);
  });
  it('blocks initialization stages regardless of execution', () => {
    expect(stageSkipBlockReason(s('a', 'CONDITIONAL', 'initialization'))).toMatch(/initialization/);
  });
  it('blocks unknown stages', () => {
    expect(stageSkipBlockReason(null)).toBe('unknown stage');
  });
});

describe('normalizeSkipStageIds', () => {
  it('dedupes and drops non-strings/blank entries', () => {
    expect(normalizeSkipStageIds(['a', 'a', '', 42, 'b'])).toEqual(['a', 'b']);
  });
  it('returns null for absent/empty/non-array input (sparse META)', () => {
    expect(normalizeSkipStageIds(undefined)).toBeNull();
    expect(normalizeSkipStageIds(null)).toBeNull();
    expect(normalizeSkipStageIds([])).toBeNull();
    expect(normalizeSkipStageIds('a,b')).toBeNull();
  });
});

describe('skipTargetsFrom', () => {
  // build-and-test(ALWAYS) then a CONDITIONAL tail — mirrors upstream's
  // operation phase.
  const seg = [s('bt', 'ALWAYS'), s('ci'), s('cd'), s('env'), s('deploy')];

  it('offers every target reachable across CONDITIONAL intermediates', () => {
    expect(skipTargetsFrom(seg, 0)).toEqual(['cd', 'env', 'deploy']);
  });
  it('the next stage is never a target (nothing to skip)', () => {
    expect(skipTargetsFrom(seg, 0)).not.toContain('ci');
  });
  it('a non-skippable intermediate blocks all farther targets', () => {
    const blocked = [s('a'), s('b'), s('gate', 'ALWAYS'), s('c'), s('d')];
    // From a: 'gate' is reachable (only b is skipped, CONDITIONAL). 'c' and
    // beyond would require skipping the ALWAYS 'gate' — blocked.
    expect(skipTargetsFrom(blocked, 0)).toEqual(['gate']);
  });
  it('returns [] at the end of a segment', () => {
    expect(skipTargetsFrom(seg, seg.length - 1)).toEqual([]);
    expect(skipTargetsFrom(seg, seg.length - 2)).toEqual([]);
  });
});

describe('resolveSkipTo', () => {
  const seg = [s('bt', 'ALWAYS'), s('ci'), s('cd'), s('env', 'ALWAYS'), s('deploy')];

  it('resolves a valid target and returns the intermediates', () => {
    const res = resolveSkipTo({ skipTo: 'cd', segmentStages: seg, currentIndex: 0 });
    expect(res.error).toBeUndefined();
    expect(res.targetIndex).toBe(2);
    expect(res.skippedStages.map((x) => x.stageId)).toEqual(['ci']);
  });
  it('the target itself may be ALWAYS (it runs its full ritual)', () => {
    const res = resolveSkipTo({ skipTo: 'env', segmentStages: seg, currentIndex: 0 });
    expect(res.error).toBeUndefined();
    expect(res.skippedStages.map((x) => x.stageId)).toEqual(['ci', 'cd']);
  });
  it('rejects a target requiring a non-skippable intermediate', () => {
    const res = resolveSkipTo({ skipTo: 'deploy', segmentStages: seg, currentIndex: 0 });
    expect(res.error).toMatch(/cannot skip "env"/);
  });
  it('rejects the immediate next stage', () => {
    expect(resolveSkipTo({ skipTo: 'ci', segmentStages: seg, currentIndex: 0 }).error).toMatch(
      /nothing to skip/,
    );
  });
  it('rejects unknown / backward / non-string targets', () => {
    expect(resolveSkipTo({ skipTo: 'nope', segmentStages: seg, currentIndex: 0 }).error).toMatch(
      /not a later stage/,
    );
    expect(resolveSkipTo({ skipTo: 'bt', segmentStages: seg, currentIndex: 2 }).error).toMatch(
      /not a later stage/,
    );
    expect(resolveSkipTo({ skipTo: 42, segmentStages: seg, currentIndex: 0 }).error).toMatch(
      /must be a stage id/,
    );
  });
});
