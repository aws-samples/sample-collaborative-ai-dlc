#!/usr/bin/env node
// Offline rendering only. This command does not apply the policies or qualify
// their deployed behavior. No AWS API or credentials are used.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const BUCKET_ARN = /^arn:(aws|aws-us-gov|aws-cn):s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PUBLISHER_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/(?:[A-Za-z0-9_+=,.@-]+\/)*[A-Za-z0-9_+=,.@-]{1,64}$/;
const templates = {
  bucketPolicy: {
    path: new URL(
      '../terraform/modules/data/s3/policies/native-packages-bucket.json.tftpl',
      import.meta.url,
    ),
    inputs: ['bucket_arn', 'publisher_role_arn'],
  },
  publisherPolicy: {
    path: new URL(
      '../terraform/modules/api/lambda/policies/native-package-publisher.json.tftpl',
      import.meta.url,
    ),
    inputs: ['bucket_arn'],
  },
};

export const renderNativePackagePolicies = async ({ bucketArn, publisherRoleArn } = {}) => {
  const bucketMatch = typeof bucketArn === 'string' && BUCKET_ARN.exec(bucketArn);
  if (!bucketMatch || bucketMatch[0] !== bucketArn || bucketArn.includes('..'))
    throw new Error('A native package bucket ARN is required');
  const roleMatch =
    typeof publisherRoleArn === 'string' && PUBLISHER_ROLE_ARN.exec(publisherRoleArn);
  if (!roleMatch || roleMatch[0] !== publisherRoleArn || roleMatch[1] !== bucketMatch[1])
    throw new Error('A publisher IAM role ARN in the bucket partition is required');
  const inputs = { bucket_arn: bucketArn, publisher_role_arn: publisherRoleArn };
  const documents = await Promise.all(
    Object.entries(templates).map(async ([key, { path, inputs: allowedInputs }]) => {
      const template = await readFile(path, 'utf8');
      const rendered = template.replace(/\$\{([^}]+)\}/g, (_match, name) => {
        if (!allowedInputs.includes(name)) throw new Error('Unsupported policy template input');
        return inputs[name];
      });
      if (rendered.includes('${') || rendered.includes('%{'))
        throw new Error('Unresolved policy template input');
      return [key, JSON.parse(rendered)];
    }),
  );
  return {
    schemaVersion: 1,
    qualification: 'unverified',
    // A local policy/context test does not establish which context keys S3
    // supplies for each API, nor validate the provider's deployed behavior.
    // Documentation evidence: docs/development/native-package-policy-review.md.
    requiredChecks: [
      'Live S3 condition-key and multipart/copy semantics (documentation reviewed 2026-09-21)',
      'Terraform and IAM policy validation',
      'Disposable live positive and negative upload tests',
      'Worker-only wiring and deployed role isolation',
    ],
    ...Object.fromEntries(documents),
  };
};

const main = async () => {
  try {
    const { values } = parseArgs({
      options: {
        'bucket-arn': { type: 'string' },
        'publisher-role-arn': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      process.stdout.write(
        'Render unverified native package policies locally; does not apply them.\n\nnode scripts/render-native-package-policies.mjs --bucket-arn arn:aws:s3:::native-package-bucket --publisher-role-arn arn:aws:iam::123456789012:role/native-package-worker\n',
      );
      return;
    }
    const result = await renderNativePackagePolicies({
      bucketArn: values['bucket-arn'],
      publisherRoleArn: values['publisher-role-arn'],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch {
    process.stderr.write(
      'Unable to render native package policies. Supply --bucket-arn and --publisher-role-arn for the isolated bucket and worker role in the same partition.\n',
    );
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
