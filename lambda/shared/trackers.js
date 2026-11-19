// Shared traversal/projection helpers for the tracker provider abstraction
// (issue #194). Two lambdas read TrackerBinding vertices into the same
// camelCase API shape:
//
//   1. lambda/projects — GET /projects[/{id}] folds bindings inline so the
//      list/single endpoints answer in one Neptune round-trip.
//
//   2. lambda/trackers — GET /projects/{id}/trackers and DELETE/issue routes
//      that resolve a single binding from a path parameter.
//
// Keeping the projection step + the result mapper here means both lambdas
// produce identical wire shapes and the projection logic doesn't drift.

import gremlin from 'gremlin';

const __ = gremlin.process.statics;

const getVal = (v, key) => {
  if (!v) return '';
  const raw = v instanceof Map ? v.get(key) : v[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
};

// Anonymous Gremlin step that projects a TrackerBinding vertex into the
// camelCase shape the API exposes. Used as a `.flatMap()` argument so callers
// fold trackers per project in a single traversal (no N+1).
const trackerBindingProjectionStep = () =>
  __.project(
    'id',
    'provider',
    'instance',
    'externalProjectKey',
    'displayName',
    'createdAt',
    'createdBy',
    'delegatedAt',
    'connectionUserId',
    'cloudId',
    'externalProjectId',
    'status',
    'invalidReason',
  )
    .by('id')
    .by('provider')
    .by(__.coalesce(__.values('instance'), __.constant(null)))
    .by(__.coalesce(__.values('external_project_key'), __.constant(null)))
    .by(__.coalesce(__.values('display_name'), __.constant(null)))
    .by(__.coalesce(__.values('created_at'), __.constant(null)))
    .by(__.coalesce(__.values('created_by'), __.constant(null)))
    .by(__.coalesce(__.values('delegated_at'), __.constant(null)))
    .by(__.coalesce(__.values('connection_user_id'), __.constant(null)))
    .by(__.coalesce(__.values('cloud_id'), __.constant(null)))
    .by(__.coalesce(__.values('external_project_id'), __.constant(null)))
    .by(__.coalesce(__.values('status'), __.constant(null)))
    .by(__.coalesce(__.values('invalid_reason'), __.constant(null)));

// Anonymous step yielding a single fold()-collected list of binding maps
// scoped to the current Project vertex. Returns [] when the project has no
// HAS_TRACKER edges.
const projectTrackersFoldStep = () =>
  __.out('HAS_TRACKER').hasLabel('TrackerBinding').flatMap(trackerBindingProjectionStep()).fold();

// Coerce a `trackerBindingProjectionStep()` result row into the API shape.
// The projection emits camelCase keys directly, so this is just a
// Map-vs-plain-object adapter (gremlin's gLV4 may return either).
const mapBinding = (m) => {
  const get = (k) => (m instanceof Map ? m.get(k) : m[k]);
  return {
    id: get('id'),
    provider: get('provider'),
    instance: get('instance'),
    externalProjectKey: get('externalProjectKey'),
    displayName: get('displayName'),
    createdAt: get('createdAt'),
    createdBy: get('createdBy'),
    ...(get('provider') === 'jira-cloud'
      ? {
          delegatedAt: get('delegatedAt'),
          connectionUserId: get('connectionUserId'),
          cloudId: get('cloudId'),
          externalProjectId: get('externalProjectId'),
          status: get('status') || 'invalid',
          invalidReason: get('invalidReason') || (get('status') ? null : 'delegation_required'),
        }
      : {}),
  };
};

export { getVal, trackerBindingProjectionStep, projectTrackersFoldStep, mapBinding };
export default {
  getVal,
  trackerBindingProjectionStep,
  projectTrackersFoldStep,
  mapBinding,
};
