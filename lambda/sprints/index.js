import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { buildResponse } from '../shared/response.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(host, port, credentials, '/gremlin', protocol);
  return new DriverRemoteConnection(url, { headers });
};

const nonEmpty = (s) => (s && s !== '' ? s : null);

// Map the polymorphic tracker_* properties on a Sprint vertex into the
// normalized `tracker` DTO. Returns null when the sprint has no linked
// tracker resource (legacy sprints without a backfill, or sprints created
// without an issue link).
const mapTracker = (v) => {
  const provider = nonEmpty(v.get('tracker_provider')?.[0]);
  if (!provider) return null;
  return {
    provider,
    instance: nonEmpty(v.get('tracker_instance')?.[0]),
    externalProjectKey: nonEmpty(v.get('tracker_external_project_key')?.[0]),
    resourceType: nonEmpty(v.get('tracker_resource_type')?.[0]),
    resourceId: nonEmpty(v.get('tracker_resource_id')?.[0]),
    resourceUrl: nonEmpty(v.get('tracker_resource_url')?.[0]),
  };
};

const mapSprint = (v) => {
  const arn = v.get('current_execution_arn')?.[0];
  const execId = v.get('current_execution_id')?.[0];
  const status = v.get('current_agent_status')?.[0];
  const prUrl = v.get('pr_url')?.[0];
  const prNumber = v.get('pr_number')?.[0];
  const branch = v.get('branch')?.[0];
  const baseBranch = v.get('base_branch')?.[0];

  const tracker = mapTracker(v);

  // Surface issueNumber/issueUrl for backward compatibility with the original
  // GitHub-issue integration (#171). New writes always populate the polymorphic
  // tracker_* fields, so prefer those. Pre-migration sprints fall back to the
  // legacy issue_number/issue_url properties — these are kept on disk
  // permanently so unmigrated data keeps rendering.
  let issueNumber;
  let issueUrl;
  if (tracker?.provider === 'github-issues' && tracker.resourceType === 'issue') {
    issueNumber = tracker.resourceId;
    issueUrl = tracker.resourceUrl;
  } else {
    issueNumber = nonEmpty(v.get('issue_number')?.[0]);
    issueUrl = nonEmpty(v.get('issue_url')?.[0]);
  }

  return {
    id: v.get('id')?.[0] || '',
    name: v.get('name')?.[0] || '',
    description: v.get('description')?.[0] || '',
    phase: v.get('phase')?.[0] || 'INCEPTION',
    createdAt: v.get('created_at')?.[0] || '',
    currentExecutionArn: arn && arn !== '' ? arn : null,
    currentExecutionId: execId && execId !== '' ? execId : null,
    currentAgentType: v.get('current_agent_type')?.[0] || null,
    currentAgentStatus: status && status !== '' ? status : null,
    agentStartedAt: v.get('agent_started_at')?.[0] || null,
    agentCompletedAt: v.get('agent_completed_at')?.[0] || null,
    prUrl: prUrl && prUrl !== '' ? prUrl : null,
    prNumber: prNumber && prNumber !== '' ? prNumber : null,
    branch: branch && branch !== '' ? branch : null,
    baseBranch: baseBranch && baseBranch !== '' ? baseBranch : null,
    issueNumber,
    issueUrl,
    tracker,
  };
};

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    let g = traversal().withRemote(conn);
    if (process.env.GREMLIN_PARTITION) {
      g = g.withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: process.env.GREMLIN_PARTITION,
          readPartitions: [process.env.GREMLIN_PARTITION],
        }),
      );
    }
    const { httpMethod, pathParameters } = event;
    const { projectId, sprintId } = pathParameters || {};

    // Sprints belong to v1 projects, which are read-only: sprint writes were
    // removed together with the v1 execution engine, so only the GET routes
    // (list + single) remain.
    switch (httpMethod) {
      case 'GET': {
        if (sprintId) {
          const r = await g.V().has('Sprint', 'id', sprintId).valueMap().next();
          if (!r.value) return res(404, { error: 'Sprint not found' });
          return res(200, mapSprint(r.value));
        }
        const list = await g
          .V()
          .has('Project', 'id', projectId)
          .out('HAS_SPRINT')
          .valueMap()
          .toList();
        return res(200, list.map(mapSprint));
      }

      default:
        return res(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return res(500, { error: 'Internal server error' });
  } finally {
    if (conn)
      try {
        await conn.close();
      } catch {}
  }
};
