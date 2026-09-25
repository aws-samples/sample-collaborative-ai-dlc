// A worker's immutable identity follows it into every recovery write.
// Legacy synchronous dispatches do not carry these tokens.
export const scopeStageAttempt = (store, ownership) => {
  if (!ownership?.orchestratorRunId || !ownership?.stageCallbackId) return store;
  const scoped = { ...store };
  for (const method of [
    'putStage',
    'resumeStageRow',
    'updateStageState',
    'updateExecution',
    'createHumanTask',
    'supersedeHumanTask',
  ]) {
    scoped[method] = (input) => store[method]({ ...input, ownership });
  }
  return scoped;
};
