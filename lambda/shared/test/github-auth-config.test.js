import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

const ssmMock = mockClient(SSMClient);
const ssm = new SSMClient({});

const MODE_PARAM = '/proj/dev/github-auth-mode';
const CONFIG_PARAM = '/proj/dev/github-app-config';

// Fresh module per test — the module caches reads for 60s.
const loadModule = async () => {
  vi.resetModules();
  return import('../github-auth-config.js');
};

beforeEach(() => {
  ssmMock.reset();
  vi.stubEnv('GITHUB_AUTH_MODE_PARAM', MODE_PARAM);
  vi.stubEnv('GITHUB_APP_CONFIG_PARAM', CONFIG_PARAM);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getGitHubAuthMode', () => {
  it("returns 'oauth' when the env var is unset (no SSM call)", async () => {
    vi.stubEnv('GITHUB_AUTH_MODE_PARAM', '');
    const { getGitHubAuthMode } = await loadModule();
    expect(await getGitHubAuthMode(ssm)).toBe('oauth');
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
  });

  it("returns the stored mode ('app')", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'app' } });
    const { getGitHubAuthMode } = await loadModule();
    expect(await getGitHubAuthMode(ssm)).toBe('app');
  });

  it("normalizes junk values to 'oauth' (fail toward the long-standing default)", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'banana' } });
    const { getGitHubAuthMode } = await loadModule();
    expect(await getGitHubAuthMode(ssm)).toBe('oauth');
  });

  it("returns 'oauth' when the SSM read fails", async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error('boom'));
    const { getGitHubAuthMode } = await loadModule();
    expect(await getGitHubAuthMode(ssm)).toBe('oauth');
  });

  it('caches the read (one SSM call for two reads)', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'app' } });
    const { getGitHubAuthMode } = await loadModule();
    await getGitHubAuthMode(ssm);
    await getGitHubAuthMode(ssm);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });
});

describe('getGitHubAppConfig', () => {
  it('parses stored appId/installationId', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: CONFIG_PARAM })
      .resolves({ Parameter: { Value: JSON.stringify({ appId: 123, installationId: '456' }) } });
    const { getGitHubAppConfig } = await loadModule();
    expect(await getGitHubAppConfig(ssm)).toEqual({ appId: '123', installationId: '456' });
  });

  it('returns nulls for an empty/unreadable config', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: '{}' } });
    const { getGitHubAppConfig } = await loadModule();
    expect(await getGitHubAppConfig(ssm)).toEqual({ appId: null, installationId: null });
  });
});

describe('writes', () => {
  it('writeGitHubAuthMode persists and busts the cache', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'oauth' } });
    ssmMock.on(PutParameterCommand).resolves({});
    const { getGitHubAuthMode, writeGitHubAuthMode } = await loadModule();
    expect(await getGitHubAuthMode(ssm)).toBe('oauth');

    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'app' } });
    await writeGitHubAuthMode(ssm, 'app');
    // Cache was cleared by the write, so the fresh value is visible.
    expect(await getGitHubAuthMode(ssm)).toBe('app');
    const put = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input;
    expect(put).toEqual(
      expect.objectContaining({ Name: MODE_PARAM, Value: 'app', Overwrite: true }),
    );
  });

  it('writeGitHubAuthMode rejects invalid modes', async () => {
    const { writeGitHubAuthMode } = await loadModule();
    await expect(writeGitHubAuthMode(ssm, 'both')).rejects.toThrow(/Invalid GitHub auth mode/);
  });

  it('writeGitHubAppConfig persists normalized strings', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    const { writeGitHubAppConfig } = await loadModule();
    await writeGitHubAppConfig(ssm, { appId: 123, installationId: null });
    const put = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input;
    expect(put.Name).toBe(CONFIG_PARAM);
    expect(JSON.parse(put.Value)).toEqual({ appId: '123', installationId: null });
  });
});
