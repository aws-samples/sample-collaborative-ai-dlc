'use strict';

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

const gremlin = require('gremlin');

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
  )
    .by('id')
    .by('provider')
    .by(__.coalesce(__.values('instance'), __.constant(null)))
    .by(__.coalesce(__.values('external_project_key'), __.constant(null)))
    .by(__.coalesce(__.values('display_name'), __.constant(null)))
    .by(__.coalesce(__.values('created_at'), __.constant(null)))
    .by(__.coalesce(__.values('created_by'), __.constant(null)));

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
  };
};

// Fetch a project member's role with a single-property traversal.
// Returns the role string when the user is a member, or null otherwise.
// Used by every /projects/{projectId}/... gate; pulling only `role`
// avoids the cost of round-tripping a full valueMap on the edge.
const fetchMembershipRole = async (g, projectId, userId) => {
  const r = await g
    .V()
    .has('Project', 'id', projectId)
    .outE('HAS_MEMBER')
    .as('e')
    .inV()
    .has('User', 'id', userId)
    .select('e')
    .values('role')
    .next();
  if (r.done) return null;
  return r.value || 'member';
};

module.exports = {
  getVal,
  trackerBindingProjectionStep,
  projectTrackersFoldStep,
  mapBinding,
  fetchMembershipRole,
};
