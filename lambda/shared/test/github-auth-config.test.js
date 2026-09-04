import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

const ssmMock = mockClient(SSMClient);
const ssm = new SSMClient({});
const CONFIG_PARAM = '/proj/dev/github-app-config';

const loadModule = async () => {
  vi.resetModules();
  return import('../github-auth-config.js');
};

beforeEach(() => {
  ssmMock.reset();
  vi.stubEnv('GITHUB_APP_CONFIG_PARAM', CONFIG_PARAM);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GitHub App platform configuration', () => {
  it('reads only the App ID and ignores a legacy global installation ID', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: CONFIG_PARAM })
      .resolves({ Parameter: { Value: JSON.stringify({ appId: 123, installationId: '456' }) } });
    const { getGitHubAppConfig } = await loadModule();
    expect(await getGitHubAppConfig(ssm)).toEqual({ appId: '123' });
  });

  it('returns an empty App identity for missing configuration', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: '{}' } });
    const { getGitHubAppConfig } = await loadModule();
    expect(await getGitHubAppConfig(ssm)).toEqual({ appId: null });
  });

  it('persists only the normalized App ID', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    const { writeGitHubAppConfig } = await loadModule();
    await writeGitHubAppConfig(ssm, { appId: 123 });
    const put = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input;
    expect(put.Name).toBe(CONFIG_PARAM);
    expect(JSON.parse(put.Value)).toEqual({ appId: '123' });
  });
});
