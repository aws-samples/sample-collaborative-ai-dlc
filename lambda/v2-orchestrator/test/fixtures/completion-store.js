// Stateful completion reads for the orchestration fakes. Existing tests own
// their store methods and assertions; these reads assemble the writes those
// fakes accepted. Conditional-write races use DynamoDB Local separately.
import { vi } from 'vitest';

export const withCompletionReads = (store) => {
  const calls = {};
  for (const name of ['updateExecution', 'updateUnitState', 'createUnitPr', 'updateUnitPr']) {
    if (!store[name]) continue;
    if (!store[name].mock) {
      const original = store[name];
      store[name] = vi.fn((...args) => original(...args));
    }
    calls[name] = () =>
      store[name].mock.calls
        .filter((_, index) => store[name].mock.settledResults?.[index]?.type !== 'rejected')
        .map(([input]) => input);
  }
  store.getCompletionRecords = async (executionId) => {
    const loaded = await store.getExecution(executionId);
    const meta = { ...loaded };
    for (const input of calls.updateExecution?.() ?? []) {
      for (const field of ['status', 'orchestratorRunId', 'completionValidation']) {
        if (input[field] !== undefined) meta[field] = input[field];
      }
    }
    const units = new Map(
      ((await store.listUnits?.(executionId)) ?? []).map((row) => [
        `${row.sectionIndex}:${row.slug}`,
        { ...row },
      ]),
    );
    for (const input of calls.updateUnitState?.() ?? []) {
      const key = `${input.sectionIndex}:${input.slug}`;
      units.set(key, { ...units.get(key), ...input, ...input.fields });
    }
    const unitPrs = new Map(
      ((await store.listUnitPrs?.(executionId)) ?? []).map((row) => [
        `${row.sectionIndex}:${row.unitSlug ?? row.slug}:${row.repository}`,
        { ...row },
      ]),
    );
    for (const input of [...(calls.createUnitPr?.() ?? []), ...(calls.updateUnitPr?.() ?? [])]) {
      const key = `${input.sectionIndex}:${input.slug}:${input.repository}`;
      unitPrs.set(key, { ...unitPrs.get(key), ...input, ...input.fields });
    }
    return {
      meta,
      unitPlan: (await store.getUnitPlan?.(executionId)) ?? null,
      units: [...units.values()],
      unitPrs: [...unitPrs.values()],
      humanTasks: [],
    };
  };
  return store;
};
