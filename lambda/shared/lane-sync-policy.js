// Lane sync policy shared by platform settings, projects, intent creation and
// the agent runtime (agentcore/lane-sync.js). The platform default lives in SSM
// (`<prefix>/lane-sync-policy`, Admin UI managed); a project stores either an
// explicit override or `default`. The effective value is resolved once at
// intent create and snapshotted onto the execution META row
// (`laneSyncPolicy`), so a setting change never alters an in-flight intent.

const LANE_SYNC_POLICIES = ['none', 'before-stage'];
const PROJECT_LANE_SYNC_POLICIES = ['default', ...LANE_SYNC_POLICIES];
const DEFAULT_LANE_SYNC_POLICY = 'none';

// Fail-safe: anything but an explicit 'before-stage' means no sync.
const normalizePlatformLaneSyncPolicy = (value) =>
  LANE_SYNC_POLICIES.includes(value) ? value : DEFAULT_LANE_SYNC_POLICY;

// A missing project value inherits the platform; an unknown one is invalid (null).
const normalizeProjectLaneSyncPolicy = (value) => {
  if (value === undefined || value === null || value === '') return 'default';
  return PROJECT_LANE_SYNC_POLICIES.includes(value) ? value : null;
};

const effectiveLaneSyncPolicy = (platformValue, projectValue = 'default') => {
  if (LANE_SYNC_POLICIES.includes(projectValue)) return projectValue;
  return normalizePlatformLaneSyncPolicy(platformValue);
};

export {
  LANE_SYNC_POLICIES,
  PROJECT_LANE_SYNC_POLICIES,
  DEFAULT_LANE_SYNC_POLICY,
  normalizePlatformLaneSyncPolicy,
  normalizeProjectLaneSyncPolicy,
  effectiveLaneSyncPolicy,
};

export default {
  LANE_SYNC_POLICIES,
  PROJECT_LANE_SYNC_POLICIES,
  DEFAULT_LANE_SYNC_POLICY,
  normalizePlatformLaneSyncPolicy,
  normalizeProjectLaneSyncPolicy,
  effectiveLaneSyncPolicy,
};
