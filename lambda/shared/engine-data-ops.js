// The wire contract between the AgentCore runtime and the engine-data Lambda.
//
// The runtime keeps the engine and moves only its process-store calls behind
// engine-data, one call per store method. Both sides read the allowlist from
// here so the client can never expose a method the Lambda would refuse, and a
// method added to the store stays unreachable until it is added below with its
// argument schema.
export const ENGINE_DATA_OP_PREFIX = 'store.';

export const ENGINE_DATA_STORE_METHODS = Object.freeze([
  'appendEvent',
  'getStage',
  'getExecution',
  'updateStageState',
  'getHumanTask',
  'updateExecution',
  'recordMetric',
  'recordSensorRun',
  'putStage',
  'putReceipt',
  'listReceipts',
  'getUnitPlan',
  'updateCompose',
  'syncUnitRows',
  'supersedeHumanTask',
  'resumeStageRow',
  'putWorkflowCheckpoint',
  'putUnitPlan',
  'markSteeringConsumed',
  'markLoopBackArchived',
  'listSensorRuns',
  'listPendingSteering',
  'listEvents',
  'getExecutionRecords',
  'createHumanTask',
  'createExecution',
  'claimStageAttempt',
  'appendOutput',
  'raiseStageCounter',
  'getQuorumEdit',
  'updateQuorumEdit',
  'recordGraphRead',
  'setLoopBackRecommendation',
  'getReceipt',
]);

export const ENGINE_DATA_DENIED_ERROR = 'EngineDataAccessDenied';

export const engineDataOp = (method) => `${ENGINE_DATA_OP_PREFIX}${method}`;
