import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { randomUUID } from 'node:crypto';
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

const VALID_PHASES = ['INCEPTION', 'CONSTRUCTION', 'REVIEW', 'COMPLETED'];

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
    const { httpMethod, pathParameters, body } = event;
    const { projectId, sprintId } = pathParameters || {};

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

      case 'POST': {
        const data = JSON.parse(body);
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const phase = data.phase || 'INCEPTION';
        if (!VALID_PHASES.includes(phase)) return res(400, { error: 'Invalid phase' });

        const issueNumber =
          data.issueNumber !== undefined && data.issueNumber !== null
            ? String(data.issueNumber)
            : '';
        const issueUrl = data.issueUrl || '';

        // Two ways the caller can pin a tracker resource to the sprint:
        //   1. data.tracker = {provider, instance, externalProjectKey, resourceType, resourceId, resourceUrl}
        //   2. data.issueNumber/issueUrl — interpreted as a github-issues tracker
        //      against the parent project's git_repo. Legacy path from #171,
        //      kept so older deployed frontends or external API callers keep
        //      working. The Phase 2 frontend (#196) writes (1).
        let trackerProperties = null;
        if (data.tracker?.provider) {
          trackerProperties = {
            provider: data.tracker.provider,
            instance: data.tracker.instance || '',
            externalProjectKey: data.tracker.externalProjectKey || '',
            resourceType: data.tracker.resourceType || 'issue',
            resourceId:
              data.tracker.resourceId !== undefined && data.tracker.resourceId !== null
                ? String(data.tracker.resourceId)
                : '',
            resourceUrl: data.tracker.resourceUrl || '',
          };
        } else if (issueNumber || issueUrl) {
          // Look up the parent project's git_repo so we can populate
          // externalProjectKey for the synthetic GitHub-issues tracker.
          const projectVal = await g.V().has('Project', 'id', projectId).values('git_repo').next();
          const externalProjectKey = projectVal.value || '';
          trackerProperties = {
            provider: 'github-issues',
            instance: 'public',
            externalProjectKey,
            resourceType: 'issue',
            resourceId: issueNumber,
            resourceUrl: issueUrl,
          };
        }

        let createTrav = g
          .V()
          .has('Project', 'id', projectId)
          .as('p')
          .addV('Sprint')
          .property('id', id)
          .property('name', data.name)
          .property('description', data.description || '')
          .property('phase', phase)
          .property('sprint_id', id)
          .property('created_at', createdAt)
          .property('current_execution_arn', '')
          .property('current_execution_id', '')
          .property('current_agent_status', '')
          .property('issue_number', issueNumber)
          .property('issue_url', issueUrl);

        if (trackerProperties) {
          createTrav = createTrav
            .property('tracker_provider', trackerProperties.provider)
            .property('tracker_instance', trackerProperties.instance)
            .property('tracker_external_project_key', trackerProperties.externalProjectKey)
            .property('tracker_resource_type', trackerProperties.resourceType)
            .property('tracker_resource_id', trackerProperties.resourceId)
            .property('tracker_resource_url', trackerProperties.resourceUrl);
        }

        await createTrav.as('s').addE('HAS_SPRINT').from_('p').to('s').next();

        return res(201, {
          id,
          name: data.name,
          description: data.description || '',
          phase,
          createdAt,
          currentExecutionArn: null,
          currentExecutionId: null,
          currentAgentStatus: null,
          issueNumber: issueNumber || null,
          issueUrl: issueUrl || null,
          tracker: trackerProperties
            ? {
                provider: trackerProperties.provider,
                instance: trackerProperties.instance || null,
                externalProjectKey: trackerProperties.externalProjectKey || null,
                resourceType: trackerProperties.resourceType,
                resourceId: trackerProperties.resourceId || null,
                resourceUrl: trackerProperties.resourceUrl || null,
              }
            : null,
        });
      }

      case 'PUT': {
        const raw = JSON.parse(body);
        console.log('PUT request - sprintId:', sprintId);

        const existing = await g.V().has('Sprint', 'id', sprintId).valueMap().next();
        if (!existing.value) return res(404, { error: 'Sprint not found' });

        // Agent state fields are system-write-only; strip them from user requests.
        // The orchestrator and pool-worker update these via internal invocations.
        const USER_WRITABLE = ['name', 'description', 'phase'];
        const isSystemCaller = event.requestContext?.authorizer?.claims?.sub === 'system';
        const SYSTEM_FIELDS = [
          'currentExecutionArn',
          'currentExecutionId',
          'currentAgentType',
          'currentAgentStatus',
          'agentStartedAt',
          'agentCompletedAt',
          'prUrl',
          'prNumber',
          'branch',
          'baseBranch',
        ];
        const allowedKeys = isSystemCaller ? [...USER_WRITABLE, ...SYSTEM_FIELDS] : USER_WRITABLE;
        const data = Object.fromEntries(
          Object.entries(raw).filter(([k]) => allowedKeys.includes(k)),
        );

        if (data.phase) {
          if (!VALID_PHASES.includes(data.phase)) return res(400, { error: 'Invalid phase' });
        }

        const { cardinality } = gremlin.process;

        if (data.name) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'name', data.name)
            .next();
        }
        if (data.description !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'description', data.description)
            .next();
        }
        if (data.phase) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'phase', data.phase)
            .next();
        }

        // Agent state fields (system-caller only)
        if (data.currentExecutionArn !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'current_execution_arn', data.currentExecutionArn)
            .next();
        }
        if (data.currentExecutionId !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'current_execution_id', data.currentExecutionId)
            .next();
        }
        if (data.currentAgentType !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'current_agent_type', data.currentAgentType)
            .next();
        }
        if (data.currentAgentStatus !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'current_agent_status', data.currentAgentStatus)
            .next();
        }
        if (data.agentStartedAt !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'agent_started_at', data.agentStartedAt)
            .next();
        }
        if (data.agentCompletedAt !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'agent_completed_at', data.agentCompletedAt)
            .next();
        }
        if (data.prUrl !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'pr_url', data.prUrl || '')
            .next();
        }
        if (data.prNumber !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'pr_number', data.prNumber ? String(data.prNumber) : '')
            .next();
        }
        if (data.branch !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'branch', data.branch || '')
            .next();
        }
        if (data.baseBranch !== undefined) {
          await g
            .V()
            .has('Sprint', 'id', sprintId)
            .property(cardinality.single, 'base_branch', data.baseBranch || '')
            .next();
        }

        const updated = await g.V().has('Sprint', 'id', sprintId).valueMap().next();
        return res(200, mapSprint(updated.value));
      }

      case 'DELETE': {
        // Drop sprint and all contained vertices
        await g
          .V()
          .has('Sprint', 'id', sprintId)
          .union(
            gremlin.process.statics.out('CONTAINS'),
            gremlin.process.statics.out('HAS_REVIEW'),
            gremlin.process.statics.identity(),
          )
          .drop()
          .next();
        return res(204, {});
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
