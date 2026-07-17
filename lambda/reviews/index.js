import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { buildResponse } from '../shared/response.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const { order: Order } = gremlin.process;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION || 'us-east-1';
  const connInfo = getUrlAndHeaders(host, '8182', credentials, '/gremlin', 'wss');
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

// NOTE (known design constraint, kept for historical data): the review verdict
// is sprint-wide — exactly one active Review per Sprint — so a single `status`
// aggregates quality across ALL repos in a multi-repo sprint. The human-readable
// per-repo breakdown lives in `full_review`.

const mapReview = (v) => ({
  id: v.get('id')?.[0] || '',
  status: v.get('status')?.[0] || 'PENDING',
  comments: v.get('comments')?.[0] || '',
  blindReview: v.get('blind_review')?.[0] || null,
  blindStatus: v.get('blind_status')?.[0] || 'PENDING',
  blindRiskScore: v.get('blind_risk_score')?.[0] || v.get('risk_score')?.[0] || null,
  blindRiskReasoning: v.get('blind_risk_reasoning')?.[0] || v.get('risk_reasoning')?.[0] || '',
  fullReview: v.get('full_review')?.[0] || null,
  fullStatus: v.get('full_status')?.[0] || 'PENDING',
  fullRiskScore: v.get('full_risk_score')?.[0] || v.get('risk_score')?.[0] || null,
  fullRiskReasoning: v.get('full_risk_reasoning')?.[0] || v.get('risk_reasoning')?.[0] || '',
  stale: v.get('stale')?.[0] === 'true',
  staleAt: v.get('stale_at')?.[0] || null,
  sprintId: v.get('sprint_id')?.[0] || '',
});

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    const { httpMethod, pathParameters } = event;
    const { sprintId } = pathParameters || {};

    // v1 projects are read-only: review writes were removed together with the
    // v1 execution engine, so only the GET route remains.
    switch (httpMethod) {
      case 'GET': {
        // Return the active (non-stale) review. If all are stale, return the most
        // recent one. valueMap().toList() order is NOT guaranteed by the graph
        // engine, so order by stale_at desc. The active review has no stale_at, so
        // coalesce to '' keeps it in the list (order().by(missingKey) would
        // otherwise drop it); it is selected by the .find() below regardless.
        const allReviews = await g
          .V()
          .has('Sprint', 'id', sprintId)
          .out('HAS_REVIEW')
          .hasLabel('Review')
          .order()
          .by(
            gremlin.process.statics.coalesce(
              gremlin.process.statics.values('stale_at'),
              gremlin.process.statics.constant(''),
            ),
            Order.desc,
          )
          .valueMap()
          .toList();
        if (allReviews.length === 0) return res(200, null);
        const activeReview = allReviews.find((v) => v.get('stale')?.[0] !== 'true');
        // All stale: return the most recent. With Order.desc on stale_at the newest
        // is at index 0 (allReviews[length-1] would be the oldest).
        return res(200, mapReview(activeReview || allReviews[0]));
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
