// Canonical set of valid Review status values.
//
// The ECS container (mcp-server-graph) inlines a copy of this list because it
// can't import from lambda/shared/ at runtime (Dockerfile only copies
// lambda/agents-ecs/*). Update BOTH when adding a new status.
// Consumed by lambda/reviews/index.js and lambda/agents-ecs/mcp-server-graph/index.js.
const VALID_REVIEW_STATUSES = ['PENDING', 'PASSED', 'FAILED', 'PARTIAL'];

module.exports = { VALID_REVIEW_STATUSES };
