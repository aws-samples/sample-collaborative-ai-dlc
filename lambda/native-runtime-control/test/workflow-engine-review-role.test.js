import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNativeReviewRole, nativeReviewRolePolicy } from '../workflow-engine/job-roles.js';
import { nativeReviewerAlias } from '../../shared/native-workflow-protocol.js';

const ACCOUNT = '123456789012';
const FUNCTION = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:native-execution-credentials`;
const BOUNDARY = `arn:aws:iam::${ACCOUNT}:policy/native-review-boundary`;
const JOB_PROJECT = `arn:aws:codebuild:us-east-1:${ACCOUNT}:project/native-workflow-jobs`;
const REPOSITORY = `arn:aws:ecr:us-east-1:${ACCOUNT}:repository/agentcore`;
const PATH = '/native-review/';
const MISMATCH = { code: 'NATIVE_ENGINE_REVIEW_ROLE_MISMATCH' };
const awsError = (name) => Object.assign(new Error(name), { name });
const environment = () => ({
  NATIVE_EXECUTION_CREDENTIALS_FUNCTION: FUNCTION,
  NATIVE_EXECUTION_CREDENTIALS_VERSION: '7',
  NATIVE_WORKFLOW_REVIEW_BOUNDARY: BOUNDARY,
  NATIVE_WORKFLOW_REVIEW_ROLE_PATH: PATH,
  NATIVE_WORKFLOW_JOB_PROJECT_ARN: JOB_PROJECT,
  NATIVE_WORKFLOW_IMAGE_REPOSITORY_ARN: REPOSITORY,
  NATIVE_RUNTIME_ACCOUNT_ID: ACCOUNT,
});
const TRUST = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'codebuild.amazonaws.com' },
      Action: 'sts:AssumeRole',
      Condition: {
        StringEquals: { 'aws:SourceAccount': ACCOUNT },
        ArnEquals: { 'aws:SourceArn': JOB_PROJECT },
      },
    },
  ],
};
const MUTATION = /^(Create|Put|Update|Delete|Attach|Detach|Tag|Untag)/;

const fixture = (env = environment()) => {
  const identity = { projectId: 'project', executionId: randomUUID(), bindingId: randomUUID() };
  const aliasName = nativeReviewerAlias(identity);
  const roleName = `native_${aliasName}`;
  const aliases = new Map();
  const roles = new Map();
  const events = [];
  const hooks = {};
  const role = (name) => {
    if (!roles.has(name)) throw awsError('NoSuchEntity');
    return roles.get(name);
  };
  const lambda = {
    send: vi.fn(async (command) => {
      const name = command.constructor.name.replace(/Command$/, '');
      events.push(name);
      const input = command.input;
      await hooks[name]?.(input);
      if (name === 'GetAlias') {
        if (!aliases.has(input.Name)) throw awsError('ResourceNotFoundException');
        return structuredClone(aliases.get(input.Name));
      }
      if (name !== 'CreateAlias') throw new Error('Unexpected Lambda operation');
      if (aliases.has(input.Name)) throw awsError('ResourceConflictException');
      aliases.set(input.Name, {
        AliasArn: `${input.FunctionName}:${input.Name}`,
        Name: input.Name,
        FunctionVersion: input.FunctionVersion,
      });
      return structuredClone(aliases.get(input.Name));
    }),
  };
  const iam = {
    send: vi.fn(async (command) => {
      const name = command.constructor.name.replace(/Command$/, '');
      events.push(name);
      const input = command.input;
      await hooks[name]?.(input);
      switch (name) {
        case 'GetRole':
          return { Role: structuredClone(role(input.RoleName).Role) };
        case 'CreateRole':
          if (roles.has(input.RoleName)) throw awsError('EntityAlreadyExists');
          roles.set(input.RoleName, {
            Role: {
              RoleName: input.RoleName,
              Path: input.Path,
              Arn: `arn:aws:iam::${ACCOUNT}:role${input.Path}${input.RoleName}`,
              // IAM returns the trust policy URL-encoded.
              AssumeRolePolicyDocument: encodeURIComponent(input.AssumeRolePolicyDocument),
              ...(input.PermissionsBoundary
                ? { PermissionsBoundary: { PermissionsBoundaryArn: input.PermissionsBoundary } }
                : {}),
            },
            inline: new Map(),
            attached: [],
          });
          return {};
        case 'ListAttachedRolePolicies':
          return {
            AttachedPolicies: structuredClone(role(input.RoleName).attached),
            IsTruncated: role(input.RoleName).attachedTruncated ?? false,
          };
        case 'ListRolePolicies':
          return {
            PolicyNames: [...role(input.RoleName).inline.keys()],
            IsTruncated: role(input.RoleName).inlineTruncated ?? false,
          };
        case 'GetRolePolicy': {
          const inline = role(input.RoleName).inline;
          if (!inline.has(input.PolicyName)) throw awsError('NoSuchEntity');
          return { PolicyDocument: encodeURIComponent(inline.get(input.PolicyName)) };
        }
        case 'PutRolePolicy':
          role(input.RoleName).inline.set(input.PolicyName, input.PolicyDocument);
          return {};
        default:
          throw new Error('Unexpected IAM operation');
      }
    }),
  };
  const authorize = vi.fn(async () => {
    events.push('authorize');
  });
  const expected = {
    roleArn: `arn:aws:iam::${ACCOUNT}:role${PATH}${roleName}`,
    credentialAlias: `${FUNCTION}:${aliasName}`,
  };
  return {
    identity,
    aliasName,
    roleName,
    aliases,
    roles,
    events,
    hooks,
    lambda,
    iam,
    authorize,
    expected,
    env,
    policy: nativeReviewRolePolicy({
      credentialAlias: expected.credentialAlias,
      repositoryArn: REPOSITORY,
    }),
    mutations: () => events.filter((event) => MUTATION.test(event)),
    run: () => createNativeReviewRole({ iam, lambda, env, authorize })(identity),
    sent: (client, name) =>
      client.send.mock.calls
        .filter(([command]) => command.constructor.name === `${name}Command`)
        .map(([command]) => command.input),
  };
};
// A correct boundary provisioned by an earlier use, then changed out of band.
const provisioned = async () => {
  const f = fixture();
  await f.run();
  f.events.length = 0;
  f.lambda.send.mockClear();
  f.iam.send.mockClear();
  return f;
};

describe('reviewer credential boundary', () => {
  it('creates one alias at the captured version and one bounded CodeBuild-only role', async () => {
    const f = fixture();
    expect(await f.run()).toEqual(f.expected);

    expect(f.sent(f.lambda, 'CreateAlias')).toEqual([
      expect.objectContaining({ FunctionName: FUNCTION, Name: f.aliasName, FunctionVersion: '7' }),
    ]);
    expect(f.aliases.get(f.aliasName)).toMatchObject({
      AliasArn: f.expected.credentialAlias,
      FunctionVersion: '7',
    });
    expect(f.aliases.get(f.aliasName)).not.toHaveProperty('RoutingConfig');

    const [created, ...others] = f.sent(f.iam, 'CreateRole');
    expect(others).toEqual([]);
    expect(created).toMatchObject({
      RoleName: f.roleName,
      Path: PATH,
      PermissionsBoundary: BOUNDARY,
    });
    expect(JSON.parse(created.AssumeRolePolicyDocument)).toEqual(TRUST);

    const puts = f.sent(f.iam, 'PutRolePolicy');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ RoleName: f.roleName, PolicyName: 'native-review' });
    expect(JSON.parse(puts[0].PolicyDocument)).toEqual(f.policy);
    expect([...f.roles.get(f.roleName).inline.keys()]).toEqual(['native-review']);
    expect(f.roles.get(f.roleName).attached).toEqual([]);
    expect(f.mutations()).toEqual(['CreateAlias', 'CreateRole', 'PutRolePolicy']);
  });

  it('grants only the image pull and one model-credential alias', () => {
    const f = fixture();
    const statements = f.policy.Statement;
    expect(statements.every((statement) => statement.Effect === 'Allow')).toBe(true);
    const actions = statements.flatMap((statement) => [statement.Action].flat());
    expect(actions.toSorted()).toEqual([
      'ecr:BatchCheckLayerAvailability',
      'ecr:BatchGetImage',
      'ecr:GetAuthorizationToken',
      'ecr:GetDownloadUrlForLayer',
      'lambda:InvokeFunction',
    ]);
    const invoke = statements.filter((statement) =>
      [statement.Action].flat().includes('lambda:InvokeFunction'),
    );
    expect(invoke).toHaveLength(1);
    expect(invoke[0].Resource).toBe(f.expected.credentialAlias);
    expect(invoke[0].Resource).toMatch(/:function:[A-Za-z0-9_-]+:review_[a-f0-9]{32}$/);
    // Only the registry login, which AWS cannot scope, uses a wildcard.
    for (const statement of statements) {
      if (statement.Action === 'ecr:GetAuthorizationToken') continue;
      for (const resource of [statement.Resource].flat()) expect(resource).not.toContain('*');
    }
    expect(statements.find((statement) => statement.Sid === 'PullQualifiedImage').Resource).toBe(
      REPOSITORY,
    );
    expect(JSON.stringify(f.policy)).not.toMatch(
      /s3:|dynamodb:|ssm:|secretsmanager:|kms:|sts:|iam:|codebuild:|codeconnections:|bedrock/,
    );
  });

  it('gives each binding its own alias and role', async () => {
    const first = fixture();
    const second = fixture();
    const [a, b] = [await first.run(), await second.run()];
    expect(a.roleArn).not.toBe(b.roleArn);
    expect(a.credentialAlias).not.toBe(b.credentialAlias);
  });

  it('is idempotent: a second use verifies and changes nothing', async () => {
    const f = await provisioned();
    expect(await f.run()).toEqual(f.expected);
    expect(f.mutations()).toEqual([]);
    expect(f.events).toContain('GetAlias');
    expect(f.events).toContain('GetRole');
    expect(f.events).toContain('GetRolePolicy');
  });

  it('adds the missing policy to a correct but unfinished role', async () => {
    const f = await provisioned();
    f.roles.get(f.roleName).inline.clear();
    expect(await f.run()).toEqual(f.expected);
    expect(f.mutations()).toEqual(['PutRolePolicy']);
    expect(JSON.parse(f.roles.get(f.roleName).inline.get('native-review'))).toEqual(f.policy);
  });
});

describe('existing reviewer boundary is verified, never retargeted or widened', () => {
  const widened = (f) => ({
    ...f.policy,
    Statement: f.policy.Statement.map((statement) =>
      statement.Action === 'lambda:InvokeFunction' ? { ...statement, Resource: '*' } : statement,
    ),
  });
  it.each([
    [
      'an alias at another version',
      (f) => {
        f.aliases.get(f.aliasName).FunctionVersion = '8';
      },
    ],
    [
      'an alias with weighted routing',
      (f) => {
        f.aliases.get(f.aliasName).RoutingConfig = { AdditionalVersionWeights: { 8: 0.5 } };
      },
    ],
    [
      'an alias of another function',
      (f) => {
        f.aliases.get(f.aliasName).AliasArn = `${FUNCTION}-other:${f.aliasName}`;
      },
    ],
    [
      'a role with another boundary',
      (f) => {
        f.roles.get(f.roleName).Role.PermissionsBoundary.PermissionsBoundaryArn += '-wide';
      },
    ],
    [
      'a role without a boundary',
      (f) => {
        delete f.roles.get(f.roleName).Role.PermissionsBoundary;
      },
    ],
    [
      'a role outside the configured path',
      (f) => {
        f.roles.get(f.roleName).Role.Arn = `arn:aws:iam::${ACCOUNT}:role/${f.roleName}`;
      },
    ],
    [
      'a role trusted by another service',
      (f) => {
        f.roles.get(f.roleName).Role.AssumeRolePolicyDocument = encodeURIComponent(
          JSON.stringify({
            ...TRUST,
            Statement: [{ ...TRUST.Statement[0], Principal: { Service: 'lambda.amazonaws.com' } }],
          }),
        );
      },
    ],
    [
      'a role trusted by any CodeBuild project',
      (f) => {
        const { Condition: _condition, ...statement } = TRUST.Statement[0];
        f.roles.get(f.roleName).Role.AssumeRolePolicyDocument = encodeURIComponent(
          JSON.stringify({ ...TRUST, Statement: [statement] }),
        );
      },
    ],
    [
      'a role trusted by an additional principal',
      (f) => {
        f.roles.get(f.roleName).Role.AssumeRolePolicyDocument = encodeURIComponent(
          JSON.stringify({
            ...TRUST,
            Statement: [
              ...TRUST.Statement,
              {
                Effect: 'Allow',
                Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` },
                Action: 'sts:AssumeRole',
              },
            ],
          }),
        );
      },
    ],
    [
      'an attached managed policy',
      (f) => {
        f.roles.get(f.roleName).attached.push({
          PolicyName: 'AdministratorAccess',
          PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess',
        });
      },
    ],
    [
      'an incomplete managed-policy listing',
      (f) => {
        f.roles.get(f.roleName).attachedTruncated = true;
      },
    ],
    [
      'an extra inline policy',
      (f) => {
        f.roles.get(f.roleName).inline.set('extra', JSON.stringify(widened(f)));
      },
    ],
    [
      'an incomplete inline-policy listing',
      (f) => {
        f.roles.get(f.roleName).inlineTruncated = true;
      },
    ],
    [
      'a widened inline policy',
      (f) => {
        f.roles.get(f.roleName).inline.set('native-review', JSON.stringify(widened(f)));
      },
    ],
    [
      'an inline policy with an added statement',
      (f) => {
        f.roles.get(f.roleName).inline.set(
          'native-review',
          JSON.stringify({
            ...f.policy,
            Statement: [
              ...f.policy.Statement,
              { Effect: 'Allow', Action: 's3:GetObject', Resource: '*' },
            ],
          }),
        );
      },
    ],
  ])('refuses %s without changing it', async (_label, change) => {
    const f = await provisioned();
    change(f);
    const before = structuredClone({
      aliases: [...f.aliases],
      roles: [...f.roles].map(([name, value]) => [name, { ...value, inline: [...value.inline] }]),
    });
    await expect(f.run()).rejects.toMatchObject(MISMATCH);
    expect(f.mutations()).toEqual([]);
    expect(
      structuredClone({
        aliases: [...f.aliases],
        roles: [...f.roles].map(([name, value]) => [name, { ...value, inline: [...value.inline] }]),
      }),
    ).toEqual(before);
  });

  it('does not create a role behind an alias that points elsewhere', async () => {
    const f = fixture();
    f.aliases.set(f.aliasName, {
      AliasArn: f.expected.credentialAlias,
      FunctionVersion: '6',
    });
    await expect(f.run()).rejects.toMatchObject(MISMATCH);
    expect(f.mutations()).toEqual([]);
    expect(f.iam.send).not.toHaveBeenCalled();
  });
});

describe('ambiguous reviewer boundary creation', () => {
  it('reads back an alias and role that another invocation created first', async () => {
    const other = fixture();
    await other.run();
    const f = fixture();
    // A concurrent invocation for the same binding wins both creations.
    f.hooks.CreateAlias = () => {
      f.aliases.set(f.aliasName, {
        AliasArn: f.expected.credentialAlias,
        FunctionVersion: '7',
      });
    };
    f.hooks.CreateRole = (input) => {
      f.roles.set(f.roleName, {
        Role: {
          Arn: f.expected.roleArn,
          AssumeRolePolicyDocument: encodeURIComponent(input.AssumeRolePolicyDocument),
          PermissionsBoundary: { PermissionsBoundaryArn: BOUNDARY },
        },
        inline: new Map(),
        attached: [],
      });
    };
    expect(await f.run()).toEqual(f.expected);
    expect(f.events.filter((event) => event === 'CreateAlias')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'CreateRole')).toHaveLength(1);
    expect(f.aliases.get(f.aliasName).FunctionVersion).toBe('7');
  });

  it('still refuses a conflicting alias created at another version', async () => {
    const f = fixture();
    f.hooks.CreateAlias = () => {
      f.aliases.set(f.aliasName, {
        AliasArn: f.expected.credentialAlias,
        FunctionVersion: '6',
      });
    };
    await expect(f.run()).rejects.toMatchObject(MISMATCH);
    expect(f.aliases.get(f.aliasName).FunctionVersion).toBe('6');
    expect(f.iam.send).not.toHaveBeenCalled();
  });

  it('still refuses a conflicting role created without the boundary', async () => {
    const f = fixture();
    f.hooks.CreateRole = (input) => {
      f.roles.set(f.roleName, {
        Role: {
          Arn: f.expected.roleArn,
          AssumeRolePolicyDocument: encodeURIComponent(input.AssumeRolePolicyDocument),
        },
        inline: new Map(),
        attached: [],
      });
    };
    await expect(f.run()).rejects.toMatchObject(MISMATCH);
    expect(f.events).not.toContain('PutRolePolicy');
    expect(f.roles.get(f.roleName).inline.size).toBe(0);
  });

  it.each([
    ['CreateAlias', 'AccessDeniedException'],
    ['CreateRole', 'AccessDenied'],
    ['PutRolePolicy', 'AccessDenied'],
    ['GetAlias', 'ServiceException'],
    ['GetRole', 'ServiceFailure'],
  ])('does not treat a %s failure (%s) as an existing resource', async (operation, name) => {
    const f = fixture();
    f.hooks[operation] = () => {
      throw awsError(name);
    };
    await expect(f.run()).rejects.toMatchObject({ name });
    expect(f.events.at(-1)).toBe(operation);
  });

  it('refuses a stored policy that reads back differently from what was written', async () => {
    const f = fixture();
    f.hooks.PutRolePolicy = (input) => {
      input.PolicyDocument = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
      });
    };
    await expect(f.run()).rejects.toMatchObject(MISMATCH);
  });
});

describe('reviewer boundary configuration and authority', () => {
  it.each([
    ['no credentials function', { NATIVE_EXECUTION_CREDENTIALS_FUNCTION: undefined }],
    ['no captured version', { NATIVE_EXECUTION_CREDENTIALS_VERSION: undefined }],
    ['an unpublished version', { NATIVE_EXECUTION_CREDENTIALS_VERSION: '$LATEST' }],
    ['a zero version', { NATIVE_EXECUTION_CREDENTIALS_VERSION: '0' }],
    ['an alias as version', { NATIVE_EXECUTION_CREDENTIALS_VERSION: 'live' }],
    ['no permissions boundary', { NATIVE_WORKFLOW_REVIEW_BOUNDARY: undefined }],
    ['an empty permissions boundary', { NATIVE_WORKFLOW_REVIEW_BOUNDARY: '' }],
  ])('fails closed with %s', async (_label, change) => {
    const f = fixture({ ...environment(), ...change });
    await expect(f.run()).rejects.toMatchObject(MISMATCH);
    expect(f.lambda.send).not.toHaveBeenCalled();
    expect(f.iam.send).not.toHaveBeenCalled();
  });

  it('authorizes immediately before every mutation and before returning the role', async () => {
    const f = fixture();
    await f.run();
    expect(f.events[0]).toBe('authorize');
    expect(f.events.at(-1)).toBe('authorize');
    for (const [index, event] of f.events.entries())
      if (MUTATION.test(event)) expect(f.events[index - 1]).toBe('authorize');
  });

  it.each([1, 2, 3, 4, 5])(
    'stops at authorization %i once authority is revoked',
    async (failing) => {
      const f = fixture();
      let calls = 0;
      f.authorize.mockImplementation(async () => {
        f.events.push('authorize');
        if (++calls === failing)
          throw Object.assign(new Error('revoked'), { code: 'NATIVE_ENGINE_FORBIDDEN' });
      });
      await expect(f.run()).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      // Nothing is read or written after the refused authorization.
      expect(f.events.at(-1)).toBe('authorize');
      expect(f.authorize).toHaveBeenCalledTimes(failing);
      expect(f.mutations()).toEqual(
        ['CreateAlias', 'CreateRole', 'PutRolePolicy'].slice(0, Math.max(0, failing - 2)),
      );
    },
  );

  it('creates nothing when authority was never granted', async () => {
    const f = fixture();
    f.authorize.mockRejectedValue(
      Object.assign(new Error('revoked'), { code: 'NATIVE_ENGINE_FORBIDDEN' }),
    );
    await expect(f.run()).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
    expect(f.lambda.send).not.toHaveBeenCalled();
    expect(f.iam.send).not.toHaveBeenCalled();
    expect(f.aliases.size).toBe(0);
    expect(f.roles.size).toBe(0);
  });
});
