// The store writes a worker's attempt identity fences. engine-data requires the
// same set to carry a stage grant's own identity.
export const STAGE_ATTEMPT_METHODS = Object.freeze([
  'putStage',
  'resumeStageRow',
  'updateStageState',
  'updateExecution',
  'createHumanTask',
  'supersedeHumanTask',
]);

// A worker's immutable identity follows it into every recovery write.
// Legacy synchronous dispatches do not carry these tokens.
export const scopeStageAttempt = (store, ownership) => {
  if (!ownership?.orchestratorRunId || !ownership?.stageCallbackId) return store;
  const scoped = { ...store };
  for (const method of STAGE_ATTEMPT_METHODS) {
    scoped[method] = (input) => store[method]({ ...input, ownership });
  }
  return scoped;
};
