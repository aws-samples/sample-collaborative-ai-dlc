import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getCodeCommitConnection,
  platformExternalId,
  writeCodeCommitConnection,
} from '../codecommit-platform-config.js';

const PARAM = '/aidlc/dev/codecommit-connection';
const ROLE = 'arn:aws:iam::123456789012:role/aidlc-codecommit-access';

// Minimal SSM stub: a value for GetParameter, a sink for PutParameter, or a
// thrower to exercise the fail-closed path.
const ssmReturning = (value) => ({
  calls: [],
  async send(command) {
    this.calls.push(command);
    if (command.constructor.name === 'GetParameterCommand') {
      return { Parameter: { Value: value } };
    }
    if (command.constructor.name === 'PutParameterCommand') {
      this.put = command.input;
      return {};
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  },
});

const ssmThrowing = (error) => ({
  async send() {
    throw error;
  },
});

describe('codecommit platform connection reader', () => {
  let env;
  beforeEach(() => {
    env = { ...process.env };
    process.env.CODECOMMIT_CONNECTION_PARAM = PARAM;
    process.env.CODECOMMIT_EXTERNAL_ID = 'aidlc:0f8fad5b-d9cb-469f-a165-70867728950e';
  });
  afterEach(() => {
    process.env = env;
  });

  it('reads the saved role and region', async () => {
    const ssm = ssmReturning(JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' }));
    expect(await getCodeCommitConnection(ssm)).toEqual({ roleArn: ROLE, region: 'eu-west-1' });
  });

  it('reports not configured for the initial "{}" value', async () => {
    expect(await getCodeCommitConnection(ssmReturning('{}'))).toEqual({
      roleArn: null,
      region: null,
    });
  });

  it('treats an invalid role, an unsupported region or a half-written value as not configured', async () => {
    expect(await getCodeCommitConnection(ssmReturning(JSON.stringify({ roleArn: ROLE })))).toEqual({
      roleArn: null,
      region: null,
    });
    expect(
      await getCodeCommitConnection(
        ssmReturning(JSON.stringify({ roleArn: 'nope', region: 'eu-west-1' })),
      ),
    ).toEqual({ roleArn: null, region: null });
    expect(
      await getCodeCommitConnection(
        ssmReturning(JSON.stringify({ roleArn: ROLE, region: 'eu-central-2' })),
      ),
    ).toEqual({ roleArn: null, region: null });
  });

  it('fails closed: an SSM error throws, it never reports not configured', async () => {
    const boom = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    const error = await getCodeCommitConnection(ssmThrowing(boom)).catch((e) => e);
    // Stable code for the 5xx path, safe message (the SDK text can name ARNs).
    expect(error).toMatchObject({
      code: 'CODECOMMIT_CONNECTION_UNAVAILABLE',
      message: 'CodeCommit connection is unavailable',
      cause: boom,
    });
    expect(error.message).not.toContain('arn:');
  });

  it('fails closed: a corrupt parameter throws', async () => {
    await expect(getCodeCommitConnection(ssmReturning('{not json'))).rejects.toThrow(/JSON/);
  });

  it('requires the parameter-name env var', async () => {
    delete process.env.CODECOMMIT_CONNECTION_PARAM;
    await expect(getCodeCommitConnection(ssmReturning('{}'))).rejects.toThrow(
      /CODECOMMIT_CONNECTION_PARAM/,
    );
  });

  it('writes the connection as a String parameter, overwriting', async () => {
    const ssm = ssmReturning('{}');
    await writeCodeCommitConnection(ssm, { roleArn: ROLE, region: 'eu-west-1' });
    expect(ssm.put).toMatchObject({
      Name: PARAM,
      Type: 'String',
      Overwrite: true,
      Value: JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' }),
    });
  });

  it('exposes the per-deployment external id from the env', () => {
    expect(platformExternalId()).toBe('aidlc:0f8fad5b-d9cb-469f-a165-70867728950e');
  });
});
