// lambda/discussions — discussion SCOPE abstraction.
//
// A discussion thread lives under a scope ROOT vertex: a v1 Sprint or a v2
// Intent. Everything that used to be sprint-specific (the root vertex label, the
// id property stamped on Discussion/Message vertices, the realtime channel, the
// valid entity types + their anchor vertices) is captured here so the handlers
// and data-access stay scope-neutral.
//
// The SPRINT scope reproduces the original behaviour EXACTLY (same labels, same
// `sprint_id` property, same `sprint:<id>` channel, same entity-type anchors) so
// the v1 test suite passes unchanged. The INTENT scope is the additive v2 path:
// threads anchor on the Intent vertex and on the artifacts it CONTAINS.

// Per-scope entity-type → anchor vertex label.
export const SPRINT_ANCHOR_LABELS = {
  sprint: 'Sprint',
  inception: 'Sprint',
  question: 'Question',
  requirement: 'Requirement',
  userstory: 'UserStory',
  task: 'Task',
  review: 'Review',
  generalinfo: 'GeneralInfo',
};

export const INTENT_ANCHOR_LABELS = {
  // The whole-intent thread self-anchors on the Intent vertex.
  intent: 'Intent',
  // A thread per produced artifact (Intent --CONTAINS--> Artifact).
  artifact: 'Artifact',
};

// Build the scope descriptor for a sprint. `rootId` is the sprintId.
export const sprintScope = (sprintId) => ({
  kind: 'sprint',
  rootLabel: 'Sprint',
  rootId: sprintId,
  // Property stamped on Discussion/Message vertices + read-cursor rows.
  idProp: 'sprint_id',
  // The app-WS channel the fan-out targets (mirrors broadcastToSprintChannel).
  channel: `sprint:${sprintId}`,
  anchorLabels: SPRINT_ANCHOR_LABELS,
  entityTypes: Object.keys(SPRINT_ANCHOR_LABELS),
  // Types that anchor on the root vertex itself (entityId === rootId).
  selfTypes: ['sprint', 'inception'],
  // Sprint threads emit a Sprint-anchored TimelineEvent on creation.
  timeline: true,
  notFoundError: 'Sprint not found',
});

// Build the scope descriptor for a v2 intent. `projectId` is known from the path
// (the intent realtime-token + routes are project-scoped).
export const intentScope = (intentId, projectId) => ({
  kind: 'intent',
  rootLabel: 'Intent',
  rootId: intentId,
  idProp: 'intent_id',
  channel: `intent:${intentId}`,
  anchorLabels: INTENT_ANCHOR_LABELS,
  entityTypes: Object.keys(INTENT_ANCHOR_LABELS),
  selfTypes: ['intent'],
  // v2 has no Sprint TimelineEvent; process events live in the v2 process table.
  timeline: false,
  projectId,
  notFoundError: 'Intent not found',
});

// Resolve the scope descriptor from the request path parameters. Returns null
// for an unrecognized shape (handlers turn that into a 404). Pure — no I/O.
export const resolveScope = (pathParameters = {}) => {
  const { sprintId, intentId, projectId } = pathParameters || {};
  if (sprintId) return sprintScope(sprintId);
  if (intentId) return intentScope(intentId, projectId || null);
  return null;
};
