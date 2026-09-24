import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateBedrockIamSetup } from '../bedrock-iam.js';

const setup = generateBedrockIamSetup({
  brokerRoleArn: 'arn:aws:iam::111111111111:role/collaborative-broker',
  config: {
    roleArn: 'arn:aws:iam::222222222222:role/teams/BedrockInference',
    region: 'eu-west-1',
    externalId: 'collaborative-space-one',
  },
});
const existingTrust = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: ['arn:aws:iam::222222222222:role/dev-broker'] },
      Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'sts:ExternalId': 'existing-deployment' } },
    },
    {
      Effect: 'Deny',
      Principal: '*',
      Action: 'sts:AssumeRole',
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    },
  ],
};

// Execute the generated text in real Bash, with a fake AWS CLI recording every
// call. No AWS credentials or network access are used by these commands.
const runSetup = ({
  commands,
  account = '222222222222',
  failure = '',
  interactive = true,
  trustPolicy = existingTrust,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'bedrock-iam-shell-'));
  const callsPath = join(directory, 'calls.jsonl');
  const statePath = join(directory, 'state.json');
  try {
    writeFileSync(callsPath, '');
    writeFileSync(
      statePath,
      JSON.stringify({
        trustPolicy,
        policies: { 'BedrockInference/ExistingInferencePolicy': { existing: 'unchanged' } },
      }),
    );
    writeFileSync(
      join(directory, 'aws'),
      `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const argument = name => args[args.indexOf(name) + 1];
appendFileSync(process.env.IAM_TEST_CALLS, JSON.stringify({
  args, pager: process.env.AWS_PAGER, autoPrompt: process.env.AWS_CLI_AUTO_PROMPT
}) + '\\n');
if (args[1] === process.env.IAM_TEST_FAILURE) {
  console.error(args[1] === 'create-role'
    ? 'An error occurred (EntityAlreadyExists): Role with name BedrockInference already exists.'
    : 'An error occurred (AccessDenied): denied ' + args[1]);
  process.exit(254);
}
if (args[1] === 'get-caller-identity') console.log(process.env.IAM_TEST_ACCOUNT);
if (args[1] === 'create-role') console.log('arn:aws:iam::222222222222:role/teams/BedrockInference');
const state = JSON.parse(readFileSync(process.env.IAM_TEST_STATE, 'utf8'));
if (args[1] === 'get-role') console.log(JSON.stringify(state.trustPolicy));
if (args[1] === 'update-assume-role-policy') {
  state.trustPolicy = JSON.parse(argument('--policy-document'));
}
if (args[1] === 'put-role-policy') {
  state.policies[argument('--role-name') + '/' + argument('--policy-name')] =
    JSON.parse(argument('--policy-document'));
}
writeFileSync(process.env.IAM_TEST_STATE, JSON.stringify(state));
`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      '/bin/bash',
      ['--noprofile', '--norc', ...(interactive ? ['-i'] : [])],
      {
        input: interactive
          ? `set -eu
${commands}
printf '\\nPARENT_ALIVE\\nPARENT_FLAGS=%s\\nPARENT_PAGER=%s\\nPARENT_PROMPT=%s\\n' "$-" "$AWS_PAGER" "$AWS_CLI_AUTO_PROMPT"
`
          : commands,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          BASH_ENV: '',
          PS1: '',
          PS2: '',
          PROMPT_COMMAND: '',
          AWS_PAGER: 'parent-pager',
          AWS_CLI_AUTO_PROMPT: 'on',
          IAM_TEST_CALLS: callsPath,
          IAM_TEST_STATE: statePath,
          IAM_TEST_ACCOUNT: account,
          IAM_TEST_FAILURE: failure,
        },
      },
    );
    if (result.error) throw result.error;
    const calls = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { ...result, calls, state: JSON.parse(readFileSync(statePath, 'utf8')) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const expectInteractiveShellSurvives = (result) => {
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('\nPARENT_ALIVE\n');
  const flags = result.stdout.match(/PARENT_FLAGS=(\w+)/)?.[1];
  expect(flags).toContain('e');
  expect(flags).toContain('u');
  expect(result.stdout).toContain('PARENT_PAGER=parent-pager');
  expect(result.stdout).toContain('PARENT_PROMPT=on');
  for (const call of result.calls) {
    expect(call.pager).toBe('');
    expect(call.autoPrompt).toBe('off');
  }
};

describe('generated Bedrock IAM CloudShell commands', () => {
  it('preserves a create-role error and stops before writing permissions without closing CloudShell', () => {
    const result = runSetup({ commands: setup.inferenceCommands, failure: 'create-role' });
    expectInteractiveShellSurvives(result);
    expect(result.stderr).toContain('An error occurred (EntityAlreadyExists)');
    expect(result.stderr).toContain('setup failed during: Creating new role BedrockInference');
    expect(result.stderr).toContain('(exit 254)');
    expect(result.stdout).toContain('I already have an inference role');
    expect(result.stdout).not.toContain('setup completed');
    expect(result.calls.map(({ args }) => args[1])).toEqual(['get-caller-identity', 'create-role']);
  });

  it('retains the STS error without misreporting it as a wrong account', () => {
    const result = runSetup({
      commands: setup.inferenceCommands,
      failure: 'get-caller-identity',
    });
    expectInteractiveShellSurvives(result);
    expect(result.stderr).toContain('An error occurred (AccessDenied): denied get-caller-identity');
    expect(result.stderr).toContain('setup failed during: Checking AWS account (exit 254)');
    expect(result.stdout).not.toContain('Wrong AWS account');
    expect(result.calls).toHaveLength(1);
  });

  it('shows the actual and expected accounts and performs no IAM writes in the wrong account', () => {
    const result = runSetup({ commands: setup.inferenceCommands, account: '333333333333' });
    expectInteractiveShellSurvives(result);
    expect(result.stderr).toContain('Wrong AWS account: 333333333333. Expected 222222222222.');
    expect(result.calls).toHaveLength(1);
  });

  it.each([
    { commands: setup.inferenceCommands, account: '222222222222', count: 3 },
    { commands: setup.applicationCommands, account: '111111111111', count: 2 },
  ])('keeps policy-write errors visible in either account', ({ commands, account, count }) => {
    const result = runSetup({ commands, account, failure: 'put-role-policy' });
    expectInteractiveShellSurvives(result);
    expect(result.stderr).toContain('An error occurred (AccessDenied): denied put-role-policy');
    expect(result.stderr).toContain('Bedrock IAM setup failed during:');
    expect(result.stdout).not.toContain('setup completed');
    expect(result.calls).toHaveLength(count);
  });

  it.each([
    { commands: setup.inferenceCommands, account: '222222222222' },
    { commands: setup.applicationCommands, account: '111111111111' },
  ])('returns failure when downloaded and run noninteractively', ({ commands, account }) => {
    const result = runSetup({
      commands,
      account,
      failure: 'put-role-policy',
      interactive: false,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('An error occurred (AccessDenied)');
    expect(result.stdout).not.toContain('setup completed');
  });

  it('passes complete valid JSON policies, role paths, and wildcards to the AWS CLI', () => {
    const result = runSetup({ commands: setup.inferenceCommands });
    expectInteractiveShellSurvives(result);
    expect(result.stdout).toContain('Bedrock IAM setup completed.');
    expect(result.calls).toHaveLength(3);
    const createArgs = result.calls[1].args;
    expect(createArgs[createArgs.indexOf('--path') + 1]).toBe('/teams/');
    expect(JSON.parse(createArgs[createArgs.indexOf('--assume-role-policy-document') + 1])).toEqual(
      setup.trustPolicy,
    );
    const policyArgs = result.calls[2].args;
    const policy = JSON.parse(policyArgs[policyArgs.indexOf('--policy-document') + 1]);
    expect(policy).toEqual(setup.inferencePolicy);
    expect(policy.Statement.find(({ Sid }) => Sid === 'CodexProjectDiscovery').Resource).toBe('*');
  });

  it('writes the exact broker permission and reports success in the application account', () => {
    const result = runSetup({
      commands: setup.applicationCommands,
      account: '111111111111',
    });
    expectInteractiveShellSurvives(result);
    expect(result.stdout).toContain('Bedrock IAM setup completed.');
    expect(result.calls).toHaveLength(2);
    const args = result.calls[1].args;
    expect(args[args.indexOf('--role-name') + 1]).toBe('collaborative-broker');
    expect(JSON.parse(args[args.indexOf('--policy-document') + 1])).toEqual(setup.assumeRolePolicy);
  });

  it('reuses a role across accounts while preserving existing trust, conditions, denies and policies', () => {
    const result = runSetup({ commands: setup.reuseCommands });
    expectInteractiveShellSurvives(result);
    expect(result.calls.map(({ args }) => args[1])).toEqual([
      'get-caller-identity',
      'get-role',
      'update-assume-role-policy',
      'put-role-policy',
    ]);
    expect(result.state.trustPolicy).toEqual({
      ...existingTrust,
      Statement: [...existingTrust.Statement, ...setup.trustPolicy.Statement],
    });
    expect(result.state.policies['BedrockInference/ExistingInferencePolicy']).toEqual({
      existing: 'unchanged',
    });
    const newPolicy = Object.entries(result.state.policies).find(([name]) =>
      name.startsWith('BedrockInference/CollaborativeBedrockInference-'),
    );
    expect(newPolicy?.[1]).toEqual(setup.inferencePolicy);
  });

  it('combines trust and broker access for one account, without duplicating trust on a rerun', () => {
    const sameAccountSetup = generateBedrockIamSetup({
      brokerRoleArn: 'arn:aws:iam::222222222222:role/review-broker',
      config: setup.config,
    });
    const result = runSetup({
      commands: [sameAccountSetup.reuseCommands, sameAccountSetup.reuseCommands].join('\n'),
    });
    expectInteractiveShellSurvives(result);
    expect(result.state.trustPolicy.Statement).toEqual([
      ...existingTrust.Statement,
      ...sameAccountSetup.trustPolicy.Statement,
    ]);
    expect(Object.keys(result.state.policies)).toHaveLength(3);
    const brokerPolicy = Object.entries(result.state.policies).find(([name]) =>
      name.startsWith('review-broker/CollaborativeBedrock-'),
    );
    expect(brokerPolicy?.[1]).toEqual(sameAccountSetup.assumeRolePolicy);
    expect(result.calls.some(({ args }) => args[1] === 'create-role')).toBe(false);
  });

  it('retains a single-statement trust document when adding another deployment', () => {
    const result = runSetup({
      commands: setup.reuseCommands,
      trustPolicy: { ...existingTrust, Statement: existingTrust.Statement[0] },
    });
    expectInteractiveShellSurvives(result);
    expect(result.state.trustPolicy.Statement).toEqual([
      existingTrust.Statement[0],
      ...setup.trustPolicy.Statement,
    ]);
  });

  it('retains inference permissions when the same deployment also uses the role in another region', () => {
    const secondRegion = generateBedrockIamSetup({
      brokerRoleArn: setup.brokerRoleArn,
      config: { ...setup.config, region: 'us-west-2' },
    });
    const result = runSetup({
      commands: [setup.reuseCommands, secondRegion.reuseCommands].join('\n'),
    });
    expectInteractiveShellSurvives(result);
    expect(result.state.trustPolicy.Statement).toHaveLength(existingTrust.Statement.length + 1);
    expect(Object.values(result.state.policies)).toEqual(
      expect.arrayContaining([setup.inferencePolicy, secondRegion.inferencePolicy]),
    );
  });

  it.each(['get-role', 'update-assume-role-policy'])(
    'does not write permissions after %s fails in the reuse flow',
    (failure) => {
      const result = runSetup({ commands: setup.reuseCommands, failure });
      expectInteractiveShellSurvives(result);
      expect(result.stderr).toContain(`denied ${failure}`);
      expect(result.calls.some(({ args }) => args[1] === 'put-role-policy')).toBe(false);
      expect(result.state.trustPolicy).toEqual(existingTrust);
    },
  );
});
