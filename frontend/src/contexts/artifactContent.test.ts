import { describe, expect, it } from 'vitest';
import type { IntentArtifact, IntentDetail } from '@/services/intents';
import {
  applyArtifactContents,
  artifactContentIdentities,
  carryArtifactContent,
  markArtifactContentsFailed,
} from './artifactContent';

const artifact = (id: string, over: Partial<IntentArtifact> = {}): IntentArtifact => ({
  id,
  artifactType: 'doc',
  title: id,
  createdByExecutionId: 'i1',
  createdByStageInstanceId: 'si-1',
  createdAt: '2026-01-01T00:00:00Z',
  generation: 1,
  ...over,
});

const detail = (artifacts: IntentArtifact[]) => ({ artifacts }) as unknown as IntentDetail;

describe('artifactContent', () => {
  it('attaches bodies only to the revision they were fetched for', () => {
    const started = detail([artifact('a'), artifact('b')]);
    const identities = artifactContentIdentities(started);
    // `b` was replaced while the fetch ran.
    const current = detail([artifact('a'), artifact('b', { generation: 2 })]);
    const merged = applyArtifactContents(
      current,
      [
        { id: 'a', content: '# A' },
        { id: 'b', content: '# old B' },
      ],
      identities,
    );
    expect(merged.artifacts.map((a) => a.content)).toEqual(['# A', undefined]);
  });

  it('keeps the too-large marker and returns the same object when nothing changes', () => {
    const current = detail([artifact('a')]);
    const identities = artifactContentIdentities(current);
    const entries = [{ id: 'a', content: null, contentOmitted: 'too_large' as const }];
    const merged = applyArtifactContents(current, entries, identities);
    expect(merged.artifacts[0]).toMatchObject({ content: null, contentUnavailable: 'too_large' });
    expect(applyArtifactContents(merged, entries, identities)).toBe(merged);
  });

  it('marks only still-unloaded bodies of the fetched revision as failed', () => {
    const started = detail([artifact('a'), artifact('b'), artifact('c', { content: '# C' })]);
    const identities = artifactContentIdentities(started);
    const current = detail([
      artifact('a'),
      artifact('b', { generation: 2 }),
      artifact('c', { content: '# C' }),
    ]);
    const marked = markArtifactContentsFailed(current, identities);
    expect(marked.artifacts.map((a) => a.contentUnavailable ?? null)).toEqual([
      'error',
      null,
      null,
    ]);
  });

  it('carries a too-large marker forward but not a failed fetch', () => {
    const prev = detail([
      artifact('a', { content: null, contentUnavailable: 'too_large' }),
      artifact('b', { content: null, contentUnavailable: 'error' }),
    ]);
    const carried = carryArtifactContent(detail([artifact('a'), artifact('b')]), prev);
    expect(carried.artifacts[0]).toMatchObject({ contentUnavailable: 'too_large' });
    expect(carried.artifacts[1].content).toBeUndefined();
    expect(carried.artifacts[1].contentUnavailable).toBeUndefined();
  });

  it('carries a previous body forward only while the revision is unchanged', () => {
    const prev = detail([
      artifact('a', { content: '# A' }),
      artifact('b', { content: '# B', editRevision: 'r1' }),
    ]);
    const next = detail([artifact('a'), artifact('b', { editRevision: 'r2' }), artifact('c')]);
    const carried = carryArtifactContent(next, prev);
    expect(carried.artifacts.map((a) => a.content)).toEqual(['# A', undefined, undefined]);
    expect(carryArtifactContent(next, null)).toBe(next);
  });

  it('keeps lanes apart when two heads share an id', () => {
    const current = detail([
      artifact('spec', { contentKey: 'k-unit-a' }),
      artifact('spec', { contentKey: 'k-unit-b' }),
    ]);
    const merged = applyArtifactContents(
      current,
      [
        { id: 'spec', contentKey: 'k-unit-b', content: '# B' },
        { id: 'spec', contentKey: 'k-unit-a', content: '# A' },
      ],
      artifactContentIdentities(current),
    );
    expect(merged.artifacts.map((a) => a.content)).toEqual(['# A', '# B']);
  });
});
