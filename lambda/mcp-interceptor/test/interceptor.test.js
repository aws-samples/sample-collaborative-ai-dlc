import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  gatewayPolicyDigest,
  issueGatewayGrant,
  verifyGatewayGrant,
} from '../../shared/gateway-grant.js';
import { encodeGatewaySession } from '../../shared/mcp/gateway-session.js';
import { createGatewayAuthorizer } from '../../shared/mcp/gateway-authorization.js';
import {
  CONTEXT_HEADER,
  CONTEXT_POLICY_HEADER,
  decodeGatewayContext,
} from '../../shared/mcp/gateway-context.js';
import { createGatewayInterceptor } from '../interceptor.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const grantFor = (scope) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => NOW,
    randomId: () => 'grant-1',
  });

const POLICY = { summaryConfirmation: 'required', learnings: 'off' };
const stage = {
  mode: 'stage',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'requirements-analysis',
  stageCallbackId: 'cb-1',
  orchestratorRunId: 'run-1',
  policyDigest: gatewayPolicyDigest(POLICY),
};
const authorSession = {
  role: 'author',
  stageInstanceId: 'si-1',
  stageAttempt: 0,
  checkpointOwner: true,
  canAsk: true,
  agentRef: 'agent-1',
  policy: POLICY,
};

const setup = ({ stageState = 'RUNNING', authorize } = {}) => {
  const store = {
    getExecution: vi.fn(async () => ({
      executionId: 'e-1',
      projectId: 'p-1',
      intentId: 'i-1',
      status: 'RUNNING',
      orchestratorRunId: 'run-1',
    })),
    getStage: vi.fn(async () => ({
      executionId: 'e-1',
      stageInstanceId: 'si-1',
      stageId: 'requirements-analysis',
      unitSlug: null,
      sectionIndex: null,
      state: stageState,
      stageCallbackId: 'cb-1',
      orchestratorRunId: 'run-1',
    })),
  };
  const chain = { has: () => chain, hasNext: async () => true };
  const authorizer = createGatewayAuthorizer({
    verifyGrant: (token) =>
      verifyGatewayGrant(token, {
        publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
        now: () => NOW + 1000,
      }),
    createStore: () => store,
    openGraph: async () => ({ V: () => chain }),
    closeGraphSource: async () => {},
    processTable: 'proc',
  });
  const spied = { authorize: vi.fn(authorize ?? authorizer.authorize) };
  const audit = vi.fn();
  return {
    handler: createGatewayInterceptor({ authorizer: spied, audit }),
    authorize: spied.authorize,
    audit,
    store,
  };
};

const trustedHeaders = async (session = authorSession) => ({
  'X-Aidlc-Grant': await grantFor(stage),
  'x-aidlc-session': encodeGatewaySession(session),
});

const requestEvent = (body, headers) => ({
  interceptorInputVersion: '1.0',
  mcp: {
    rawGatewayRequest: { body: JSON.stringify(body) },
    gatewayRequest: { path: '/mcp', httpMethod: 'POST', headers, body },
  },
});
const responseEvent = (body, headers, gatewayResponse) => ({
  ...requestEvent(body, headers),
  mcp: { ...requestEvent(body, headers).mcp, gatewayResponse },
});
const callBody = (name, id = 7) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: { id: 'a-1' } },
});

const expectDenied = (output, id, reason) => {
  expect(output).toEqual({
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayResponse: {
        statusCode: 200,
        body: { jsonrpc: '2.0', id, error: { code: -32001, message: reason } },
      },
    },
  });
};

describe('MCP gateway interceptor — REQUEST', () => {
  it('forwards an allowed call with its original body and only the trusted context', async () => {
    const { handler, audit } = setup();
    const body = callBody('aidlc___get_artifact');
    const headers = {
      ...(await trustedHeaders()),
      Authorization: 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/...',
      'X-Amz-Security-Token': 'token',
      'x-amz-date': '20261016T120000Z',
      [CONTEXT_HEADER]: 'forged',
      [CONTEXT_POLICY_HEADER]: 'forged',
    };
    const output = await handler(requestEvent(body, headers), { awsRequestId: 'req-1' });

    expect(output.interceptorOutputVersion).toBe('1.0');
    expect(output.mcp.transformedGatewayResponse).toBeUndefined();
    const forwarded = output.mcp.transformedGatewayRequest;
    expect(forwarded.body).toBe(body);
    expect(Object.keys(forwarded.headers).toSorted()).toEqual(
      [CONTEXT_HEADER, CONTEXT_POLICY_HEADER].toSorted(),
    );
    expect(forwarded.headers[CONTEXT_HEADER]).not.toBe('forged');

    const context = decodeGatewayContext(forwarded.headers, {
      processTable: 'proc',
      now: () => NOW + 1000,
    });
    expect(context.scope).toMatchObject({
      projectId: 'p-1',
      executionId: 'e-1',
      stageInstanceId: 'si-1',
      stageCallbackId: 'cb-1',
      orchestratorRunId: 'run-1',
      agentRef: 'agent-1',
      policy: POLICY,
    });
    expect(context.role).toBe('author');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'allow',
        phase: 'REQUEST',
        method: 'tools/call',
        tool: 'aidlc___get_artifact',
        grantId: 'grant-1',
        requestId: 'req-1',
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/AWS4-HMAC|eyJ/);
  });

  it.each(['initialize', 'ping', 'tools/list', 'notifications/initialized'])(
    'authorizes %s against the grant and live scope before forwarding it',
    async (method) => {
      const { handler, store } = setup();
      const body = { jsonrpc: '2.0', id: 1, method };
      const output = await handler(requestEvent(body, await trustedHeaders()));
      expect(output.mcp.transformedGatewayRequest.body).toBe(body);
      expect(Object.keys(output.mcp.transformedGatewayRequest.headers)).toHaveLength(2);
      expect(store.getStage).toHaveBeenCalled();
    },
  );

  it.each(['initialize', 'tools/list', 'ping'])('denies %s without a grant', async (method) => {
    const { handler } = setup();
    const output = await handler(
      requestEvent({ jsonrpc: '2.0', id: 'x', method }, { 'x-aidlc-session': 's' }),
    );
    expectDenied(output, 'x', 'missing_grant');
  });

  it.each([
    ['an unknown target', async () => callBody('other___get_artifact'), 'unknown_target'],
    [
      'a tool outside the role',
      async () => callBody('aidlc___create_artifact'),
      'tool_not_allowed_for_role',
      { ...authorSession, role: 'reader' },
    ],
    ['an unknown tool', async () => callBody('aidlc___drop_tables'), 'tool_not_allowed_for_role'],
    [
      'a call without a tool name',
      async () => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} }),
      'missing_tool_name',
    ],
    [
      'an unknown method',
      async () => ({ jsonrpc: '2.0', id: 7, method: 'resources/list' }),
      'method_not_allowed',
    ],
    ['a batch request', async () => [callBody('aidlc___get_artifact')], 'invalid_request'],
    ['a body without a method', async () => ({ jsonrpc: '2.0', id: 7 }), 'invalid_request'],
  ])('denies %s without invoking the target', async (_label, build, reason, session) => {
    const { handler } = setup();
    const body = await build();
    const output = await handler(requestEvent(body, await trustedHeaders(session)));
    expectDenied(output, Array.isArray(body) ? null : 7, reason);
  });

  it('treats a REQUEST event with gatewayResponse: null as the request phase', async () => {
    const { handler } = setup();
    const body = callBody('aidlc___get_artifact');
    const event = requestEvent(body, await trustedHeaders());
    const output = await handler({ ...event, mcp: { ...event.mcp, gatewayResponse: null } });
    expect(output.mcp.transformedGatewayResponse).toBeUndefined();
    expect(output.mcp.transformedGatewayRequest.body).toBe(body);
  });

  it('denies a REQUEST event with gatewayResponse: null and no grant', async () => {
    const { handler } = setup();
    const event = requestEvent(callBody('aidlc___get_artifact'), {});
    const output = await handler({ ...event, mcp: { ...event.mcp, gatewayResponse: null } });
    expectDenied(output, 7, 'missing_grant');
  });

  it('denies a call for a stage that is no longer active', async () => {
    const { handler } = setup({ stageState: 'SUCCEEDED' });
    const output = await handler(
      requestEvent(callBody('aidlc___get_artifact'), await trustedHeaders()),
    );
    expectDenied(output, 7, 'scope_not_active');
  });

  it('denies an unsupported interceptor contract version', async () => {
    const { handler, authorize } = setup();
    const event = requestEvent(callBody('aidlc___get_artifact'), await trustedHeaders());
    const output = await handler({ ...event, interceptorInputVersion: '2.0' });
    expectDenied(output, 7, 'unsupported_interceptor_version');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('denies without passing through when authorization itself fails', async () => {
    const { handler, audit } = setup({
      authorize: async () => {
        throw new TypeError('boom');
      },
    });
    const output = await handler(
      requestEvent(callBody('aidlc___get_artifact'), await trustedHeaders()),
    );
    expectDenied(output, 7, 'authorization_error');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'deny',
        reason: 'authorization_error',
        error: 'TypeError',
      }),
    );
  });

  it('denies when the request carries no headers at all', async () => {
    const { handler } = setup();
    const event = requestEvent(callBody('aidlc___get_artifact'), undefined);
    delete event.mcp.gatewayRequest.headers;
    expectDenied(await handler(event), 7, 'missing_grant');
  });
});

describe('MCP gateway interceptor — RESPONSE', () => {
  const listed = (names, extra = {}) => ({
    statusCode: 200,
    body: {
      jsonrpc: '2.0',
      id: 3,
      result: { tools: names.map((name) => ({ name, inputSchema: {} })), ...extra },
    },
  });

  it('filters tools/list with the tools/call predicate and keeps pagination', async () => {
    const { handler, authorize } = setup();
    const output = await handler(
      responseEvent(
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        await trustedHeaders({ ...authorSession, role: 'reviewer' }),
        listed(
          ['aidlc___get_artifact', 'aidlc___create_artifact', 'other___get_artifact', 'bare'],
          { nextCursor: 'c-2' },
        ),
      ),
    );
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(output.mcp.transformedGatewayResponse).toEqual({
      statusCode: 200,
      body: {
        jsonrpc: '2.0',
        id: 3,
        result: { tools: [{ name: 'aidlc___get_artifact', inputSchema: {} }], nextCursor: 'c-2' },
      },
    });
  });

  it('denies a tools/list response when the session no longer authorizes', async () => {
    const { handler } = setup({ stageState: 'SUCCEEDED' });
    const output = await handler(
      responseEvent(
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        await trustedHeaders(),
        listed(['aidlc___get_artifact']),
      ),
    );
    expectDenied(output, 3, 'scope_not_active');
  });

  it('passes a REQUEST-time denial through unchanged', async () => {
    const { handler, authorize } = setup();
    const denialResponse = {
      statusCode: 200,
      body: { jsonrpc: '2.0', id: 3, error: { code: -32001, message: 'missing_grant' } },
    };
    const output = await handler(
      responseEvent({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, {}, denialResponse),
    );
    expect(output.mcp.transformedGatewayResponse).toEqual(denialResponse);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('passes an ordinary tools/call result through unchanged', async () => {
    const { handler, authorize } = setup();
    const result = {
      statusCode: 200,
      body: { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: '{}' }] } },
    };
    const output = await handler(
      responseEvent(callBody('aidlc___get_artifact'), await trustedHeaders(), result),
    );
    expect(output.mcp.transformedGatewayResponse).toEqual(result);
    expect(authorize).not.toHaveBeenCalled();
  });
});
