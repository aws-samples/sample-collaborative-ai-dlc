import gremlin from 'gremlin';

const { cardinality } = gremlin.process;

// Shared graph mutation used by membership removal and tracker disconnect.
// No credentials live on the graph; bindings only reference the delegating user.
export const invalidateTrackerBindingsByDelegator = async (g, userId, reason, projectId) => {
  let bindings = projectId
    ? g.V().has('Project', 'id', projectId).out('HAS_TRACKER').hasLabel('TrackerBinding')
    : g.V().hasLabel('TrackerBinding');
  await bindings
    .has('provider', 'jira-cloud')
    .has('connection_user_id', userId)
    .property(cardinality.single, 'status', 'invalid')
    .property(cardinality.single, 'invalid_reason', reason)
    .toList();
};
