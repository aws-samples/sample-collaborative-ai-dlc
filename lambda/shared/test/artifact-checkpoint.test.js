import { describe, expect, it } from 'vitest';
import {
  artifactSnapshot,
  artifactSnapshotHash,
  readCheckpointArtifactVersions,
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
