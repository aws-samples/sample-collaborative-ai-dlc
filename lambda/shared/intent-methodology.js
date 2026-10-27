import { loadExecutionPlan, loadWorkflowScopes } from './v2-workflow-plan.js';

// THE per-intent plan projection: every field that changes WHICH plan an intent
// resolves. The intents API, the orchestrator walk and the container's stage
// resolution all build their projection from this one list, so a new projection
// field cannot reach one caller and silently miss another — which is exactly how
// a validated setting ended up never reaching the run.
const PROJECTION_FIELDS = [
  'scope',
  'skipStageIds',
  'composedGrid',
  'policyScope',
  'strict',
  'intentSettings',
];

// META records the per-intent settings under their own name; the plan resolver
// calls them `intentSettings`. One mapping here reaches every plan caller.
const META_FIELD_ALIASES = Object.freeze({ intentSettings: 'aidlcSettings' });
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const resolve = (value) => (typeof value === 'function' ? value() : value);

// Methodology coordinates belong to the intent snapshot. Callers may select a
// plan projection, but cannot change the workflow or methodology being loaded.
const intentMethodologyOptions = (meta, { s3, bucket } = {}) => {
  const options = {};
  if (meta?.methodologyPins != null) options.methodologyPins = meta.methodologyPins;
  if (meta?.methodologyRelease) {
    options.methodologyRelease = meta.methodologyRelease;
    options.s3 = s3;
    options.bucket = resolve(bucket);
  }
  return options;
};

const planProjectionOptions = (meta, overrides) => {
  const options = {};
  for (const field of PROJECTION_FIELDS) {
    if (hasOwn(overrides, field)) {
      options[field] = overrides[field];
      continue;
    }

    const value = meta?.[META_FIELD_ALIASES[field] ?? field];
    if (value === undefined) continue;
    // Match existing call sites: empty/null overlays mean no projection
    // argument unless a caller explicitly supplies one to clear a snapshot.
    if (field === 'skipStageIds' && (!Array.isArray(value) || value.length === 0)) continue;
    if (field === 'composedGrid' && value == null) continue;
    if (field === 'policyScope' && value == null) continue;
    if (field === 'intentSettings' && value == null) continue;
    options[field] = value;
  }
  return options;
};

const createIntentMethodologyLoader = ({
  ddb,
  tableName,
  s3,
  bucket,
  loadPlan = loadExecutionPlan,
  loadScopes = loadWorkflowScopes,
}) => ({
  loadPlan: (meta, overrides = {}) =>
    loadPlan({
      ddb,
      tableName: resolve(tableName),
      ...planProjectionOptions(meta, overrides),
      ...intentMethodologyOptions(meta, { s3, bucket }),
      workflowId: meta?.workflowId,
      workflowVersion: meta?.workflowVersion,
    }),
  loadScopes: (meta) =>
    loadScopes({
      ddb,
      tableName: resolve(tableName),
      ...intentMethodologyOptions(meta, { s3, bucket }),
      workflowId: meta?.workflowId,
      workflowVersion: meta?.workflowVersion,
    }),
});

export { createIntentMethodologyLoader, intentMethodologyOptions, planProjectionOptions };
