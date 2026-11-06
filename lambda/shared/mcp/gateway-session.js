// The per-session context the runtime asserts to the MCP tools Lambda, next to
// the control-plane grant. The grant fixes WHERE the session may act (space,
// intent, execution, stage lane) and WHICH release policy applies (digest); this
// header only says HOW the runtime chose to run it inside that boundary (role,
// persona flags). The Lambda rejects any session naming identifiers outside the
// grant or a policy other than the signed one, and persona flags fail closed.
// What stays runtime-asserted is the sub-role inside the granted stage
// (author/reviewer/reader, persona): a forged session can raise that within its
// own stage, never reach another stage, execution or space.
import { contextFromEnv } from './startup-context.js';
import { gatewayPolicyDigest } from '../gateway-grant.js';

export const GRANT_HEADER = 'x-aidlc-grant';
export const SESSION_HEADER = 'x-aidlc-session';
const MAX_SESSION_BYTES = 4096;

const SESSION_FIELDS = Object.freeze([
  'role',
  'stageInstanceId',
  'orchestratorRunId',
  'stageCallbackId',
  'stageAttempt',
  'validationRound',
  'model',
  'reviewerAgent',
  'agentRef',
  'checkpointOwner',
  'canAsk',
  'policy',
]);

const GRANT_FIELDS = Object.freeze([
  'projectId',
  'intentId',
  'executionId',
  'stageId',
  'unitSlug',
  'sectionIndex',
]);

// The stage leg comes from the grant, never the session: persona sessions do not
// carry it, and a session may not name a different one.
const LEG_FIELDS = Object.freeze(['stageCallbackId', 'orchestratorRunId']);

export class GatewaySessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewaySessionError';
    this.code = 'GATEWAY_SESSION_INVALID';
  }
}

export const encodeGatewaySession = (scope) => {
  const session = Object.fromEntries(
    SESSION_FIELDS.filter((key) => scope[key] !== undefined && scope[key] !== null).map((key) => [
      key,
      scope[key],
    ]),
  );
  const encoded = Buffer.from(JSON.stringify(session)).toString('base64url');
  if (Buffer.byteLength(encoded) > MAX_SESSION_BYTES) {
    throw new GatewaySessionError('Gateway session context is too large');
  }
  return encoded;
};

export const decodeGatewaySession = (encoded) => {
  if (typeof encoded !== 'string' || !encoded || Buffer.byteLength(encoded) > MAX_SESSION_BYTES) {
    throw new GatewaySessionError('Gateway session context is invalid');
  }
  let session;
  try {
    session = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new GatewaySessionError('Gateway session context is invalid');
  }
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new GatewaySessionError('Gateway session context is invalid');
  }
  if (Object.keys(session).some((key) => !SESSION_FIELDS.includes(key))) {
    throw new GatewaySessionError('Gateway session context names a field it may not set');
  }
  return session;
};

const envValue = (value) => (value === undefined || value === null ? '' : String(value));

// Rebuild the exact env contract the local MCP server validates, then run the
// SAME parser, so the remote path enforces identical role/mode/scope rules.
export const scopeFromGrantAndSession = (grant, session, { processTable }) => {
  const env = {
    V2_EXECUTION_ID: envValue(grant.executionId),
    V2_INTENT_ID: envValue(grant.intentId),
    V2_PROJECT_ID: envValue(grant.projectId),
    V2_STAGE_ID: envValue(grant.stageId),
    V2_UNIT_SLUG: envValue(grant.unitSlug),
    V2_SECTION_INDEX: envValue(grant.sectionIndex),
    V2_MCP_MODE: grant.mode,
    V2_MCP_ROLE: envValue(session.role),
    V2_STAGE_INSTANCE_ID: envValue(session.stageInstanceId),
    V2_ORCHESTRATOR_RUN_ID: envValue(grant.orchestratorRunId),
    V2_STAGE_CALLBACK_ID: envValue(grant.stageCallbackId),
    V2_STAGE_ATTEMPT: session.stageAttempt === undefined ? '0' : envValue(session.stageAttempt),
    V2_VALIDATION_ROUND: envValue(session.validationRound),
    V2_RESOLVED_MODEL: envValue(session.model),
    V2_REVIEWER_AGENT: envValue(session.reviewerAgent),
    V2_AGENT_REF: envValue(session.agentRef),
    V2_CHECKPOINT_OWNER: session.checkpointOwner === true ? '' : '0',
    V2_ASK_QUESTION: session.canAsk === true ? '' : '0',
    V2_STAGE_POLICY: session.policy ? JSON.stringify(session.policy) : '',
    V2_PROCESS_TABLE: envValue(processTable),
  };
  for (const key of LEG_FIELDS) {
    if (session[key] !== undefined && session[key] !== null && session[key] !== grant[key]) {
      throw new GatewaySessionError('Gateway session context is outside its grant');
    }
  }
  if (gatewayPolicyDigest(session.policy) !== (grant.policyDigest ?? null)) {
    throw new GatewaySessionError('Gateway session policy does not match its grant');
  }
  const context = contextFromEnv(env);
  for (const key of GRANT_FIELDS) {
    if ((context.scope[key] ?? null) !== (grant[key] ?? null)) {
      throw new GatewaySessionError('Gateway session context is outside its grant');
    }
  }
  return context;
};
