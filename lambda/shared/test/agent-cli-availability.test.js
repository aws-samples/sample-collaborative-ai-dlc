import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  defaultAgentCli,
  normalizeDisabledClis,
  parseDisabledClis,
  readDisabledClis,
} from '../agent-cli-availability.js';
import { resolveSelectedAgentCredential } from '../agent-credential-service.js';

const ssmMock = mockClient(SSMClient);
const ssm = new SSMClient({});

beforeEach(() => ssmMock.reset());

describe('normalizeDisabledClis', () => {
  it('accepts known CLIs, de-duplicates, and orders canonically', () => {
    expect(normalizeDisabledClis(['codex', 'claude', 'codex'])).toEqual({
      valid: true,
      issues: [],
      value: ['claude', 'codex'],
    });
    expect(normalizeDisabledClis('["opencode"]').value).toEqual(['opencode']);
    expect(normalizeDisabledClis([]).valid).toBe(true);
  });

  it('rejects unknown CLIs, non-arrays, and disabling every CLI', () => {
    expect(normalizeDisabledClis(['gemini']).valid).toBe(false);
    expect(normalizeDisabledClis({ codex: true }).valid).toBe(false);
    expect(normalizeDisabledClis('not json').valid).toBe(false);
    const all = normalizeDisabledClis(['kiro', 'claude', 'opencode', 'codex']);
    expect(all.valid).toBe(false);
    expect(all.issues).toEqual(['At least one agent CLI must stay enabled']);
  });
});

describe('defaultAgentCli', () => {
  it('prefers Kiro, else the first enabled CLI', () => {
    expect(defaultAgentCli([])).toBe('kiro');
    expect(defaultAgentCli(['kiro'])).toBe('claude');
    expect(defaultAgentCli(['kiro', 'claude'])).toBe('opencode');
  });
});

describe('parseDisabledClis', () => {
  it('drops unknown ids and treats malformed input as nothing disabled', () => {
    expect(parseDisabledClis('["codex","gemini"]')).toEqual(['codex']);
    expect(parseDisabledClis('{oops')).toEqual([]);
    expect(parseDisabledClis(undefined)).toEqual([]);
  });
});

describe('readDisabledClis', () => {
  it('reads the prefixed parameter', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: '/app/dev/disabled-clis' })
      .resolves({ Parameter: { Value: '["codex"]' } });
    await expect(readDisabledClis(ssm, '/app/dev')).resolves.toEqual(['codex']);
  });

  it('treats a missing prefix or parameter as nothing disabled', async () => {
    await expect(readDisabledClis(ssm, '')).resolves.toEqual([]);
    ssmMock
      .on(GetParameterCommand)
      .rejects(Object.assign(new Error('nf'), { name: 'ParameterNotFound' }));
    await expect(readDisabledClis(ssm, '/app/dev')).resolves.toEqual([]);
  });

  it('propagates other read failures instead of re-enabling a CLI', async () => {
    ssmMock
      .on(GetParameterCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(readDisabledClis(ssm, '/app/dev')).rejects.toThrow('denied');
  });
});

describe('resolveSelectedAgentCredential disabled-CLI gate', () => {
  it('rejects a disabled CLI before resolving any credential', async () => {
    const resolveBindings = vi.fn();
    const result = await resolveSelectedAgentCredential(
      { agentCli: 'codex' },
      { resolveBindings, loadDisabledClis: async () => ['codex'] },
    );
    expect(result.error).toEqual({
      statusCode: 400,
      body: {
        error: 'The codex agent CLI is disabled by the platform administrator',
        code: 'agent_cli_disabled',
      },
    });
    expect(resolveBindings).not.toHaveBeenCalled();
  });

  it('reads the disabled set from SSM with the supplied client', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: '/app/dev/disabled-clis' })
      .resolves({ Parameter: { Value: '["claude"]' } });
    const resolveBindings = vi.fn();
    const result = await resolveSelectedAgentCredential(
      { agentCli: 'claude' },
      { resolveBindings, ssm, settingsPrefix: '/app/dev' },
    );
    expect(result.error.body.code).toBe('agent_cli_disabled');
    expect(resolveBindings).not.toHaveBeenCalled();
  });

  it('lets an enabled CLI continue to credential resolution', async () => {
    const resolveBindings = vi.fn(async () => ({}));
    const result = await resolveSelectedAgentCredential(
      { agentCli: 'kiro' },
      { resolveBindings, loadDisabledClis: async () => ['codex'] },
    );
    expect(resolveBindings).toHaveBeenCalledOnce();
    expect(result.error.body.code).toBe('agent_credential_required');
  });

  it('refuses to run unguarded when a settings prefix is configured without an SSM client', async () => {
    await expect(
      resolveSelectedAgentCredential(
        { agentCli: 'kiro' },
        { resolveBindings: vi.fn(), settingsPrefix: '/app/dev' },
      ),
    ).rejects.toThrow('requires an SSM client');
  });
});
