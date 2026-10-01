import { loadExecutionPlan, loadWorkflowScopes } from './v2-workflow-plan.js';

const PROJECTION_FIELDS = ['scope', 'skipStageIds', 'composedGrid', 'strict'];
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

    const value = meta?.[field];
    if (value === undefined) continue;
    // Match existing call sites: empty/null overlays mean no projection
    // argument unless a caller explicitly supplies one to clear a snapshot.
    if (field === 'skipStageIds' && (!Array.isArray(value) || value.length === 0)) continue;
    if (field === 'composedGrid' && value == null) continue;
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

export { createIntentMethodologyLoader, intentMethodologyOptions };
