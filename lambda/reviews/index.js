const gremlin = require('gremlin');
const { randomUUID } = require('crypto');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const { buildResponse } = require('./shared/response');

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const { cardinality } = gremlin.process;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION || 'us-east-1';
  const connInfo = getUrlAndHeaders(host, '8182', credentials, '/gremlin', 'wss');
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

const VALID_STATUSES = ['PENDING', 'PASSED', 'FAILED'];

const mapReview = (v) => ({
  id: v.get('id')?.[0] || '',
  status: v.get('status')?.[0] || 'PENDING',
  comments: v.get('comments')?.[0] || '',
  blindReview: v.get('blind_review')?.[0] || '',
  fullReview: v.get('full_review')?.[0] || '',
  riskScore: v.get('risk_score')?.[0] || null,
  riskReasoning: v.get('risk_reasoning')?.[0] || '',
  stale: v.get('stale')?.[0] === 'true',
  staleAt: v.get('stale_at')?.[0] || null,
  sprintId: v.get('sprint_id')?.[0] || '',
});

exports.handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    const { httpMethod, pathParameters, body } = event;
    const { sprintId } = pathParameters || {};

    switch (httpMethod) {
      case 'GET': {
        // Return the active (non-stale) review. If all are stale, return the most recent one.
        const allReviews = await g.V().has('Sprint', 'id', sprintId)
          .out('HAS_REVIEW').hasLabel('Review').valueMap().toList();
        if (allReviews.length === 0) return res(200, null);
        const activeReview = allReviews.find(v => v.get('stale')?.[0] !== 'true');
        return res(200, mapReview(activeReview || allReviews[allReviews.length - 1]));
      }

      case 'POST': {
        // Only block if a non-stale review already exists
        const existing = await g.V().has('Sprint', 'id', sprintId)
          .out('HAS_REVIEW').hasLabel('Review')
          .not(gremlin.process.statics.has('stale', 'true'))
          .count().next();
        if (existing.value > 0) return res(409, { error: 'Review already exists for this sprint' });

        const data = JSON.parse(body || '{}');
        const id = randomUUID();

        await g.V().has('Sprint', 'id', sprintId).as('s')
          .addV('Review')
          .property('id', id)
          .property('status', 'PENDING')
          .property('comments', data.comments || '')
          .property('sprint_id', sprintId)
          .as('rv')
          .addE('HAS_REVIEW').from_('s').to('rv')
          .next();

        return res(201, { id, status: 'PENDING', comments: data.comments || '', sprintId });
      }

      case 'PUT': {
        const raw = JSON.parse(body);

        const review = await g.V().has('Sprint', 'id', sprintId)
          .out('HAS_REVIEW').hasLabel('Review')
          .not(gremlin.process.statics.has('stale', 'true'))
          .next();
        if (!review.value) return res(404, { error: 'Review not found' });

        const reviewId = review.value.id;

        // status, blindReview, fullReview, riskScore, riskReasoning are system-write-only
        // (set by the review agent via MCP tools). Users may only update comments and edges.
        const isSystemCaller = event.requestContext?.authorizer?.claims?.sub === 'system';
        const SYSTEM_FIELDS = ['status', 'blindReview', 'fullReview', 'riskScore', 'riskReasoning'];
        const data = isSystemCaller
          ? raw
          : Object.fromEntries(Object.entries(raw).filter(([k]) => !SYSTEM_FIELDS.includes(k)));

        if (data.status) {
          if (!VALID_STATUSES.includes(data.status)) return res(400, { error: 'Invalid status' });
          await g.V(reviewId).property(cardinality.single, 'status', data.status).next();
        }
        if (data.comments !== undefined) await g.V(reviewId).property(cardinality.single, 'comments', data.comments).next();
        if (data.blindReview !== undefined) await g.V(reviewId).property(cardinality.single, 'blind_review', data.blindReview).next();
        if (data.fullReview !== undefined) await g.V(reviewId).property(cardinality.single, 'full_review', data.fullReview).next();
        if (data.riskScore !== undefined) await g.V(reviewId).property(cardinality.single, 'risk_score', data.riskScore).next();
        if (data.riskReasoning !== undefined) await g.V(reviewId).property(cardinality.single, 'risk_reasoning', data.riskReasoning).next();

        // Add REVIEWS edges to code files
        if (data.codeFileIds) {
          for (const cfId of data.codeFileIds) {
            await g.V(reviewId).as('rv')
              .V().has('CodeFile', 'id', cfId).as('cf')
              .addE('REVIEWS').from_('rv').to('cf')
              .next();
          }
        }
        // Add VALIDATES edges to requirements/stories
        if (data.requirementIds) {
          for (const rId of data.requirementIds) {
            await g.V(reviewId).as('rv')
              .V().has('Requirement', 'id', rId).as('r')
              .addE('VALIDATES').from_('rv').to('r')
              .next();
          }
        }
        if (data.userStoryIds) {
          for (const usId of data.userStoryIds) {
            await g.V(reviewId).as('rv')
              .V().has('UserStory', 'id', usId).as('us')
              .addE('VALIDATES').from_('rv').to('us')
              .next();
          }
        }

        const updated = await g.V(reviewId).valueMap().next();
        return res(200, mapReview(updated.value));
      }

      default:
        return res(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return res(500, { error: 'Internal server error' });
  } finally {
    if (conn) try { await conn.close(); } catch (e) {}
  }
};
