import { pinCustomRuleVersions as pinWithS3 } from '../../shared/custom-rule-versions.js';
import { buildWorkflowCheckpoint } from '../../shared/workflow-checkpoint.js';
import { closeEngineGraph, engineGraphOpener } from '../engine-graph.js';

const snapshotCurrentArtifactHeads = ({ graph }) => graph.snapshotCurrentArtifactHeads({});

// Capture the latest completed workflow boundary and atomically replace the
// execution's latest-checkpoint pointer. Failures leave the prior checkpoint.
const createWorkflowCheckpoint = async (payload, deps) => {
  const {
    projectId,
    intentId,
    executionId,
    orchestratorRunId,
    sourceStageInstanceId = null,
  } = payload ?? {};
  const {
    store,
    s3,
    bucket,
    clock = () => new Date().toISOString(),
    snapshotArtifacts = snapshotCurrentArtifactHeads,
    // The semantic pin operation (engine-data's blob.pinCustomRuleVersions in
    // remote mode); flag off it HEADs with the injected S3 client.
    pinCustomRuleVersions = ({ rules }) => pinWithS3({ s3, bucket, rules }),
  } = deps;
  const openEngineGraph = engineGraphOpener(deps);
  if (!intentId || !executionId || !orchestratorRunId) {
    return { ok: false, reason: 'missing_identity' };
  }

  let graph;
  try {
    const records = await store.getExecutionRecords(executionId, { includeOutputs: false });
    if (!records.meta || records.meta.projectId !== projectId || intentId !== executionId) {
      return { ok: false, reason: 'execution_not_found' };
    }
    graph = await openEngineGraph({ projectId, intentId, executionId });
    const artifactRefs = await snapshotArtifacts({ graph, intentId });
    const customRuleRefs = await pinCustomRuleVersions({ rules: records.meta.customRules ?? [] });
    const checkpoint = buildWorkflowCheckpoint({
      executionId,
      createdAt: clock(),
      sourceStageInstanceId,
      records,
      artifactRefs,
      customRuleRefs,
    });
    await store.putWorkflowCheckpoint({ ...checkpoint, orchestratorRunId });
    return {
      ok: true,
      checkpointId: checkpoint.checkpointId,
      artifactCount: artifactRefs.length,
      customRuleCount: customRuleRefs.length,
    };
  } catch (error) {
    return { ok: false, reason: 'checkpoint_failed', detail: error.message };
  } finally {
    await closeEngineGraph(graph);
  }
};

export { createWorkflowCheckpoint };
export default createWorkflowCheckpoint;
