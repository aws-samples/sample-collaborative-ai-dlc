#!/usr/bin/env node
// Operator control for the disposable dev experiment. No automatic answer,
// polling loop, deployment, or model credentials on the operator's machine.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const { values } = parseArgs({
  options: {
    profile: { type: 'string' },
    region: { type: 'string', default: 'us-east-1' },
    'expected-account': { type: 'string' },
    function: { type: 'string', default: 'collaborative-ai-dlc-agents-dev' },
    action: { type: 'string' },
    harness: { type: 'string' },
    'probe-id': { type: 'string' },
  },
});
if (
  !values.profile ||
  !/^\d{12}$/.test(values['expected-account'] || '') ||
  !['start', 'status', 'answer', 'cancel'].includes(values.action) ||
  !['claude', 'codex', 'kiro', 'opencode'].includes(values.harness) ||
  !/^[A-Za-z0-9_-]+-agents-dev$/.test(values.function) ||
  (values.action !== 'start' && !values['probe-id'])
) {
  console.error(
    'Required: --profile NAME --expected-account 123456789012 --action start|status|answer|cancel --harness claude|codex|kiro|opencode [--probe-id UUID]. Answer sends only the fixed test title "Blue Lake".',
  );
  process.exit(2);
}
const probeId = values['probe-id'] || randomUUID();
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(probeId)) {
  throw new Error('probe-id must be a lowercase UUID v4');
}
const exec = promisify(execFile);
const aws = async (args) =>
  exec('aws', ['--profile', values.profile, '--region', values.region, '--no-cli-pager', ...args], {
    env: { ...process.env, AWS_PAGER: '' },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
const identity = JSON.parse((await aws(['sts', 'get-caller-identity', '--output', 'json'])).stdout);
if (identity.Account !== values['expected-account'])
  throw new Error('AWS account does not match the explicit expected account');
const directory = await mkdtemp(join(tmpdir(), 'aidlc-native-interaction-'));
const inputPath = join(directory, 'request.json');
const outputPath = join(directory, 'response.json');
await writeFile(
  inputPath,
  JSON.stringify({
    operation: 'native-interaction-probe',
    action: values.action,
    harness: values.harness,
    probeId,
  }),
  { flag: 'wx', mode: 0o600 },
);
await writeFile(outputPath, '', { flag: 'wx', mode: 0o600 });
const invoked = JSON.parse(
  (
    await aws([
      'lambda',
      'invoke',
      '--function-name',
      values.function,
      '--cli-binary-format',
      'raw-in-base64-out',
      '--payload',
      `file://${inputPath}`,
      outputPath,
    ])
  ).stdout,
);
if (invoked.FunctionError) throw new Error(`Lambda failed; private response: ${outputPath}`);
const report = JSON.parse(await readFile(outputPath, 'utf8'));
console.log(
  JSON.stringify(
    {
      probeId,
      harness: values.harness,
      action: values.action,
      status: report.status,
      ok: report.ok,
      reason: report.reason || report.code || report.failure,
      resumable: report.resumable,
      qualification: report.qualification,
      assistantText: report.turns?.at(-1)?.assistantText,
      evidenceFile: outputPath,
    },
    null,
    2,
  ),
);
if (!report.ok || report.status === 'FAILED') process.exitCode = 1;
