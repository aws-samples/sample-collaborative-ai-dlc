import { describe, expect, it } from 'vitest';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';

import {
  SESSION_DURATION_SECONDS,
  assumeCodeCommitRole,
  codeCommitPermissionsPolicy,
  codeCommitSessionPolicy,
  codeCommitTrustPolicy,
  isCodeCommitExternalId,
  isCodeCommitRoleArn,
  newCodeCommitExternalId,
  roleAccountId,
} from '../codecommit-role.js';

const ROLE = 'arn:aws:iam::123456789012:role/aidlc-codecommit-access';
const REPO = 'arn:aws:codecommit:eu-west-1:123456789012:my-service';
const EXTERNAL_ID = 'aidlc:0f8fad5b-d9cb-469f-a165-70867728950e';

import { readFileSync } from 'node:fs';

const stsStub = (response) => {
  const calls = [];
  return {
    calls,
    send: async (command) => {
      calls.push(command);
      if (typeof response === 'function') return response(command);
      return response;
    },
  };
};

const okCredentials = {
  Credentials: {
    AccessKeyId: 'ASIAEXAMPLE',
    SecretAccessKey: 'secret', // pragma: allowlist secret
    SessionToken: 'token', // pragma: allowlist secret
    Expiration: new Date('2026-09-18T12:15:00Z'),
  },
  AssumedRoleUser: {
    Arn: 'arn:aws:sts::123456789012:assumed-role/aidlc-codecommit-access/aidlc-x',
  },
};

describe('external ids', () => {
  it('mints prefixed uuids that validate, and rejects anything else', () => {
    const id = newCodeCommitExternalId();
    expect(id.startsWith('aidlc:')).toBe(true);
    expect(isCodeCommitExternalId(id)).toBe(true);
    expect(newCodeCommitExternalId()).not.toBe(id);
    for (const bad of ['', null, 'aidlc:', 'aidlc:project-1', 'AIDLC:' + id.slice(6), id + 'x']) {
      expect(isCodeCommitExternalId(bad)).toBe(false);
    }
  });
});

describe('role arns', () => {
  it('accepts role arns across partitions and extracts the account', () => {
    expect(isCodeCommitRoleArn(ROLE)).toBe(true);
    expect(isCodeCommitRoleArn('arn:aws-cn:iam::123456789012:role/path/to/role')).toBe(true);
    expect(roleAccountId(ROLE)).toBe('123456789012');
  });
  it('rejects users, non-iam arns and malformed values', () => {
    expect(isCodeCommitRoleArn('arn:aws:iam::123456789012:user/alice')).toBe(false);
    expect(isCodeCommitRoleArn(REPO)).toBe(false);
    expect(isCodeCommitRoleArn('role/x')).toBe(false);
    expect(roleAccountId('nope')).toBeNull();
  });
});

describe('session policies', () => {
  it('read scopes GitPull and read API actions to the single repository arn', () => {
    const policy = codeCommitSessionPolicy({ repoArn: REPO, access: 'read' });
    const sids = policy.Statement.map((s) => s.Sid);
    expect(sids).toEqual(['GitRead', 'ApiRead']);
    for (const statement of policy.Statement) expect(statement.Resource).toBe(REPO);
    expect(policy.Statement[0].Action).toEqual(['codecommit:GitPull']);
    expect(JSON.stringify(policy)).not.toContain('GitPush');
  });
  it('write adds GitPush and the pull request / merge / branch actions', () => {
    const policy = codeCommitSessionPolicy({ repoArn: REPO, access: 'write' });
    const sids = policy.Statement.map((s) => s.Sid);
    expect(sids).toEqual(['GitRead', 'ApiRead', 'GitWrite', 'ApiWrite']);
    const write = policy.Statement.find((s) => s.Sid === 'ApiWrite');
    expect(write.Action).toEqual(
      expect.arrayContaining(['codecommit:CreatePullRequest', 'codecommit:MergeBranchesBySquash']),
    );
    expect(JSON.stringify(policy)).not.toContain('DeleteRepository');
  });
  it('discover is the only repo-less profile and grants listing only', () => {
    const policy = codeCommitSessionPolicy({ repoArn: null, access: 'discover' });
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0].Action).toEqual([
      'codecommit:ListRepositories',
      'codecommit:BatchGetRepositories',
    ]);
    expect(() => codeCommitSessionPolicy({ repoArn: null, access: 'read' })).toThrow(/repository/i);
    expect(() => codeCommitSessionPolicy({ repoArn: REPO, access: 'admin' })).toThrow(/access/);
  });
});

describe('assumeCodeCommitRole', () => {
  it('assumes with the stored external id, a scoped session policy and an attributable session name', async () => {
    const sts = stsStub(okCredentials);
    const out = await assumeCodeCommitRole({
      sts,
      roleArn: ROLE,
      externalId: EXTERNAL_ID,
      repoArn: REPO,
      access: 'write',
      executionId: 'exec/with spaces!',
    });
    expect(sts.calls).toHaveLength(1);
    expect(sts.calls[0]).toBeInstanceOf(AssumeRoleCommand);
    const input = sts.calls[0].input;
    expect(input.RoleArn).toBe(ROLE);
    expect(input.ExternalId).toBe(EXTERNAL_ID);
    expect(input.DurationSeconds).toBe(SESSION_DURATION_SECONDS);
    expect(input.RoleSessionName).toMatch(/^aidlc-[\w+=,.@-]{1,58}$/);
    expect(JSON.parse(input.Policy).Statement.map((s) => s.Sid)).toContain('GitWrite');
    expect(out).toMatchObject({
      accessKeyId: 'ASIAEXAMPLE',
      secretAccessKey: 'secret', // pragma: allowlist secret
      sessionToken: 'token', // pragma: allowlist secret
      expiration: new Date('2026-09-18T12:15:00.000Z'),
      assumedRoleArn: okCredentials.AssumedRoleUser.Arn,
    });
  });
  it('refuses to call STS without a valid role arn or external id', async () => {
    const sts = stsStub(okCredentials);
    await expect(
      assumeCodeCommitRole({ sts, roleArn: 'nope', externalId: EXTERNAL_ID, repoArn: REPO }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    await expect(
      assumeCodeCommitRole({ sts, roleArn: ROLE, externalId: 'aidlc:guess', repoArn: REPO }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(sts.calls).toHaveLength(0);
  });
  it('classifies STS failures into stable codes without leaking the STS message', async () => {
    const denied = stsStub(() => {
      throw Object.assign(new Error('User is not authorized to perform sts:AssumeRole'), {
        name: 'AccessDenied',
      });
    });
    await expect(
      assumeCodeCommitRole({ sts: denied, roleArn: ROLE, externalId: EXTERNAL_ID, repoArn: REPO }),
    ).rejects.toMatchObject({
      code: 'ROLE_ASSUMPTION_DENIED',
      message: expect.not.stringContaining('User is'),
    });
    const malformed = stsStub(() => {
      throw Object.assign(new Error('bad policy'), { name: 'MalformedPolicyDocumentException' });
    });
    await expect(
      assumeCodeCommitRole({
        sts: malformed,
        roleArn: ROLE,
        externalId: EXTERNAL_ID,
        repoArn: REPO,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_POLICY_INVALID' });
    const incomplete = stsStub({ Credentials: { AccessKeyId: 'x' } });
    await expect(
      assumeCodeCommitRole({
        sts: incomplete,
        roleArn: ROLE,
        externalId: EXTERNAL_ID,
        repoArn: REPO,
      }),
    ).rejects.toMatchObject({ code: 'ROLE_ASSUMPTION_FAILED' });
  });
});

describe('codeCommitTrustPolicy', () => {
  const principals = [
    'arn:aws:iam::999999999999:role/aidlc-credential-broker-dev',
    'arn:aws:iam::999999999999:role/aidlc-source-control-dev',
    'arn:aws:iam::999999999999:role/aidlc-codecommit-connector-dev',
  ];
  it('names every platform principal and pins the external id', () => {
    const policy = codeCommitTrustPolicy({ principals, externalId: EXTERNAL_ID });
    expect(policy.Statement).toHaveLength(1);
    const [statement] = policy.Statement;
    expect(statement.Action).toBe('sts:AssumeRole');
    expect(statement.Principal.AWS).toEqual(principals);
    expect(statement.Condition).toEqual({ StringEquals: { 'sts:ExternalId': EXTERNAL_ID } });
  });
  it('collapses a single principal to a string and rejects empty or invalid input', () => {
    const policy = codeCommitTrustPolicy({ principals: principals[0], externalId: EXTERNAL_ID });
    expect(policy.Statement[0].Principal.AWS).toBe(principals[0]);
    expect(() => codeCommitTrustPolicy({ principals: [], externalId: EXTERNAL_ID })).toThrow();
    expect(() => codeCommitTrustPolicy({ principals, externalId: 'aidlc:x' })).toThrow();
  });
});

describe('codeCommitPermissionsPolicy', () => {
  it('lists repositories on "*" and keeps every other action on the chosen repositories', () => {
    const policy = codeCommitPermissionsPolicy({ repositoryArns: [REPO] });
    const [list, repos] = policy.Statement;
    expect(list).toMatchObject({ Action: 'codecommit:ListRepositories', Resource: '*' });
    expect(repos.Resource).toBe(REPO);
    expect(JSON.stringify(policy)).not.toContain('codecommit:*');
    expect(repos.Action).toContain('codecommit:BatchGetRepositories');
  });

  it('covers every action a session policy can ask for', () => {
    const granted = new Set(
      codeCommitPermissionsPolicy().Statement.flatMap((s) => [s.Action].flat()),
    );
    const asked = [
      ...codeCommitSessionPolicy({ repoArn: REPO, access: 'write' }).Statement,
      ...codeCommitSessionPolicy({ access: 'discover' }).Statement,
    ].flatMap((s) => [s.Action].flat());
    expect(asked.filter((action) => !granted.has(action))).toEqual([]);
  });

  it('is the policy published in the setup guide', () => {
    const doc = readFileSync(
      new URL('../../../docs/getting-started/setup.md', import.meta.url),
      'utf8',
    );
    const block = /<!-- codecommit-permissions-policy[^>]*-->\s*```json\n([\s\S]*?)\n```/.exec(doc);
    expect(block).not.toBeNull();
    expect(JSON.parse(block[1])).toEqual(codeCommitPermissionsPolicy());
  });
});
