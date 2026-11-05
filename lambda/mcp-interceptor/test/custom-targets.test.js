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
  CUSTOMER_CALLER_HEADER,
  NO_CUSTOMER_CALLER,
  parseCustomTargets,
} from '../../shared/mcp/gateway-custom-targets.js';
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

const REGISTRY = JSON.stringify({
  confluence: { projectIds: ['p-1'], stageIds: ['requirements-analysis'], tools: ['search'] },
  jira: { projectIds: ['p-1', 'p-2'], stageIds: null, tools: null },
  other: { projectIds: ['p-2'], stageIds: null, tools: null },
});

const setup = ({ stageState = 'RUNNING', registry = REGISTRY, customTargets } = {}) => {
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
  const audit = vi.fn();
  const handler = createGatewayInterceptor({
    authorizer: createGatewayAuthorizer({
      verifyGrant: (token) =>
        verifyGatewayGrant(token, {
          publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
          now: () => NOW + 1000,
        }),
      createStore: () => store,
      openGraph: async () => ({ V: () => chain }),
      closeGraphSource: async () => {},
      processTable: 'proc',
      customTargets: customTargets ?? (() => parseCustomTargets(registry)),
    }),
    audit,
  });
  return { handler, audit, store };
};

const headersFor = async (scope = stage, session = authorSession) => ({
  'x-aidlc-grant': await grantFor(scope),
  'x-aidlc-session': encodeGatewaySession(session),
});

const requestEvent = (body, headers) => ({
  interceptorInputVersion: '1.0',
  mcp: { gatewayRequest: { path: '/mcp', httpMethod: 'POST', headers, body } },
});
const responseEvent = (body, headers, gatewayResponse) => ({
  interceptorInputVersion: '1.0',
  mcp: { gatewayRequest: { headers, body }, gatewayResponse },
});
const callBody = (name, id = 7) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: { query: 'design' } },
});
const denialOf = (output) => output.mcp.transformedGatewayResponse?.body?.error?.message;
const decodeCaller = (value) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

describe('MCP gateway interceptor — customer MCP targets', () => {
  it('forwards an allowed call with only the grant-derived caller header', async () => {
    const { handler, audit } = setup();
    const body = callBody('confluence___search');
    const headers = {
      ...(await headersFor()),
      Authorization: 'Bearer forged',
      'X-Amz-Security-Token': 'token',
      [CUSTOMER_CALLER_HEADER]: 'forged',
      'x-aidlc-context': 'forged',
    };
    const output = await handler(requestEvent(body, headers), { awsRequestId: 'req-1' });

    const forwarded = output.mcp.transformedGatewayRequest;
    expect(forwarded.body).toBe(body);
    expect(Object.keys(forwarded.headers)).toEqual([CUSTOMER_CALLER_HEADER]);
    expect(Object.keys(forwarded.headers).map((h) => h.toLowerCase())).not.toContain(
      'authorization',
    );
    expect(decodeCaller(forwarded.headers[CUSTOMER_CALLER_HEADER])).toEqual({
      v: 1,
      projectId: 'p-1',
      intentId: 'i-1',
      executionId: 'e-1',
      stageId: 'requirements-analysis',
      unitSlug: null,
      sectionIndex: null,
      grantId: 'grant-1',
      expiresAt: expect.any(Number),
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'allow', target: 'confluence', grantId: 'grant-1' }),
    );
  });

  it('exports no runtime-asserted field: persona, role, agentRef and policy stay out', async () => {
    const { handler } = setup();
    const output = await handler(
      requestEvent(
        callBody('jira___create_issue'),
        await headersFor(stage, { ...authorSession, role: 'reviewer', reviewerAgent: 'x' }),
      ),
    );
    const caller = decodeCaller(
      output.mcp.transformedGatewayRequest.headers[CUSTOMER_CALLER_HEADER],
    );
    expect(Object.keys(caller).toSorted()).toEqual(
      [
        'v',
        'projectId',
        'intentId',
        'executionId',
        'stageId',
        'unitSlug',
        'sectionIndex',
        'grantId',
        'expiresAt',
      ].toSorted(),
    );
  });

  it('carries the lane of a unit grant', async () => {
    const { handler, store } = setup();
    store.getStage.mockResolvedValue({
      executionId: 'e-1',
      stageInstanceId: 'si-1',
      stageId: 'requirements-analysis',
      unitSlug: 'api',
      sectionIndex: 0,
      state: 'RUNNING',
      stageCallbackId: 'cb-1',
      orchestratorRunId: 'run-1',
    });
    const output = await handler(
      requestEvent(
        callBody('jira___get_issue'),
        await headersFor({ ...stage, unitSlug: 'api', sectionIndex: 0 }),
      ),
    );
    expect(
      decodeCaller(output.mcp.transformedGatewayRequest.headers[CUSTOMER_CALLER_HEADER]),
    ).toMatchObject({ unitSlug: 'api', sectionIndex: 0 });
  });

  it.each([
    ['an unknown target', 'wiki___search', stage, authorSession, 'unknown_target'],
    [
      'a target of another space',
      'other___search',
      stage,
      authorSession,
      'tool_not_allowed_for_target',
    ],
    [
      'a stage the rule does not list',
      'confluence___search',
      { ...stage, stageId: 'code-generation' },
      authorSession,
      'tool_not_allowed_for_target',
    ],
    [
      'a tool the rule does not list',
      'confluence___delete_page',
      stage,
      authorSession,
      'tool_not_allowed_for_target',
    ],
    [
      'a nested separator in the tool',
      'jira___a___b',
      stage,
      authorSession,
      'tool_not_allowed_for_target',
    ],
    [
      'a persona claiming another identity',
      'confluence___delete_page',
      stage,
      { ...authorSession, role: 'reader', agentRef: 'platform-admin', reviewerAgent: 'admin' },
      'tool_not_allowed_for_target',
    ],
  ])('denies %s', async (_label, tool, scope, session, reason) => {
    const { handler } = setup();
    const output = await handler(requestEvent(callBody(tool), await headersFor(scope, session)));
    expect(output.mcp.transformedGatewayRequest).toBeUndefined();
    expect(denialOf(output)).toBe(reason);
  });

  it.each([
    [
      'a discussion grant',
      { mode: 'discussion', projectId: 'p-1', intentId: 'i-1', executionId: 'i-1' },
      { role: 'reader' },
      'mode_not_allowed_for_target',
    ],
    [
      'a conflict grant',
      {
        mode: 'conflict',
        projectId: 'p-1',
        intentId: 'i-1',
        executionId: 'e-1',
        unitSlug: 'api',
        sectionIndex: 1,
      },
      { role: 'reviewer' },
      'mode_not_allowed_for_target',
    ],
    [
      'an execution grant',
      { mode: 'execution', projectId: 'p-1', intentId: 'i-1', executionId: 'e-1' },
      authorSession,
      'mode_not_allowed',
    ],
  ])('denies %s even for a tool the rule allows', async (_label, scope, session, reason) => {
    const { handler } = setup();
    const output = await handler(
      requestEvent(callBody('jira___get_issue'), await headersFor(scope, session)),
    );
    expect(denialOf(output)).toBe(reason);
  });

  it('denies a customer call once the stage is no longer active', async () => {
    const { handler } = setup({ stageState: 'SUCCEEDED' });
    const output = await handler(requestEvent(callBody('jira___get_issue'), await headersFor()));
    expect(denialOf(output)).toBe('scope_not_active');
  });

  it('denies a forged caller header without a grant', async () => {
    const { handler } = setup();
    const output = await handler(
      requestEvent(callBody('jira___get_issue'), {
        [CUSTOMER_CALLER_HEADER]: Buffer.from(JSON.stringify({ v: 1, projectId: 'p-1' })).toString(
          'base64url',
        ),
      }),
    );
    expect(denialOf(output)).toBe('missing_grant');
  });

  it('denies every request when the registry is malformed', async () => {
    const { handler, audit } = setup({ registry: '{"aidlc":{}}' });
    for (const body of [callBody('aidlc___get_artifact'), callBody('jira___get_issue')]) {
      expect(denialOf(await handler(requestEvent(body, await headersFor())))).toBe(
        'authorization_error',
      );
    }
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', error: 'GatewayCustomTargetsError' }),
    );
  });

  it('keeps the built-in context for aidlc calls when customer targets exist', async () => {
    const { handler } = setup();
    const output = await handler(
      requestEvent(callBody('aidlc___get_artifact'), await headersFor()),
    );
    expect(Object.keys(output.mcp.transformedGatewayRequest.headers).toSorted()).toEqual([
      CUSTOMER_CALLER_HEADER,
      'x-aidlc-context',
      'x-aidlc-context-policy',
    ]);
  });

  // Whatever method the Gateway forwards to a customer target, the caller
  // header it carries is one the interceptor set.
  const SESSION_BODIES = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    callBody('aidlc___get_artifact'),
  ];
  const FORGED = Buffer.from(
    JSON.stringify({ v: 1, projectId: 'p-2', intentId: 'i-x', executionId: 'e-x' }),
  ).toString('base64url');

  it('overwrites the caller header with the fixed no-caller value on every other method', async () => {
    const { handler } = setup();
    expect(decodeCaller(NO_CUSTOMER_CALLER)).toEqual({ v: 1, none: true });
    const forged = {
      ...(await headersFor()),
      [CUSTOMER_CALLER_HEADER]: FORGED,
      'X-Aidlc-Caller': FORGED,
    };
    for (const body of SESSION_BODIES) {
      const { headers } = (await handler(requestEvent(body, forged))).mcp.transformedGatewayRequest;
      expect(headers[CUSTOMER_CALLER_HEADER], body.method).toBe(NO_CUSTOMER_CALLER);
      expect(
        Object.keys(headers).filter((h) => h.toLowerCase() === CUSTOMER_CALLER_HEADER),
      ).toEqual([CUSTOMER_CALLER_HEADER]);
      expect(JSON.stringify(headers)).not.toContain(FORGED);
    }
  });

  it('sets the no-caller value for discussion sessions too', async () => {
    const { handler } = setup();
    const output = await handler(
      requestEvent(
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        await headersFor(
          { mode: 'discussion', projectId: 'p-1', intentId: 'i-1', executionId: 'i-1' },
          { role: 'reader' },
        ),
      ),
    );
    expect(output.mcp.transformedGatewayRequest.headers[CUSTOMER_CALLER_HEADER]).toBe(
      NO_CUSTOMER_CALLER,
    );
  });

  it('adds no caller header without customer targets', async () => {
    const { handler } = setup({ registry: '' });
    for (const body of SESSION_BODIES) {
      const { headers } = (await handler(requestEvent(body, await headersFor()))).mcp
        .transformedGatewayRequest;
      expect(Object.keys(headers).toSorted(), body.method).toEqual([
        'x-aidlc-context',
        'x-aidlc-context-policy',
      ]);
    }
  });
});

describe('MCP gateway interceptor — customer tools/list', () => {
  const listed = (names, extra = {}) => ({
    statusCode: 200,
    body: {
      jsonrpc: '2.0',
      id: 3,
      result: { tools: names.map((name) => ({ name, inputSchema: {} })), ...extra },
    },
  });
  const ALL = [
    'aidlc___get_artifact',
    'confluence___search',
    'confluence___delete_page',
    'jira___get_issue',
    'other___search',
    'wiki___search',
  ];

  it('lists exactly the customer tools tools/call would allow, keeping each page cursor', async () => {
    const { handler } = setup();
    const headers = await headersFor();
    const page = async (names, extra) =>
      (
        await handler(
          responseEvent(
            { jsonrpc: '2.0', id: 3, method: 'tools/list' },
            headers,
            listed(names, extra),
          ),
        )
      ).mcp.transformedGatewayResponse;

    const first = await page(ALL.slice(0, 3), { nextCursor: 'c-2' });
    const last = await page(ALL.slice(3));
    expect(first.body.result).toEqual({
      tools: [
        { name: 'aidlc___get_artifact', inputSchema: {} },
        { name: 'confluence___search', inputSchema: {} },
      ],
      nextCursor: 'c-2',
    });
    expect(last.body.result).toEqual({ tools: [{ name: 'jira___get_issue', inputSchema: {} }] });

    for (const name of ALL) {
      const output = await handler(requestEvent(callBody(name), headers));
      const allowed = output.mcp.transformedGatewayRequest !== undefined;
      expect(allowed).toBe(
        [...first.body.result.tools, ...last.body.result.tools].some((t) => t.name === name),
      );
    }
  });

  it('hides every customer tool from a discussion session', async () => {
    const { handler } = setup();
    const output = await handler(
      responseEvent(
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        await headersFor(
          { mode: 'discussion', projectId: 'p-1', intentId: 'i-1', executionId: 'i-1' },
          { role: 'reader' },
        ),
        listed(ALL),
      ),
    );
    expect(output.mcp.transformedGatewayResponse.body.result.tools.map((t) => t.name)).toEqual([
      'aidlc___get_artifact',
    ]);
  });
});
