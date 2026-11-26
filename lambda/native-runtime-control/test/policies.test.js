import { describe, expect, it } from 'vitest';
import { fileSystemPolicy } from '../policies.js';
import { runtimePolicyDocuments, samePolicy, validateDeployment } from '../policies.js';
import { DEPLOYMENT, IDENTITY, IMAGE, OTHER } from './fixtures.js';

const deployment = {
  ...DEPLOYMENT,
  imageUri: IMAGE.uri,
  imageDigest: IMAGE.digest,
  ecrRepositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/agentcore',
  permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/native-boundary',
  subnetIds: ['subnet-12345678'],
  securityGroupIds: ['sg-12345678'],
};
const identity = { ...IDENTITY, bindingId: OTHER };
const ap = 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-1234567890abcdef0';

describe('native runtime grants', () => {
  it('grants only exact AP, repository and generated runtime logs; never application services', () => {
    const docs = runtimePolicyDocuments({ deployment, identity, accessPointArn: ap });
    expect(docs.roleArn).toContain(':role/native-runs/native_');
    const grant = docs.permissionsPolicy.Statement.find((s) => s.Sid === 'MountOwnWorkspace');
    expect(grant.Condition).toEqual({
      ArnEquals: { 'elasticfilesystem:AccessPointArn': ap },
      Bool: { 'aws:SecureTransport': 'true', 'elasticfilesystem:AccessedViaMountTarget': 'true' },
    });
    const actions = docs.permissionsPolicy.Statement.flatMap((s) => s.Action);
    expect(
      actions.some((action) => /^(s3|dynamodb|secretsmanager|bedrock|lambda|ssm):/.test(action)),
    ).toBe(false);
    const trust = docs.trustPolicy.Statement[0].Condition;
    expect(trust.StringEquals['aws:SourceAccount']).toBe(DEPLOYMENT.accountId);
    expect(trust.ArnLike['aws:SourceArn']).toBe(`${docs.runtimePrefix}*`);
    expect(fileSystemPolicy(deployment).Statement.every((s) => s.Effect === 'Deny')).toBe(true);
  });
  it('changes every generated resource boundary for another run or generation', () => {
    const a = runtimePolicyDocuments({ deployment, identity, accessPointArn: ap });
    for (const changed of [
      { ...identity, executionId: OTHER },
      { ...identity, bindingId: '50000000-0000-4000-8000-000000000001' },
    ]) {
      const b = runtimePolicyDocuments({ deployment, identity: changed, accessPointArn: ap });
      expect(a.roleArn).not.toBe(b.roleArn);
      expect(a.runtimePrefix).not.toBe(b.runtimePrefix);
      expect(a.names.rootDirectory).not.toBe(b.names.rootDirectory);
    }
    expect(a.names.rootDirectory).toHaveLength(70);
  });
  it.each([
    { imageUri: IMAGE.uri.replace('123456789012', '999999999999') },
    { imageDigest: `sha256:${'b'.repeat(64)}` },
    { ecrRepositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/other' },
    { permissionsBoundaryArn: 'arn:aws:iam::999999999999:policy/native-boundary' },
    { subnetIds: [] },
  ])('rejects mixed deployment input %j', (patch) => {
    expect(() => validateDeployment({ ...deployment, ...patch })).toThrow(
      'native_deployment_invalid',
    );
  });
  it('compares semantic ordering without allowing broader policies', () => {
    const expected = fileSystemPolicy(deployment);
    const reordered = structuredClone(expected);
    reordered.Statement.reverse();
    for (const s of reordered.Statement) if (Array.isArray(s.Action)) s.Action.reverse();
    expect(samePolicy(encodeURIComponent(JSON.stringify(reordered)), expected)).toBe(true);
    reordered.Statement.push({ Effect: 'Allow', Action: '*', Resource: '*', Principal: '*' });
    expect(samePolicy(reordered, expected)).toBe(false);
    expect(samePolicy('{invalid', expected)).toBe(false);
  });
});
