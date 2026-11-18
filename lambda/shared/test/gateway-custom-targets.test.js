import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_CALLER_HEADER,
  GatewayCustomTargetsError,
  MAX_CUSTOM_TARGETS_BYTES,
  customToolAllowed,
  customTargetsFromEnv,
  encodeCustomerCaller,
  parseCustomTargets,
} from '../mcp/gateway-custom-targets.js';

const rule = (overrides = {}) => ({
  projectIds: ['p-1'],
  stageIds: null,
  tools: null,
  ...overrides,
});
const grant = {
  mode: 'stage',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'requirements-analysis',
  unitSlug: null,
  sectionIndex: 0,
  grantId: 'g-1',
  expiresAt: 1_800_000_000,
  policyDigest: 'digest',
  stageCallbackId: 'cb-1',
};

describe('customer MCP target registry', () => {
  it('treats an unset or empty registry as no customer targets', () => {
    expect(customTargetsFromEnv({}).size).toBe(0);
    expect(parseCustomTargets('').size).toBe(0);
    expect(parseCustomTargets('{}').size).toBe(0);
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['the reserved built-in target', JSON.stringify({ aidlc: rule() })],
    ['a name with the tool separator', JSON.stringify({ a___b: rule() })],
    ['an uppercase name', JSON.stringify({ Confluence: rule() })],
    ['a missing project list', JSON.stringify({ c: { stageIds: null, tools: null } })],
    ['an empty project list', JSON.stringify({ c: rule({ projectIds: [] }) })],
    ['a null project list', JSON.stringify({ c: rule({ projectIds: null }) })],
    ['an empty stage list', JSON.stringify({ c: rule({ stageIds: [] }) })],
    ['a non-string tool', JSON.stringify({ c: rule({ tools: [1] }) })],
    ['an extra field', JSON.stringify({ c: { ...rule(), endpoint: 'https://x' } })],
    [
      'an oversized registry',
      JSON.stringify({ c: rule({ tools: ['t'.repeat(MAX_CUSTOM_TARGETS_BYTES)] }) }),
    ],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseCustomTargets(raw)).toThrow(GatewayCustomTargetsError);
  });

  it('matches project, stage and tool exactly; null lists mean all', () => {
    const targets = parseCustomTargets(
      JSON.stringify({
        confluence: rule({ stageIds: ['requirements-analysis'], tools: ['search'] }),
        jira: rule(),
      }),
    );
    expect(customToolAllowed(targets, grant, 'confluence', 'search')).toBe(true);
    expect(customToolAllowed(targets, grant, 'confluence', 'Search')).toBe(false);
    expect(customToolAllowed(targets, grant, 'jira', 'anything')).toBe(true);
    expect(customToolAllowed(targets, { ...grant, projectId: 'p-10' }, 'jira', 'x')).toBe(false);
    expect(customToolAllowed(targets, { ...grant, projectId: 'p' }, 'jira', 'x')).toBe(false);
    expect(
      customToolAllowed(targets, { ...grant, stageId: 'code-generation' }, 'confluence', 'search'),
    ).toBe(false);
    expect(customToolAllowed(targets, grant, 'wiki', 'search')).toBe(false);
    expect(customToolAllowed(targets, grant, 'jira', '')).toBe(false);
    expect(customToolAllowed(targets, grant, 'jira', null)).toBe(false);
    for (const mode of ['discussion', 'conflict', 'execution']) {
      expect(customToolAllowed(targets, { ...grant, mode }, 'jira', 'x')).toBe(false);
    }
  });

  it('encodes only grant-derived fields in the caller envelope', () => {
    const headers = encodeCustomerCaller({ ...grant, role: 'admin', agentRef: 'x' });
    expect(Object.keys(headers)).toEqual([CUSTOMER_CALLER_HEADER]);
    expect(JSON.parse(Buffer.from(headers[CUSTOMER_CALLER_HEADER], 'base64url'))).toEqual({
      v: 1,
      projectId: 'p-1',
      intentId: 'i-1',
      executionId: 'e-1',
      stageId: 'requirements-analysis',
      unitSlug: null,
      sectionIndex: 0,
      grantId: 'g-1',
      expiresAt: 1_800_000_000,
    });
  });
});
