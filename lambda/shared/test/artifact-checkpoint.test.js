import { describe, expect, it } from 'vitest';
import {
  artifactSnapshot,
  artifactSnapshotHash,
  readCheckpointArtifactVersions,
  readCurrentArtifactHeadHashes,
} from '../artifact-versioning.js';

const graphReturning = (rows) => {
  const traversal = {
    V: () => traversal,
    hasLabel: () => traversal,
    has: () => traversal,
    valueMap: () => traversal,
    toList: async () => rows,
  };
  return traversal;
};

describe('artifact checkpoint identity', () => {
  const artifact = {
    id: 'requirements',
    artifact_type: 'requirements',
    created_by_stage_instance_id: 'requirements-analysis',
    content: '# Requirements\n',
    updated_at: '2026-08-14T10:00:00.000Z',
    vertexId: 'internal-neptune-id',
    version_count: 7,
  };

  it('hashes every field that affects native projection', () => {
    expect(artifactSnapshotHash(artifact)).not.toBe(
      artifactSnapshotHash({ ...artifact, content: '# Changed\n' }),
    );
    expect(artifactSnapshotHash(artifact)).not.toBe(
      artifactSnapshotHash({ ...artifact, repository: 'org/api' }),
    );
  });

  it('ignores graph bookkeeping that does not affect the exported artifact', () => {
    expect(artifactSnapshot(artifact)).not.toHaveProperty('vertexId');
    expect(artifactSnapshotHash(artifact)).toBe(
      artifactSnapshotHash({ ...artifact, vertexId: 'different', version_count: 99 }),
    );
  });

  it('reports a missing checkpoint artifact version', async () => {
    await expect(
      readCheckpointArtifactVersions({
        g: graphReturning([]),
        intentId: 'i1',
        refs: [{ versionId: 'a1:sha256:expected', snapshotHash: 'expected' }],
      }),
    ).rejects.toMatchObject({
      code: 'export_checkpoint_unavailable',
      versionId: 'a1:sha256:expected',
      reason: 'missing',
    });
  });

  it('reports a checkpoint artifact version hash mismatch', async () => {
    await expect(
      readCheckpointArtifactVersions({
        g: graphReturning([
          {
            id: ['a1:sha256:expected'],
            snapshot_hash: ['different'],
          },
        ]),
        intentId: 'i1',
        refs: [{ versionId: 'a1:sha256:expected', snapshotHash: 'expected' }],
      }),
    ).rejects.toMatchObject({
      code: 'export_checkpoint_unavailable',
      versionId: 'a1:sha256:expected',
      reason: 'hash_mismatch',
    });
  });
});

// Producing-stage and lane attribution on each head is what lets a stage approval
// cover only what THAT stage produced. The graph-writer's provenance stamp writes
// '' for a dimension the scope did not have, so '' must read back as "not
// recorded" — one representation, not two.
describe('current artifact head attribution', () => {
  const entries = (props) => ({
    V: () => entries(props),
    has: () => entries(props),
    out: () => entries(props),
    hasLabel: () => entries(props),
    project: () => entries(props),
    by: () => entries(props),
    toList: async () => [
      new Map([
        ['vertexId', 'v1'],
        ['props', new Map(Object.entries(props).map(([key, value]) => [key, [value]]))],
      ]),
    ],
  });

  const headFrom = async (props) =>
    (
      await readCurrentArtifactHeadHashes({
        g: entries({
          id: 'requirements',
          artifact_type: 'requirements',
          intent_id: 'i1',
          content: '# Requirements\n',
          ...props,
        }),
        intentId: 'i1',
      })
    )[0];

  it('carries the producing stage and lane it was stamped with', async () => {
    expect(
      await headFrom({
        created_by_stage_instance_id: 'si-req',
        section_index: 2,
        unit_slug: 'lane/one',
      }),
    ).toMatchObject({ stageInstanceId: 'si-req', sectionIndex: 2, unitSlug: 'lane/one' });
  });

  it('reads the empty provenance stamp as not recorded', async () => {
    expect(
      await headFrom({
        created_by_stage_instance_id: '',
        section_index: '',
        unit_slug: '',
      }),
    ).toMatchObject({ stageInstanceId: null, sectionIndex: null, unitSlug: null });
  });

  it('reads a row with no provenance properties as not recorded', async () => {
    expect(await headFrom({})).toMatchObject({
      stageInstanceId: null,
      sectionIndex: null,
      unitSlug: null,
    });
  });
});
