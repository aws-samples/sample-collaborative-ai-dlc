import { createHash } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authError, bindingIdentity } from '../shared/agent-auth-contracts.js';
import { commandDefinition, GRANT_SCOPES } from '../shared/agent-command-registry.js';
import { loadAgentCredentialGrantSecret } from '../shared/agent-credential-grants.js';
import {
  beginCredentialInvocation,
  readCredentialInvocation,
  heartbeatCredentialInvocation,
  finishCredentialInvocation,
} from '../shared/invocation-accounting.js';
import {
  INVOCATION_ACCOUNTING_TTL_SECONDS,
  verifyInvocationAccountingTicket,
} from '../shared/invocation-accounting-ticket.js';
import {
  engineDataEnabled,
  gatewayScopeDenied,
  verifyBrokerGatewayGrant,
} from './gateway-authority.js';

export const isInvocationAccountingAction = (action) =>
  action === 'heartbeat-invocation' || action === 'finish-invocation';
export const INVOCATION_ACCOUNTING_ERROR_CODES = new Set([
  'INVOCATION_ACCOUNTING_INVALID',
  'INVOCATION_ACCOUNTING_CONFLICT',
  'INVOCATION_ACCOUNTING_LIMIT',
  'INVOCATION_TICKET_INVALID',
  'INVOCATION_TICKET_EXPIRED',
]);
const invalid = () =>
  authError('INVOCATION_ACCOUNTING_INVALID', 'Invocation accounting request is invalid');
// The control plane signs a fresh credential grant for every runtime invocation, and the
// runtime begins once per grant (a transport retry reuses its nonce). Fresh nonces beyond
// this headroom cannot multiply ACTIVE rows; once the grant expires no begin can verify.
export const MAX_INVOCATIONS_PER_GRANT = 4;
const BUDGET_RETENTION_SECONDS = 3600;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const validRow = (row, id) =>
  row?.type === 'AgentInvocation' && row.id === id && ['ACTIVE', 'FINISHED'].includes(row.state);

export const beginBrokerInvocation = async ({
  event,
  claims,
  signTicket,
  ddb,
  tableName,
  now = Date.now,
  verifyGrant = verifyBrokerGatewayGrant,
}) => {
  const definition = commandDefinition(event.command);
  if (
    !definition ||
    definition.agentAuth !== claims.purpose ||
    typeof event.invocationNonce !== 'string' ||
    !UUID.test(event.invocationNonce) ||
    !tableName
  )
    throw invalid();
  if (definition.grantScope !== GRANT_SCOPES.NONE) {
    const grant = await verifyGrant(event.gatewayGrant);
    if (
      grant.mode !== definition.grantScope ||
      grant.projectId !== claims.projectId ||
      grant.executionId !== claims.executionId
    )
      throw gatewayScopeDenied();
  }
  if (!claims.bindings.length) return null;
  const id = createHash('sha256')
    .update(JSON.stringify([claims.grantId, event.invocationNonce.toLowerCase()]))
    .digest('hex');
  const options = { ddb, tableName, now, id };
  const existing = await readCredentialInvocation(options);
  let invocation = existing;
  let created = false;
  if (!invocation) {
    try {
      invocation = await beginCredentialInvocation({
        ...options,
        payload: {
          command: event.command,
          projectId: claims.projectId,
          executionId: claims.executionId,
        },
        bindings: claims.bindings,
        budget: {
          grantId: claims.grantId,
          limit: MAX_INVOCATIONS_PER_GRANT,
          expiresAt: claims.expiresAt + BUDGET_RETENTION_SECONDS,
        },
      });
      created = true;
    } catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
      // A competing retry may have committed the same begin, even one that took the
      // grant's last budget slot. A review CAS race without that row must fail closed,
      // before any provider material is read.
      invocation = await readCredentialInvocation(options);
      if (!invocation)
        throw authError(
          'INVOCATION_ACCOUNTING_CONFLICT',
          'Invocation accounting changed; retry from fresh state',
        );
    }
  }
  if (
    !validRow(invocation, id) ||
    invocation.state !== 'ACTIVE' ||
    invocation.projectId !== claims.projectId ||
    invocation.executionId !== claims.executionId ||
    invocation.command !== event.command ||
    JSON.stringify(invocation.credentialBindings?.map(bindingIdentity)) !==
      JSON.stringify(claims.bindings.map(bindingIdentity))
  )
    throw invalid();
  // Only the begin creator may make the first handoff. Otherwise its known
  // redemption failure could finish work a concurrent retry already received.
  if (!created && !invocation.credentialMaterialIssuedAt)
    throw authError('INVOCATION_ACCOUNTING_CONFLICT', 'Credential redemption is still pending');
  const issuedAt = Math.floor(Date.parse(invocation.startedAt) / 1000);
  return {
    accounting: {
      invocationId: id,
      ticket: signTicket({
        invocationId: id,
        issuedAt,
        expiresAt: issuedAt + INVOCATION_ACCOUNTING_TTL_SECONDS,
      }),
    },
    markIssued: async () => {
      if (!created) return;
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: invocation.pk, sk: invocation.sk },
          UpdateExpression: 'SET credentialMaterialIssuedAt = :now',
          ConditionExpression:
            '#state = :active AND attribute_not_exists(credentialMaterialIssuedAt)',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':active': 'ACTIVE', ':now': new Date(now()).toISOString() },
        }),
      );
    },
    finishUnissued: async () => {
      if (created) await finishCredentialInvocation({ ...options, invocation });
    },
  };
};

export const authorizeInvocationAccountingRequest = async (
  event,
  { ddbClient, ssmClient, secret = null, env = process.env, now = Date.now } = {},
) => {
  if (
    !engineDataEnabled(env) ||
    !env.V2_PROCESS_TABLE ||
    !event ||
    !isInvocationAccountingAction(event.action) ||
    Object.keys(event).length !== 2 ||
    !Object.hasOwn(event, 'ticket')
  )
    throw invalid();
  const key = secret ?? (await loadAgentCredentialGrantSecret(ssmClient, { env }));
  const claims = verifyInvocationAccountingTicket(event.ticket, key, { now });
  const options = { ddb: ddbClient, tableName: env.V2_PROCESS_TABLE, now, id: claims.invocationId };
  const invocation = await readCredentialInvocation(options);
  if (
    !validRow(invocation, claims.invocationId) ||
    Math.floor(Date.parse(invocation.startedAt) / 1000) !== claims.issuedAt
  )
    throw invalid();
  if (event.action === 'heartbeat-invocation') {
    if (invocation.state !== 'ACTIVE') throw invalid();
    await heartbeatCredentialInvocation({ ...options, invocation });
  } else {
    await finishCredentialInvocation({ ...options, invocation });
  }
  return { ok: true };
};
