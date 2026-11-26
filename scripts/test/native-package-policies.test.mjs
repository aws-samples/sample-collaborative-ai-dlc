import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { renderNativePackagePolicies } from '../render-native-package-policies.mjs';

const bucketArn = 'arn:aws:s3:::isolated-native-packages-test';
const publisherRoleArn = 'arn:aws:iam::123456789012:role/native-package-worker';
const key = `${bucketArn}/native-packages/v1/source/materialization/files/version.json`;
const conditions = {
  'aws:SecureTransport': 'true',
  's3:ObjectCreationOperation': 'true',
  's3:if-none-match': '*',
  'aws:PrincipalArn': publisherRoleArn,
};
const runFile = promisify(execFile);
const rendererPath = fileURLToPath(
  new URL('../render-native-package-policies.mjs', import.meta.url),
);

// Deliberately limited to the operators in these candidate JSON documents.
// This tests policy logic against EXPLICIT request context, not IAM/S3 itself.
// In particular it cannot prove which keys a real S3 operation populates.
const list = (value) => (Array.isArray(value) ? value : [value]);
const wildcard = (pattern, value) => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).exec(value)?.[0] === value;
};
const applies = (statement, action, resource, context) => {
  // Only global bucket denies and identity policies are modeled here. Never
  // silently interpret a narrowed principal as a deny applying to everybody.
  if (Object.hasOwn(statement, 'Principal')) assert.equal(statement.Principal, '*');
  assert.ok(!Object.hasOwn(statement, 'NotPrincipal'));
  if (!list(statement.Action).some((pattern) => wildcard(pattern, action))) return false;
  if (!list(statement.Resource).some((pattern) => wildcard(pattern, resource))) return false;
  return Object.entries(statement.Condition ?? {}).every(([operator, entries]) =>
    Object.entries(entries).every(([name, expected]) => {
      const present = Object.hasOwn(context, name) && context[name] !== null;
      switch (operator) {
        case 'Null':
          return !present === (expected === 'true');
        case 'Bool':
        case 'StringEquals':
          return present && context[name] === expected;
        case 'BoolIfExists':
          return !present || context[name] === expected;
        case 'StringNotEquals':
        case 'ArnNotEquals':
          return !present || context[name] !== expected;
        default:
          assert.fail(`Unmodeled condition operator: ${operator}`);
      }
    }),
  );
};
const decision = (
  policies,
  { action = 's3:PutObject', resource = key, context = conditions } = {},
) => {
  const matching = policies
    .flatMap((policy) => policy.Statement)
    .filter((statement) => applies(statement, action, resource, context));
  if (matching.some((statement) => statement.Effect === 'Deny')) return 'deny';
  return matching.some((statement) => statement.Effect === 'Allow') ? 'allow' : 'implicit-deny';
};
const candidate = await renderNativePackagePolicies({ bucketArn, publisherRoleArn });
const pair = [candidate.bucketPolicy, candidate.publisherPolicy];
const otherWriter = {
  Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: `${bucketArn}/*` }],
};
const assertPublisherFence = ({ bucketPolicy, publisherPolicy }) => {
  assert.ok(
    bucketPolicy.Statement.every(
      (statement) => statement.Effect === 'Deny' && statement.Principal === '*',
    ),
    'The bucket must not confer ambient permissions or narrow its deny principals',
  );
  const deny = bucketPolicy.Statement.find(
    (statement) => statement.Sid === 'DenyOtherPackagePublishers',
  );
  assert.ok(deny, 'the bucket must fence publication to the worker role');
  assert.equal(deny.Action, 's3:PutObject');
  assert.deepEqual(deny.Condition, {
    ArnNotEquals: { 'aws:PrincipalArn': publisherRoleArn },
  });
  assert.equal(publisherPolicy.Statement[0].Resource, `${bucketArn}/native-packages/v1/*`);
  assert.equal(deny.Resource, `${bucketArn}/native-packages/v1/*`);
  for (const resource of [
    key,
    `${bucketArn}/native-packages/v1/another-source/another-pin/manifest.json`,
  ]) {
    assert.equal(decision([bucketPolicy, publisherPolicy], { resource }), 'allow');
    // The broad allow must not mask a missing/narrow deny. Policy order has
    // no effect on explicit-deny precedence in this limited context model.
    for (const policies of [
      [bucketPolicy, otherWriter],
      [otherWriter, bucketPolicy],
    ]) {
      assert.equal(decision(policies, { resource }), 'allow');
      for (const principal of [undefined, 'arn:aws:iam::123456789012:role/another-writer']) {
        const context = { ...conditions };
        delete context['aws:PrincipalArn'];
        if (principal !== undefined) context['aws:PrincipalArn'] = principal;
        assert.equal(decision(policies, { resource, context }), 'deny');
      }
    }
  }
};
const assertObjectCreationGuard = ({ bucketPolicy, publisherPolicy }, operation) => {
  // Keep the correct header, TLS, and worker ARN so only the operation guard
  // can reject an injected If-None-Match: * header in these explicit contexts.
  const context = { ...conditions };
  delete context['s3:ObjectCreationOperation'];
  if (operation !== undefined) context['s3:ObjectCreationOperation'] = operation;
  for (const resource of [
    key,
    `${bucketArn}/native-packages/v1/another-source/another-pin/manifest.json`,
  ]) {
    assert.equal(
      decision([publisherPolicy], { resource, context }),
      'implicit-deny',
      'The publisher alone must require object-creation context',
    );
    for (const policies of [
      [bucketPolicy, otherWriter],
      [otherWriter, bucketPolicy],
      [bucketPolicy, publisherPolicy],
    ]) {
      assert.equal(
        decision(policies, { resource, context }),
        'deny',
        'The bucket must explicitly deny even a broad same-role allow',
      );
    }
  }
};

describe('native package policy candidates: local context evaluation only', () => {
  it('marks the rendered result as unverified and preserves the exact namespace', () => {
    assert.equal(candidate.qualification, 'unverified');
    assert.equal(candidate.bucketPolicy.Version, '2012-10-17');
    assert.equal(
      candidate.publisherPolicy.Statement[0].Resource,
      `${bucketArn}/native-packages/v1/*`,
    );
    assert.ok(candidate.requiredChecks.some((check) => /live.*upload/i.test(check)));
    assert.ok(candidate.requiredChecks.some((check) => /Terraform and IAM/.test(check)));
    assert.ok(candidate.requiredChecks.some((check) => /deployed role isolation/.test(check)));
  });
  it('allows the worker’s conditional HTTPS upload and no ambient grant from the bucket', () => {
    assert.equal(decision(pair), 'allow');
    assert.equal(decision([candidate.bucketPolicy]), 'implicit-deny');
    assert.ok(
      candidate.bucketPolicy.Statement.every(
        (statement) => statement.Effect === 'Deny' && statement.Principal === '*',
      ),
    );
  });
  it('allows the worker role ARN context, without granting other identities publication', () => {
    // AWS documents the IAM role ARN as the PrincipalArn context for assumed-role
    // requests. Supplying that context here does not exercise STS or real IAM.
    assertPublisherFence(candidate);
  });
  for (const operation of ['false', undefined, null]) {
    it(`denies non-creation or missing operation context despite an injected correct header: ${JSON.stringify(operation)}`, () => {
      // CreateMultipartUpload, UploadPart, and UploadPartCopy use false context;
      // this model supplies that context explicitly rather than invoking S3.
      assertObjectCreationGuard(candidate, operation);
    });
  }
  it('allows the shared true context for conditional PutObject and CompleteMultipartUpload', () => {
    // Both APIs use s3:PutObject with ObjectCreationOperation true. This guard
    // cannot independently block completion of an already initiated upload.
    for (const policies of [
      [candidate.publisherPolicy],
      pair,
      [candidate.bucketPolicy, otherWriter],
    ]) {
      assert.equal(decision(policies), 'allow');
    }
  });
  for (const principal of [
    undefined,
    null,
    '',
    'arn:aws:iam::123456789012:role/application-agent',
    `${publisherRoleArn}-lookalike`,
    'arn:aws:iam::210987654321:role/native-package-worker',
    'arn:aws:iam::123456789012:user/native-package-worker',
    'arn:aws:iam::123456789012:root',
    'arn:aws:sts::123456789012:assumed-role/native-package-worker/session',
    `${publisherRoleArn}/*`,
  ]) {
    it(`denies a different or missing PrincipalArn despite a broad allow: ${JSON.stringify(principal)}`, () => {
      const context = { ...conditions };
      delete context['aws:PrincipalArn'];
      if (principal !== undefined) context['aws:PrincipalArn'] = principal;
      for (const resource of [
        key,
        `${bucketArn}/native-packages/v1/another-source/another-pin/manifest.json`,
      ]) {
        assert.equal(decision(pair, { context, resource }), 'deny');
        assert.equal(
          decision([candidate.bucketPolicy, otherWriter], { context, resource }),
          'deny',
        );
      }
    });
  }
  for (const value of [undefined, null, '', 'etag-value', '"*"', '* ', '*\n']) {
    it(`denies a creation condition other than the exact wildcard: ${JSON.stringify(value)}`, () => {
      const context = { ...conditions };
      delete context['s3:if-none-match'];
      if (value !== undefined) context['s3:if-none-match'] = value;
      assert.equal(decision(pair, { context }), 'deny');
      // A future broad writer grant must not bypass the bucket's explicit deny.
      assert.equal(decision([candidate.bucketPolicy, otherWriter], { context }), 'deny');
    });
  }
  it('denies a conditional copy even with broad write permission', () => {
    for (const copy of ['bucket/key', '/bucket/key?versionId=v1', '']) {
      const context = { ...conditions, 's3:x-amz-copy-source': copy };
      assert.equal(decision(pair, { context }), 'deny');
      assert.equal(decision([candidate.bucketPolicy, otherWriter], { context }), 'deny');
    }
  });
  it('denies all modeled object operations over insecure transport', () => {
    for (const action of [
      's3:PutObject',
      's3:GetObject',
      's3:GetObjectVersion',
      's3:DeleteObject',
    ]) {
      assert.equal(
        decision(pair, { action, context: { ...conditions, 'aws:SecureTransport': 'false' } }),
        'deny',
      );
    }
  });
  it('denies both current-object deletion and permanent version deletion', () => {
    for (const action of ['s3:DeleteObject', 's3:DeleteObjectVersion']) {
      assert.equal(decision([candidate.bucketPolicy, otherWriter], { action }), 'deny');
    }
  });
  it('does not grant the publisher listing, deletion, ACL, tagging, or multipart abort privileges', () => {
    for (const action of [
      's3:ListBucket',
      's3:DeleteObject',
      's3:DeleteObjectVersion',
      's3:PutObjectAcl',
      's3:PutObjectTagging',
      's3:AbortMultipartUpload',
      's3:ListMultipartUploadParts',
    ]) {
      const resource = action === 's3:ListBucket' ? bucketArn : key;
      assert.equal(decision([candidate.publisherPolicy], { action, resource }), 'implicit-deny');
    }
  });
  it('requires all upload constraints in the publisher grant without relying on bucket denies', () => {
    assert.equal(candidate.publisherPolicy.Statement.length, 1);
    assert.equal(candidate.publisherPolicy.Statement[0].Action, 's3:PutObject');
    assert.deepEqual(candidate.publisherPolicy.Statement[0].Condition, {
      Bool: { 'aws:SecureTransport': 'true', 's3:ObjectCreationOperation': 'true' },
      StringEquals: { 's3:if-none-match': '*' },
      Null: { 's3:x-amz-copy-source': 'true' },
    });
    // The identity policy is attached to the worker, so the role fence belongs
    // to the bucket policy. Do not mask identity-policy behavior with that fence.
    const withoutPrincipal = { ...conditions };
    delete withoutPrincipal['aws:PrincipalArn'];
    assert.equal(decision([candidate.publisherPolicy], { context: withoutPrincipal }), 'allow');
    for (const context of [
      {},
      { 'aws:SecureTransport': 'true' },
      { ...conditions, 'aws:SecureTransport': 'false' },
      { ...conditions, 's3:if-none-match': 'etag' },
      { ...conditions, 's3:x-amz-copy-source': '/another/key' },
    ]) {
      assert.equal(decision([candidate.publisherPolicy], { context }), 'implicit-deny');
    }
  });
  it('applies every package deny to all source/materialization namespaces', () => {
    for (const statement of candidate.bucketPolicy.Statement) {
      assert.deepEqual(
        statement.Resource,
        statement.Sid === 'DenyInsecureTransport'
          ? [bucketArn, `${bucketArn}/*`]
          : `${bucketArn}/native-packages/v1/*`,
      );
    }
    const broad = [candidate.bucketPolicy, otherWriter];
    for (const resource of [
      key,
      `${bucketArn}/native-packages/v1/different-source/another-materialization/manifest.json`,
    ]) {
      assert.equal(decision(pair, { resource }), 'allow');
      assert.equal(
        decision(broad, {
          resource,
          context: {
            'aws:SecureTransport': 'true',
            's3:ObjectCreationOperation': 'true',
            'aws:PrincipalArn': publisherRoleArn,
          },
        }),
        'deny',
      );
      assert.equal(
        decision(broad, {
          resource,
          context: { ...conditions, 's3:x-amz-copy-source': 'source/key' },
        }),
        'deny',
      );
      assert.equal(
        decision(broad, {
          resource,
          context: {
            ...conditions,
            'aws:PrincipalArn': 'arn:aws:iam::123456789012:role/another-writer',
          },
        }),
        'deny',
      );
      for (const action of ['s3:DeleteObject', 's3:DeleteObjectVersion']) {
        assert.equal(decision(broad, { resource, action }), 'deny');
      }
    }
  });
  it('does not exempt header-less PutObject context for multipart-related requests', () => {
    // Operation mappings are documented in native-package-policy-review.md;
    // real S3 context still needs live verification. No multipart exemption.
    const context = {
      ...conditions,
      's3:ObjectCreationOperation': 'false',
    };
    delete context['s3:if-none-match'];
    assert.equal(decision(pair, { context }), 'deny');
  });
  it('never grants the publisher another bucket or an adjacent prefix', () => {
    for (const resource of [
      `${bucketArn}/native-packages/v10/file`,
      `${bucketArn}/other/file`,
      'arn:aws:s3:::other-bucket/native-packages/v1/file',
      bucketArn,
    ]) {
      assert.equal(decision(pair, { resource }), 'implicit-deny');
    }
  });
});

describe('native package policy renderer input boundary', () => {
  for (const invalid of [
    undefined,
    '',
    'https://example.test/bucket',
    `${bucketArn}/prefix`,
    `${bucketArn}\n`,
    'arn:aws:s3:::native-*',
    'arn:aws:s3:::${bucket}',
    'arn:aws:s3:::invalid..bucket',
    'arn:aws:iam::123456789012:role/worker',
  ]) {
    it(`rejects invalid or injectable bucket input: ${JSON.stringify(invalid)}`, async () => {
      await assert.rejects(
        renderNativePackagePolicies({ bucketArn: invalid, publisherRoleArn }),
        /bucket ARN/,
      );
    });
  }
  for (const invalid of [
    undefined,
    null,
    '',
    {},
    bucketArn,
    'arn:aws:iam::123456789012:root',
    'arn:aws:iam::123456789012:user/worker',
    'arn:aws:sts::123456789012:assumed-role/native-package-worker/session',
    'arn:aws:iam:us-east-1:123456789012:role/worker',
    'arn:aws:iam::1234:role/worker',
    'arn:aws:iam::*:role/worker',
    'arn:aws:iam::123456789012:role/',
    'arn:aws:iam::123456789012:role/path/',
    'arn:aws:iam::123456789012:role/path//worker',
    `arn:aws:iam::123456789012:role/${'a'.repeat(65)}`,
    `${publisherRoleArn}*`,
    `${publisherRoleArn}?`,
    `${publisherRoleArn}\n`,
    `${publisherRoleArn}\r\n`,
    `${publisherRoleArn}\u0000`,
    `${publisherRoleArn}"`,
    `${publisherRoleArn}\\`,
    `${publisherRoleArn} \n`,
    'arn:aws:iam::123456789012:role/${bucket_arn}',
    'arn:aws:iam::123456789012:role/%{if true}',
    'arn:aws:iam::123456789012:role/$(whoami)',
    'arn:aws:iam::123456789012:role/`whoami`',
  ]) {
    it(`rejects invalid or injectable publisher input: ${JSON.stringify(invalid)}`, async () => {
      await assert.rejects(
        renderNativePackagePolicies({ bucketArn, publisherRoleArn: invalid }),
        /publisher IAM role ARN/,
      );
    });
  }
  it('requires both inputs and rejects mismatched AWS partitions', async () => {
    await assert.rejects(renderNativePackagePolicies(), /bucket ARN/);
    for (const bucketPartition of ['aws', 'aws-us-gov', 'aws-cn']) {
      for (const rolePartition of ['aws', 'aws-us-gov', 'aws-cn']) {
        if (bucketPartition === rolePartition) continue;
        await assert.rejects(
          renderNativePackagePolicies({
            bucketArn: `arn:${bucketPartition}:s3:::isolated-package-test`,
            publisherRoleArn: `arn:${rolePartition}:iam::123456789012:role/worker`,
          }),
          /bucket partition/,
        );
      }
    }
  });
  it('renders supported AWS partition ARNs without broadening the prefix', async () => {
    for (const partition of ['aws', 'aws-us-gov', 'aws-cn']) {
      const arn = `arn:${partition}:s3:::isolated-package-test`;
      const roleArn = `arn:${partition}:iam::123456789012:role/service-role/imports/worker_+=,.@-`;
      const output = await renderNativePackagePolicies({
        bucketArn: arn,
        publisherRoleArn: roleArn,
      });
      assert.equal(output.publisherPolicy.Statement[0].Resource, `${arn}/native-packages/v1/*`);
      assert.equal(
        output.bucketPolicy.Statement.find(
          (statement) => statement.Sid === 'DenyOtherPackagePublishers',
        )?.Condition.ArnNotEquals['aws:PrincipalArn'],
        roleArn,
      );
      assert.doesNotMatch(JSON.stringify(output), /\$\{|%\{/);
    }
  });
  it('accepts both CLI flags and emits the same unverified JSON', async () => {
    const { stdout, stderr } = await runFile(process.execPath, [
      rendererPath,
      '--bucket-arn',
      bucketArn,
      '--publisher-role-arn',
      publisherRoleArn,
    ]);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), candidate);
  });
  it('rejects missing or unknown CLI inputs without echoing supplied values', async () => {
    for (const args of [
      [],
      ['--bucket-arn', bucketArn],
      ['--publisher-role-arn', publisherRoleArn],
      ['--bucket-arn', bucketArn, '--publisher-role-arn', 'private-invalid-value'],
      ['--bucket-arn', bucketArn, '--publisher-role-arn', publisherRoleArn, '--unexpected'],
    ]) {
      await assert.rejects(runFile(process.execPath, [rendererPath, ...args]), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /--bucket-arn and --publisher-role-arn/);
        assert.doesNotMatch(error.stderr, /private-invalid-value/);
        return true;
      });
    }
  });
  it('documents both required CLI inputs in help without rendering', async () => {
    const { stdout, stderr } = await runFile(process.execPath, [rendererPath, '--help']);
    assert.equal(stderr, '');
    assert.match(stdout, /--bucket-arn/);
    assert.match(stdout, /--publisher-role-arn/);
    assert.match(stdout, /does not apply/);
  });
  it('substitutes only explicitly allowed inputs for each template', async (t) => {
    // Temporary fixtures exercise the actual renderer without changing the
    // repository templates, injecting an I/O hook, or evaluating Terraform.
    const fixture = await mkdtemp(join(tmpdir(), 'native-policy-renderer-'));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const script = join(fixture, 'scripts/render-native-package-policies.mjs');
    const bucketTemplate = join(
      fixture,
      'terraform/modules/data/s3/policies/native-packages-bucket.json.tftpl',
    );
    const publisherTemplate = join(
      fixture,
      'terraform/modules/api/lambda/policies/native-package-publisher.json.tftpl',
    );
    for (const directory of [
      'scripts',
      'terraform/modules/data/s3/policies',
      'terraform/modules/api/lambda/policies',
    ]) {
      await mkdir(join(fixture, directory), { recursive: true });
    }
    await copyFile(rendererPath, script);
    const { renderNativePackagePolicies: renderFixture } = await import(pathToFileURL(script));
    await writeFile(
      bucketTemplate,
      JSON.stringify({ bucket: '${bucket_arn}', publisher: '${publisher_role_arn}' }),
    );
    await writeFile(publisherTemplate, JSON.stringify({ bucket: '${bucket_arn}' }));
    const rendered = await renderFixture({ bucketArn, publisherRoleArn });
    assert.deepEqual(rendered.bucketPolicy, { bucket: bucketArn, publisher: publisherRoleArn });
    assert.deepEqual(rendered.publisherPolicy, { bucket: bucketArn });
    for (const [target, input] of [
      [bucketTemplate, '${unknown}'],
      [bucketTemplate, '${constructor}'],
      [bucketTemplate, '${__proto__}'],
      [bucketTemplate, '${bucket_arn}/remaining-${'],
      [bucketTemplate, '%{if true}'],
      [publisherTemplate, '${publisher_role_arn}'],
    ]) {
      await writeFile(bucketTemplate, '{}');
      await writeFile(publisherTemplate, '{}');
      await writeFile(target, JSON.stringify({ input }));
      await assert.rejects(renderFixture({ bucketArn, publisherRoleArn }), /policy template input/);
    }
  });
});

// Source-contract checks only, not an HCL parser, Terraform graph evaluation,
// or IAM validation. Read the particular resources/attributes so a similarly
// named comment or an unrelated dependency cannot satisfy a safety assertion.
const stripComments = (source) =>
  source.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g, (token) =>
    token.startsWith('"') ? token : token.replace(/[^\n]/g, ' '),
  );
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sourceBlocks = (source, header) => {
  const pattern = header.split(/\s+/).map(escapePattern).join('\\s+');
  const matches = [...source.matchAll(new RegExp(`^\\s*${pattern}\\s*\\{`, 'gm'))];
  return matches.map((match) => {
    const start = match.index + match[0].length;
    let depth = 1;
    for (const token of source.slice(start).matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)) {
      if (token[0] === '{') depth += 1;
      if (token[0] === '}') depth -= 1;
      if (depth === 0) return source.slice(match.index, start + token.index + 1);
    }
    assert.fail(`Unclosed ${header} block`);
  });
};
const sourceBlock = (source, header) => {
  const blocks = sourceBlocks(source, header);
  assert.equal(blocks.length, 1, `Expected one ${header} block`);
  return blocks[0];
};
const lineValue = (source, name) => {
  const matches = [
    ...source.matchAll(new RegExp(`^\\s*${escapePattern(name)}\\s*=\\s*([^\\n]+)`, 'gm')),
  ];
  assert.equal(matches.length, 1, `Expected one ${name} assignment`);
  return matches[0][1].replace(/\s/g, '');
};
const dependencies = (source) => {
  const match = source.match(/^\s*depends_on\s*=\s*\[([\s\S]*?)\]/m);
  assert.ok(match, 'Expected explicit resource dependencies');
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};
const policyInputs = (source, template) => {
  const match = source.match(
    /^\s*policy\s*=\s*templatefile\(\s*"([^"]+)"\s*,\s*\{([\s\S]*?)\}\s*\)\s*$/m,
  );
  assert.ok(match, `Expected policy rendered directly from ${template}`);
  assert.equal(match[1], `\${path.module}/policies/${template}`);
  const inputs = {};
  const rest = match[2].replace(
    /([a-z_]+)\s*=\s*([a-zA-Z0-9_.]+)\s*,?/g,
    (_assignment, name, value) => {
      assert.ok(!Object.hasOwn(inputs, name), `Duplicate template input ${name}`);
      inputs[name] = value;
      return '';
    },
  );
  assert.equal(rest.trim(), '', 'Template inputs must be explicit resource/variable references');
  return inputs;
};
const terraformRoot = new URL('../../terraform/', import.meta.url);
const terraformFiles = (await readdir(terraformRoot, { recursive: true })).filter(
  (name) => name.endsWith('.tf') && !name.split('/').includes('.terraform'),
);
const terraformSources = await Promise.all(
  terraformFiles.map(async (name) => [
    name,
    stripComments(await readFile(new URL(name, terraformRoot), 'utf8')),
  ]),
);
const moduleSource = (sources, directory) =>
  sources
    .filter(([name]) => name.slice(0, name.lastIndexOf('/') + 1) === directory)
    .map(([, source]) => source)
    .join('\n');
const wiringFrom = (sources) => ({
  terraformSources: sources,
  rootSource: moduleSource(sources, ''),
  workerSource: moduleSource(sources, 'modules/api/lambda/'),
  bucketSource: moduleSource(sources, 'modules/data/s3/'),
});
const actualWiring = wiringFrom(terraformSources);
const wiringChecks = [];
const wiringCheck = (name, verify) => {
  wiringChecks.push(verify);
  it(name, () => verify(actualWiring));
};
const assertWiring = (sources) => {
  const wiring = wiringFrom(sources);
  for (const verify of wiringChecks) verify(wiring);
};

describe('native package Terraform wiring contract (static, not deployed qualification)', () => {
  wiringCheck(
    'preserves literal Pipes placeholders and only the three pointer fields',
    ({ workerSource }) => {
      const pipe = sourceBlock(workerSource, 'resource "aws_pipes_pipe" "native_package_jobs"');
      const target = sourceBlock(pipe, 'target_parameters');
      const template = target.match(/^\s*input_template\s*=\s*<<-JSON\n([\s\S]*?)^\s*JSON\s*$/m);
      assert.ok(template, 'Use a literal template; jsonencode escapes Pipes delimiters');
      // Check raw bytes BEFORE parsing JSON, which would hide escaped delimiters.
      // The saved Terraform plan is checked separately; this is not a Pipes emulator.
      assert.doesNotMatch(template[1], /\\u003[ce]/i);
      assert.deepEqual(template[1].match(/<[^>]+>/g)?.toSorted(), [
        '<$.dynamodb.Keys.jobId.S>',
        '<$.dynamodb.Keys.projectId.S>',
      ]);
      assert.deepEqual(JSON.parse(template[1]), {
        schemaVersion: 1,
        projectId: '<$.dynamodb.Keys.projectId.S>',
        jobId: '<$.dynamodb.Keys.jobId.S>',
      });
    },
  );
  wiringCheck(
    'renders the bucket fence using the dedicated bucket and worker-role input',
    ({ bucketSource, rootSource }) => {
      const policy = sourceBlock(bucketSource, 'resource "aws_s3_bucket_policy" "native_packages"');
      assert.equal(lineValue(policy, 'bucket'), 'aws_s3_bucket.native_packages.id');
      assert.deepEqual(policyInputs(policy, 'native-packages-bucket.json.tftpl'), {
        bucket_arn: 'aws_s3_bucket.native_packages.arn',
        publisher_role_arn: 'var.native_package_publisher_role_arn',
      });
      const input = sourceBlock(bucketSource, 'variable "native_package_publisher_role_arn"');
      assert.equal(lineValue(input, 'type'), 'string');
      assert.equal(lineValue(input, 'nullable'), 'false');
      assert.doesNotMatch(input, /^\s*default\s*=/m, 'The isolated publisher must be explicit');
      const s3Module = sourceBlock(rootSource, 'module "s3"');
      assert.equal(
        lineValue(s3Module, 'native_package_publisher_role_arn'),
        'module.lambda.native_package_worker_role_arn',
      );
    },
  );
  wiringCheck(
    'exports the worker role independently of the bucket and publisher grant',
    ({ workerSource, rootSource }) => {
      const output = sourceBlock(workerSource, 'output "native_package_worker_role_arn"');
      assert.equal(lineValue(output, 'value'), 'aws_iam_role.native_package_worker.arn');
      assert.doesNotMatch(output, /^\s*depends_on\s*=/m);
      const role = sourceBlock(workerSource, 'resource "aws_iam_role" "native_package_worker"');
      assert.doesNotMatch(role, /native_packages_bucket|native_package_publisher|depends_on/);
      // Module-wide dependencies on either side would defeat the fine-grained
      // role -> bucket protections -> publisher grant ordering and risk a cycle.
      for (const name of ['s3', 'lambda']) {
        assert.doesNotMatch(sourceBlock(rootSource, `module "${name}"`), /^\s*depends_on\s*=/m);
      }
    },
  );
  wiringCheck(
    'waits for bucket protections before exposing the ARN consumed by the publisher',
    ({ bucketSource, rootSource }) => {
      const output = sourceBlock(bucketSource, 'output "native_packages_bucket_arn"');
      assert.equal(lineValue(output, 'value'), 'aws_s3_bucket.native_packages.arn');
      const required = [
        'aws_s3_bucket_policy.native_packages',
        'aws_s3_bucket_versioning.native_packages',
        'aws_s3_bucket_ownership_controls.native_packages',
        'aws_s3_bucket_server_side_encryption_configuration.native_packages',
        'aws_s3_bucket_public_access_block.native_packages',
      ];
      for (const resource of required) {
        assert.ok(dependencies(output).includes(resource), `ARN output must wait for ${resource}`);
        const [type, name] = resource.split('.');
        assert.equal(
          lineValue(sourceBlock(bucketSource, `resource "${type}" "${name}"`), 'bucket'),
          'aws_s3_bucket.native_packages.id',
        );
      }
      assert.equal(
        lineValue(
          sourceBlock(bucketSource, 'resource "aws_s3_bucket_versioning" "native_packages"'),
          'status',
        ),
        '"Enabled"',
      );
      assert.equal(
        lineValue(
          sourceBlock(
            bucketSource,
            'resource "aws_s3_bucket_ownership_controls" "native_packages"',
          ),
          'object_ownership',
        ),
        '"BucketOwnerEnforced"',
      );
      const access = sourceBlock(
        bucketSource,
        'resource "aws_s3_bucket_public_access_block" "native_packages"',
      );
      for (const flag of [
        'block_public_acls',
        'block_public_policy',
        'ignore_public_acls',
        'restrict_public_buckets',
      ]) {
        assert.equal(lineValue(access, flag), 'true');
      }
      const lambdaModule = sourceBlock(rootSource, 'module "lambda"');
      assert.equal(
        lineValue(lambdaModule, 'native_packages_bucket_arn'),
        'module.s3.native_packages_bucket_arn',
      );
    },
  );
  wiringCheck(
    'attaches the conditional publisher template only to the worker and waits before Lambda creation',
    ({ workerSource, bucketSource, terraformSources: sources }) => {
      const publisher = sourceBlock(
        workerSource,
        'resource "aws_iam_role_policy" "native_package_publisher"',
      );
      assert.equal(lineValue(publisher, 'role'), 'aws_iam_role.native_package_worker.id');
      assert.deepEqual(policyInputs(publisher, 'native-package-publisher.json.tftpl'), {
        bucket_arn: 'var.native_packages_bucket_arn',
      });
      const worker = sourceBlock(workerSource, 'module "native_package_worker_lambda"');
      assert.equal(lineValue(worker, 'create_role'), 'false');
      assert.equal(lineValue(worker, 'lambda_role'), 'aws_iam_role.native_package_worker.arn');
      assert.ok(dependencies(worker).includes('aws_iam_role_policy.native_package_publisher'));
      assert.ok(dependencies(worker).includes('aws_iam_role_policy.native_package_worker'));
      assert.ok(dependencies(worker).includes('terraform_data.native_package_jobs_configuration'));
      const bucketPolicy = sourceBlock(
        bucketSource,
        'resource "aws_s3_bucket_policy" "native_packages"',
      );
      const remainder = sources
        .map(([, source]) => source)
        .join('\n')
        .replace(publisher, '')
        .replace(bucketPolicy, '');
      assert.doesNotMatch(
        remainder,
        /native-package-publisher\.json\.tftpl|native-packages-bucket\.json\.tftpl/,
        'Neither template may be reused on an unrelated role or bucket',
      );
    },
  );
  wiringCheck(
    'keeps the worker read grant on the protected package namespace and role',
    ({ workerSource }) => {
      const policy = sourceBlock(
        workerSource,
        'resource "aws_iam_role_policy" "native_package_worker"',
      );
      assert.equal(lineValue(policy, 'role'), 'aws_iam_role.native_package_worker.id');
      const statements = [
        ...policy.matchAll(/\{\s*Sid\s*=\s*"ReadPinnedPrivatePackages"[^{}]*\}/g),
      ];
      assert.equal(statements.length, 1, 'Expected a dedicated package read statement');
      const statement = statements[0][0];
      assert.equal(lineValue(statement, 'Effect'), '"Allow"');
      assert.deepEqual(JSON.parse(lineValue(statement, 'Action')).toSorted(), [
        's3:GetObject',
        's3:GetObjectVersion',
      ]);
      assert.equal(lineValue(statement, 'Resource'), 'local.native_package_archive_objects_arn');
      assert.equal(
        lineValue(workerSource, 'native_package_archive_objects_arn'),
        '"${var.native_packages_bucket_arn}/native-packages/v1/*"',
      );
      assert.doesNotMatch(
        policy.replace(statement, ''),
        /"s3:/,
        'The worker base policy must not add another S3 grant',
      );
    },
  );
  wiringCheck(
    'keeps both feature defaults and host qualification false at root and module boundaries',
    ({ rootSource, workerSource }) => {
      const lambdaModule = sourceBlock(rootSource, 'module "lambda"');
      for (const flag of [
        'enable_native_workflow_sources',
        'enable_native_package_jobs',
        'native_package_jobs_host_qualified',
      ]) {
        for (const source of [rootSource, workerSource]) {
          assert.equal(lineValue(sourceBlock(source, `variable "${flag}"`), 'default'), 'false');
        }
        assert.equal(lineValue(lambdaModule, flag), `var.${flag}`);
      }
    },
  );
  wiringCheck(
    'requires dev storage qualification, enablement, and host readiness for dispatch and both services',
    ({ workerSource }) => {
      assert.equal(
        lineValue(workerSource, 'native_package_upload_policy_qualified'),
        'var.environment=="dev"',
      );
      assert.deepEqual(
        lineValue(workerSource, 'native_package_jobs_active').split('&&').toSorted(),
        [
          'var.enable_native_package_jobs',
          'var.native_package_jobs_host_qualified',
          'local.native_package_upload_policy_qualified',
        ].toSorted(),
      );
      const configuration = sourceBlock(
        workerSource,
        'resource "terraform_data" "native_package_jobs_configuration"',
      );
      assert.doesNotMatch(configuration, /^\s*(?:count|for_each)\s*=/m);
      const preconditions = sourceBlocks(sourceBlock(configuration, 'lifecycle'), 'precondition');
      assert.ok(
        preconditions.some(
          (block) =>
            lineValue(block, 'condition').split('||').toSorted().join('||') ===
            '!var.enable_native_package_jobs||var.native_package_jobs_host_qualified',
        ),
        'Host readiness must be enforced inside an actual lifecycle precondition',
      );
      assert.ok(
        preconditions.some(
          (block) =>
            lineValue(block, 'condition').split('||').toSorted().join('||') ===
            '!var.enable_native_package_jobs||local.native_package_upload_policy_qualified',
        ),
        'Qualification must be enforced inside an actual lifecycle precondition',
      );
      assert.equal(
        lineValue(
          sourceBlock(workerSource, 'resource "aws_pipes_pipe" "native_package_jobs"'),
          'count',
        ),
        'local.native_package_jobs_active?1:0',
      );
      assert.equal(
        lineValue(
          sourceBlock(
            workerSource,
            'resource "aws_lambda_event_source_mapping" "native_package_jobs"',
          ),
          'enabled',
        ),
        'local.native_package_jobs_active',
      );
      assert.equal(
        lineValue(
          sourceBlock(workerSource, 'module "native_package_worker_lambda"'),
          'NATIVE_PACKAGE_JOBS_ENABLED',
        ),
        'tostring(local.native_package_jobs_active)',
      );
      assert.equal(
        lineValue(
          sourceBlock(workerSource, 'native_package_jobs_api_environment ='),
          'NATIVE_PACKAGE_JOBS_ENABLED',
        ),
        'tostring(local.native_package_jobs_active)',
      );
      const api = sourceBlock(workerSource, 'module "workflow_sources_lambda"');
      assert.match(
        api,
        /environment_variables\s*=\s*merge\(\s*local\.native_package_jobs_api_environment\s*,\s*\{[^{}]*\}\s*\)/,
      );
      assert.doesNotMatch(
        api,
        /NATIVE_PACKAGE_JOBS_ENABLED/,
        'API environment merge must not override the shared activation flag',
      );
    },
  );
});

describe('native package contract mutations (in memory only)', () => {
  it('detects removal or weakening of each object-creation guard independently', () => {
    const mutations = [
      [
        'publisher operation guard removed',
        'false',
        ({ publisherPolicy }) => {
          delete publisherPolicy.Statement[0].Condition.Bool['s3:ObjectCreationOperation'];
        },
      ],
      [
        'publisher operation guard accepts a missing key',
        undefined,
        ({ publisherPolicy }) => {
          const condition = publisherPolicy.Statement[0].Condition;
          delete condition.Bool['s3:ObjectCreationOperation'];
          condition.BoolIfExists = { 's3:ObjectCreationOperation': 'true' };
        },
      ],
      [
        'bucket operation deny removed',
        'false',
        ({ bucketPolicy }) => {
          bucketPolicy.Statement = bucketPolicy.Statement.filter(
            (statement) => statement.Sid !== 'DenyNonCreationPackageWrites',
          );
        },
      ],
      [
        'bucket operation deny weakened to Bool',
        undefined,
        ({ bucketPolicy }) => {
          bucketPolicy.Statement.find(
            (statement) => statement.Sid === 'DenyNonCreationPackageWrites',
          ).Condition = { Bool: { 's3:ObjectCreationOperation': 'false' } };
        },
      ],
    ];
    for (const [name, operation, mutate] of mutations) {
      assertObjectCreationGuard(candidate, operation);
      const changed = structuredClone(candidate);
      mutate(changed);
      assert.throws(
        () => assertObjectCreationGuard(changed, operation),
        { code: 'ERR_ASSERTION' },
        name,
      );
    }
  });
  it('detects principal, deny, namespace, and ambient-allow regressions in the rendered policies', () => {
    const mutations = [
      [
        'missing publisher deny',
        (policy) => {
          policy.bucketPolicy.Statement = policy.bucketPolicy.Statement.filter(
            (statement) => statement.Sid !== 'DenyOtherPackagePublishers',
          );
        },
      ],
      ...[
        ['publisher deny changed to allow', 'Effect', 'Allow'],
        ['narrowed deny principal', 'Principal', { AWS: publisherRoleArn }],
        ['narrowed deny namespace', 'Resource', `${bucketArn}/native-packages/v1/source/*`],
        ['broadened deny namespace', 'Resource', `${bucketArn}/*`],
        [
          'wrong publisher exception',
          'Condition',
          {
            ArnNotEquals: {
              'aws:PrincipalArn': 'arn:aws:iam::123456789012:role/application-agent',
            },
          },
        ],
      ].map(([name, field, value]) => [
        name,
        (policy) => {
          policy.bucketPolicy.Statement.find(
            (statement) => statement.Sid === 'DenyOtherPackagePublishers',
          )[field] = value;
        },
      ]),
      [
        'broadened publisher grant',
        (policy) => {
          policy.publisherPolicy.Statement[0].Resource = `${bucketArn}/*`;
        },
      ],
      [
        'missing publisher allow',
        (policy) => {
          policy.publisherPolicy.Statement[0].Effect = 'Deny';
        },
      ],
      [
        'ambient bucket allow',
        (policy) => {
          policy.bucketPolicy.Statement.push({ ...otherWriter.Statement[0], Principal: '*' });
        },
      ],
    ];
    assertPublisherFence(candidate);
    for (const [name, mutate] of mutations) {
      const changed = structuredClone(candidate);
      mutate(changed);
      assert.throws(() => assertPublisherFence(changed), { code: 'ERR_ASSERTION' }, name);
    }
    const reordered = structuredClone(candidate);
    reordered.bucketPolicy.Statement.reverse();
    assertPublisherFence(reordered);
  });

  const workerFile = 'modules/api/lambda/native-package-jobs.tf';
  const bucketFile = 'modules/data/s3/native-packages.tf';
  const rewriteValue = (source, name, value) => {
    lineValue(source, name); // Assert that the mutation has one real target.
    return source.replace(
      new RegExp(`^(\\s*${escapePattern(name)}\\s*=\\s*)[^\\n]+`, 'm'),
      (_line, prefix) => `${prefix}${value}`,
    );
  };
  const within = (header, rewrite) => (source) => {
    const block = sourceBlock(source, header);
    const changed = rewrite(block);
    assert.notEqual(changed, block, `Mutation must change ${header}`);
    return source.replace(block, () => changed);
  };
  const withMutation = (file, rewrite) => {
    assert.ok(
      terraformSources.some(([name]) => name === file),
      file,
    );
    return terraformSources.map(([name, source]) => {
      if (name !== file) return [name, source];
      const changed = rewrite(source);
      assert.notEqual(changed, source, `Mutation must change ${file}`);
      return [name, changed];
    });
  };
  const mutations = [
    [
      'escaped Pipes placeholder delimiters',
      workerFile,
      within('resource "aws_pipes_pipe" "native_package_jobs"', (block) =>
        block.replaceAll('<$.', '\\u003c$.').replaceAll('.S>', '.S\\u003e'),
      ),
    ],
    [
      'jsonencode reintroduced around Pipes placeholders',
      workerFile,
      within('resource "aws_pipes_pipe" "native_package_jobs"', (block) =>
        block.replace(
          /input_template\s*=\s*<<-JSON\n[\s\S]*?^\s*JSON\s*$/m,
          `input_template = jsonencode({
            schemaVersion = 1
            projectId = "<$.dynamodb.Keys.projectId.S>"
            jobId = "<$.dynamodb.Keys.jobId.S>"
          })`,
        ),
      ),
    ],
    [
      'publisher role substitution',
      workerFile,
      within('resource "aws_iam_role_policy" "native_package_publisher"', (block) =>
        rewriteValue(block, 'role', 'aws_iam_role.workflow_sources.id'),
      ),
    ],
    [
      'publisher bypasses protected ARN input',
      workerFile,
      within('resource "aws_iam_role_policy" "native_package_publisher"', (block) =>
        rewriteValue(block, 'bucket_arn', 'var.artifacts_bucket_arn'),
      ),
    ],
    [
      'read grant role substitution',
      workerFile,
      within('resource "aws_iam_role_policy" "native_package_worker"', (block) =>
        rewriteValue(block, 'role', 'aws_iam_role.workflow_sources.id'),
      ),
    ],
    [
      'read grant namespace widened',
      workerFile,
      (source) =>
        rewriteValue(
          source,
          'native_package_archive_objects_arn',
          '"${var.native_packages_bucket_arn}/*"',
        ),
    ],
    [
      'read statement bypasses protected ARN',
      workerFile,
      (source) =>
        source.replace(
          /Resource\s*=\s*local\.native_package_archive_objects_arn/,
          'Resource = var.artifacts_bucket_arn',
        ),
    ],
    [
      'storage qualification unconditionally enabled',
      workerFile,
      (source) => rewriteValue(source, 'native_package_upload_policy_qualified', 'true'),
    ],
    ...['var.environment != "prod"', 'var.environment == "prod"'].map((expression) => [
      `storage qualification admits non-dev environments: ${expression}`,
      workerFile,
      (source) => rewriteValue(source, 'native_package_upload_policy_qualified', expression),
    ]),
    ...['enable_native_package_jobs', 'native_package_jobs_host_qualified'].map((flag) => [
      `active expression drops ${flag}`,
      workerFile,
      (source) =>
        rewriteValue(
          source,
          'native_package_jobs_active',
          lineValue(source, 'native_package_jobs_active')
            .split('&&')
            .filter((term) => term !== `var.${flag}`)
            .join(' && '),
        ),
    ]),
    [
      'active expression drops qualification',
      workerFile,
      (source) =>
        rewriteValue(
          source,
          'native_package_jobs_active',
          'var.enable_native_package_jobs && var.native_package_jobs_host_qualified',
        ),
    ],
    [
      'qualification moved out of precondition',
      workerFile,
      (source) =>
        source.replace(
          /precondition\s*\{(\s*condition\s*=\s*!var\.enable_native_package_jobs\s*\|\|\s*local\.native_package_upload_policy_qualified)/,
          (_match, body) => `postcondition {${body}`,
        ),
    ],
    [
      'host readiness moved out of precondition',
      workerFile,
      (source) =>
        source.replace(
          /precondition\s*\{(\s*condition\s*=\s*!var\.enable_native_package_jobs\s*\|\|\s*var\.native_package_jobs_host_qualified)/,
          (_match, body) => `postcondition {${body}`,
        ),
    ],
    [
      'qualification resource disabled',
      workerFile,
      within('resource "terraform_data" "native_package_jobs_configuration"', (block) =>
        block.replace('{', '{\n  count = 0'),
      ),
    ],
    [
      'API environment overrides shared gate',
      'modules/api/lambda/workflow-sources.tf',
      (source) =>
        source.replace(
          'merge(local.native_package_jobs_api_environment, {',
          'merge(local.native_package_jobs_api_environment, {\n    NATIVE_PACKAGE_JOBS_ENABLED = "true"',
        ),
    ],
    [
      'root wiring bypasses protected ARN output',
      'main.tf',
      within('module "lambda"', (block) =>
        rewriteValue(block, 'native_packages_bucket_arn', 'module.s3.artifacts_bucket_arn'),
      ),
    ],
    [
      'role export depends on publisher grant',
      workerFile,
      within('output "native_package_worker_role_arn"', (block) =>
        block.replace('{', '{\n  depends_on = [aws_iam_role_policy.native_package_publisher]'),
      ),
    ],
    ...[
      'aws_s3_bucket_policy.native_packages',
      'aws_s3_bucket_versioning.native_packages',
      'aws_s3_bucket_ownership_controls.native_packages',
      'aws_s3_bucket_server_side_encryption_configuration.native_packages',
      'aws_s3_bucket_public_access_block.native_packages',
    ].map((dependency) => [
      `bucket ARN loses dependency on ${dependency}`,
      bucketFile,
      within('output "native_packages_bucket_arn"', (block) => block.replace(`${dependency},`, '')),
    ]),
    ...[
      'aws_iam_role_policy.native_package_publisher',
      'aws_iam_role_policy.native_package_worker',
      'terraform_data.native_package_jobs_configuration',
    ].map((dependency) => [
      `Lambda loses dependency on ${dependency}`,
      workerFile,
      within('module "native_package_worker_lambda"', (block) =>
        block.replace(`${dependency},`, ''),
      ),
    ]),
  ];
  for (const [name, file, rewrite] of mutations) {
    it(`rejects ${name}`, () => {
      const changed = withMutation(file, rewrite);
      assert.throws(() => assertWiring(changed), { code: 'ERR_ASSERTION' }, name);
    });
  }
  it('accepts reordered dependencies and conjunctions without changing the protection contract', () => {
    const reordered = terraformSources.map(([name, source]) => {
      if (name !== workerFile && name !== bucketFile) return [name, source];
      let changed = source.replace(
        /(depends_on\s*=\s*\[)([\s\S]*?)(\])/g,
        (_match, prefix, body, suffix) => {
          const entries = body
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
          return `${prefix}\n${entries.toReversed().join(',\n')},\n${suffix}`;
        },
      );
      if (name === workerFile) {
        changed = rewriteValue(
          changed,
          'native_package_jobs_active',
          lineValue(changed, 'native_package_jobs_active').split('&&').toReversed().join(' && '),
        );
      }
      return [name, changed];
    });
    assertWiring(reordered);
  });
});
