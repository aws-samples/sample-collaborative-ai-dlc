import { snapshotCurrentArtifactHeads } from '../../shared/artifact-versioning.js';
import { pinCustomRuleVersions } from '../../shared/custom-rule-versions.js';
import { buildWorkflowCheckpoint } from '../../shared/workflow-checkpoint.js';
import { closeGraphSource } from '../mcp/graph-writer.js';

// Capture the latest completed workflow boundary and atomically replace the
// execution's latest-checkpoint pointer. Failures leave the prior checkpoint.
const createWorkflowCheckpoint = async (payload, deps) => {
  const { projectId, intentId, executionId, sourceStageInstanceId = null } = payload ?? {};
  const {
    store,
    openGraph,
    s3,
    bucket,
    clock = () => new Date().toISOString(),
    snapshotArtifacts = snapshotCurrentArtifactHeads,
  } = deps;
  if (!intentId || !executionId) return { ok: false, reason: 'missing_identity' };

  let g;
  try {
    const records = await store.getExecutionRecords(executionId, { includeOutputs: false });
    if (!records.meta || records.meta.projectId !== projectId || intentId !== executionId) {
      return { ok: false, reason: 'execution_not_found' };
    }
    g = await openGraph();
    const artifactRefs = await snapshotArtifacts({ g, intentId, clock });
    const customRuleRefs = await pinCustomRuleVersions({
      s3,
      bucket,
      rules: records.meta.customRules ?? [],
    });
    const checkpoint = buildWorkflowCheckpoint({
      executionId,
      createdAt: clock(),
      sourceStageInstanceId,
      records,
      artifactRefs,
      customRuleRefs,
    });
    await store.putWorkflowCheckpoint(checkpoint);
    return {
      ok: true,
      checkpointId: checkpoint.checkpointId,
      artifactCount: artifactRefs.length,
      customRuleCount: customRuleRefs.length,
    };
  } catch (error) {
    return { ok: false, reason: 'checkpoint_failed', detail: error.message };
  } finally {
    await closeGraphSource(g);
  }
};

export { createWorkflowCheckpoint };
export default createWorkflowCheckpoint;
