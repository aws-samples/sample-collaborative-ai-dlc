'use strict';

// Shared core for the tracker provider abstraction migration (issue #194).
//
// Two callers consume this:
//
//   1. lambda/migrate-tracker-fields — bulk admin lambda that walks every
//      project + sprint in Neptune. Invoked via `aws lambda invoke`.
//
//   2. lambda/projects — per-project endpoint POST /projects/{id}/migrate-tracker
//      triggered by the "Migrate" card in ProjectSettings, scoped to one
//      project (and its sprints) at a time.
//
// Both call into the same logic to avoid drift. Both are idempotent — they
// only touch Sprint vertices with `issue_number` set + `tracker_provider`
// unset, and Project vertices with `issue_integration_enabled='true'` +
// no outgoing HAS_TRACKER edge. Re-running does nothing.

const gremlin = require('gremlin');
const { randomUUID } = require('node:crypto');

const __ = gremlin.process.statics;
const { cardinality } = gremlin.process;

const getVal = (v, key) => {
  if (!v) return '';
  const raw = v instanceof Map ? v.get(key) : v[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
};

const trackerBindingFor = (gitRepo) => ({
  id: randomUUID(),
  provider: 'github-issues',
  instance: 'public',
  external_project_key: gitRepo,
  display_name: gitRepo,
  created_at: new Date().toISOString(),
  created_by: 'migration:tracker-fields',
});

// Add a synthetic HAS_TRACKER edge + TrackerBinding vertex on a Project
// vertex. Caller is responsible for having checked the project actually
// needs the migration; this method is unconditional.
const addSyntheticTrackerBinding = async (g, projectId, gitRepo) => {
  const binding = trackerBindingFor(gitRepo);
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .addV('TrackerBinding')
    .property('id', binding.id)
    .property('provider', binding.provider)
    .property('instance', binding.instance)
    .property('external_project_key', binding.external_project_key)
    .property('display_name', binding.display_name)
    .property('created_at', binding.created_at)
    .property('created_by', binding.created_by)
    .as('b')
    .addE('HAS_TRACKER')
    .from_('p')
    .to('b')
    .next();
};

// Backfill the polymorphic tracker_* properties on a single Sprint vertex
// from its legacy issue_number/issue_url. Caller passes the Sprint's id and
// the parent project's git_repo (used as externalProjectKey).
const backfillSprintTrackerFields = async (g, sprintId, issueNumber, issueUrl, externalProjectKey) => {
  await g
    .V()
    .has('Sprint', 'id', sprintId)
    .property(cardinality.single, 'tracker_provider', 'github-issues')
    .property(cardinality.single, 'tracker_instance', 'public')
    .property(cardinality.single, 'tracker_external_project_key', externalProjectKey || '')
    .property(cardinality.single, 'tracker_resource_type', 'issue')
    .property(cardinality.single, 'tracker_resource_id', issueNumber)
    .property(cardinality.single, 'tracker_resource_url', issueUrl || '')
    .next();
};

// Returns Project vertices that still need a synthetic TrackerBinding
// (issue_integration_enabled='true' AND no outgoing HAS_TRACKER). Optionally
// scoped to a single projectId for the per-project endpoint.
const findProjectsNeedingMigration = async (g, projectId) => {
  let q = g.V().hasLabel('Project');
  if (projectId) q = q.has('id', projectId);
  return q.has('issue_integration_enabled', 'true').where(__.not(__.outE('HAS_TRACKER'))).valueMap().toList();
};

// Returns {sprint, project} pairs for Sprint vertices that still need
// tracker_* backfill (issue_number set AND tracker_provider unset/empty).
// Optionally scoped to all sprints under a single projectId.
const findSprintsNeedingMigration = async (g, projectId) => {
  let q = projectId
    ? g.V().has('Project', 'id', projectId).out('HAS_SPRINT').hasLabel('Sprint')
    : g.V().hasLabel('Sprint');

  return q
    .has('issue_number')
    .not(__.has('issue_number', ''))
    .or(__.not(__.has('tracker_provider')), __.has('tracker_provider', ''))
    .project('sprint', 'project')
    .by(__.valueMap())
    .by(__.in_('HAS_SPRINT').hasLabel('Project').valueMap())
    .toList();
};

// Run the migration. When projectId is provided, scoped to that project.
// When omitted, runs across the whole graph (admin/bulk path).
//
// Returns { dryRun, projects: {candidates, applied}, sprints: {candidates, applied} }.
const runTrackerMigration = async (g, { projectId, dryRun = false } = {}) => {
  const projectRows = await findProjectsNeedingMigration(g, projectId);
  const sprintRows = await findSprintsNeedingMigration(g, projectId);

  const result = {
    dryRun,
    projects: { candidates: projectRows.length, applied: 0 },
    sprints: { candidates: sprintRows.length, applied: 0 },
  };

  if (dryRun) return result;

  for (const v of projectRows) {
    const pid = getVal(v, 'id');
    const gitRepo = getVal(v, 'git_repo');
    if (!pid) continue;
    await addSyntheticTrackerBinding(g, pid, gitRepo);
    result.projects.applied++;
  }

  for (const row of sprintRows) {
    const sprint = row instanceof Map ? row.get('sprint') : row.sprint;
    const project = row instanceof Map ? row.get('project') : row.project;
    const sprintId = getVal(sprint, 'id');
    const issueNumber = getVal(sprint, 'issue_number');
    const issueUrl = getVal(sprint, 'issue_url');
    const externalProjectKey = getVal(project, 'git_repo');
    if (!sprintId || !issueNumber) continue;
    await backfillSprintTrackerFields(g, sprintId, issueNumber, issueUrl, externalProjectKey);
    result.sprints.applied++;
  }

  return result;
};

module.exports = { runTrackerMigration };
