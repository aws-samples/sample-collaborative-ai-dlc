import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import {
  BEDROCK_PREFLIGHT_CAUSES,
  PREFLIGHT_SESSION_NAME,
  ROLE_SESSION_DURATION_SECONDS,
  assumeBedrockRole,
  parseAssumableRoleArns,
  preflightBedrockRoleBinding,
  readSessionPolicy,
  roleArnMatchesAllowlist,
} from '../bedrock-role.js';

// specs/bedrock-iam-role-credential-mode — req-binding-preflight.
//
// The preflight is a bare AssumeRole with NO model invocation, run before a role
// binding is persisted. It shares its assume path with resolution so it cannot
// drift from the thing it predicts.
const ROLE_ARN = 'arn:aws:iam::444455556666:role/aidlc-bedrock-inference';
const BROKER_ARN = 'arn:aws:iam::111122223333:role/collab-credential-broker-dev';
const ALLOWLIST = ['arn:aws:iam::*:role/aidlc-bedrock-*'];

const denied = () => Object.assign(new Error('denied'), { name: 'AccessDenied' });
const throttled = () => Object.assign(new Error('slow'), { name: 'ThrottlingException' });

const sts = mockClient(STSClient);

beforeEach(() => {
  sts.reset();
});

describe('bedrock role binding preflight', () => {
  it('performs exactly one AssumeRole, with no model invocation and no retry loop', async () => {
    sts.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: 'ASIA-test',
        SecretAccessKey: 'secret',
        SessionToken: 'token',
        Expiration: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const verdict = await preflightBedrockRoleBinding(
      { roleArn: ROLE_ARN, externalId: 'ext', projectId: 'p-1', assumableRoleArns: ALLOWLIST },
      sts,
    );

    expect(verdict).toMatchObject({ ok: true, cause: 'ok', sessionName: 'aidlc-p-1' });
    // It shares the STS request-rate surface, so it is called once and never looped.
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
    expect(sts.commandCalls(AssumeRoleCommand)[0].args[0].input).toMatchObject({
      RoleArn: ROLE_ARN,
      RoleSessionName: 'aidlc-p-1',
      ExternalId: 'ext',
      DurationSeconds: ROLE_SESSION_DURATION_SECONDS,
    });
  });

  it('returns a verdict and never credentials, even on success', async () => {
    sts.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: 'ASIA-must-not-leak',
        SecretAccessKey: 'secret-must-not-leak',
        SessionToken: 'token-must-not-leak',
      },
    });

    const verdict = await preflightBedrockRoleBinding(
      { roleArn: ROLE_ARN, projectId: 'p-1', assumableRoleArns: ALLOWLIST },
      sts,
    );

    // A control-plane check must not become a credential-minting path by accident.
    expect(JSON.stringify(verdict)).not.toContain('must-not-leak');
    expect(Object.keys(verdict).toSorted()).toEqual(['cause', 'ok', 'sessionName']);
  });

  it('rejects a role outside the allowlist without calling STS at all', async () => {
    const verdict = await preflightBedrockRoleBinding(
      {
        roleArn: 'arn:aws:iam::444455556666:role/some-other-role',
        projectId: 'p-1',
        assumableRoleArns: ALLOWLIST,
      },
      sts,
    );

    // Decidable locally: the broker's own policy bounds which ARNs it may assume,
    // so this cause needs no round trip and is reported exactly.
    expect(verdict.ok).toBe(false);
    expect(verdict.cause).toBe(BEDROCK_PREFLIGHT_CAUSES.ROLE_NOT_ALLOWLISTED);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
    expect(verdict.candidates[0].detail).toContain('aidlc-bedrock-*');
  });

  it('reports one trust-policy category naming every candidate cause, with no STS text', async () => {
    // MEASURED on 2026-09-06 against a throwaway role: STS returns a
    // byte-identical AccessDenied for a wrong external ID, an omitted external ID,
    // a session-name condition mismatch, an untrusted principal and a role that
    // does not exist — differing only in the resource ARN. So the four causes
    // cannot be separated from the response, and this asserts the honest
    // behaviour: one category carrying the facts needed to check each candidate.
    sts.on(AssumeRoleCommand).rejects(denied());

    const verdict = await preflightBedrockRoleBinding(
      {
        roleArn: ROLE_ARN,
        externalId: 'ext',
        projectId: 'p-1',
        assumableRoleArns: ALLOWLIST,
        brokerRoleArn: BROKER_ARN,
        platformAccountId: '111122223333',
      },
      sts,
    );

    expect(verdict.cause).toBe(BEDROCK_PREFLIGHT_CAUSES.TRUST_POLICY_REJECTED);
    expect(verdict.candidates.map((c) => c.candidate)).toEqual([
      'principal-not-trusted',
      'session-name-condition-mismatch',
      'external-id-mismatch',
    ]);
    // The principal an operator must trust, and the session name their condition
    // must admit, are both named exactly.
    expect(verdict.candidates[0].detail).toContain(BROKER_ARN);
    expect(verdict.candidates[1].detail).toContain('aidlc-p-1');
    // No provider text: an STS message can name the caller session and the target.
    const serialized = JSON.stringify(verdict);
    expect(serialized).not.toContain('denied');
    expect(serialized).not.toContain('AccessDenied');
  });

  it('names the absent external ID as a candidate when none was sent', async () => {
    sts.on(AssumeRoleCommand).rejects(denied());

    const verdict = await preflightBedrockRoleBinding(
      {
        roleArn: ROLE_ARN,
        projectId: 'p-1',
        assumableRoleArns: ALLOWLIST,
        platformAccountId: '111122223333',
      },
      sts,
    );

    expect(verdict.candidates.map((c) => c.candidate)).toContain('external-id-required-but-absent');
  });

  it('derives cross-account from the same helper the write path uses', async () => {
    sts.on(AssumeRoleCommand).rejects(denied());

    // bedrockRoleIsCrossAccount treats an UNKNOWN platform account as
    // cross-account, because a superfluous external ID is inert while a missing one
    // is a hard denial. The preflight must inherit that direction rather than
    // re-derive it: the opposite answer would tell the operator to REMOVE the
    // sts:ExternalId condition the write path had just generated a value for.
    const verdict = await preflightBedrockRoleBinding(
      { roleArn: ROLE_ARN, projectId: 'p-1', assumableRoleArns: ALLOWLIST },
      sts,
    );

    const absent = verdict.candidates.find(
      (c) => c.candidate === 'external-id-required-but-absent',
    );
    expect(absent.detail).toContain('cross-account');
    expect(absent.detail).not.toContain('must not require');
  });

  it('distinguishes throttling from a rejection, since it is not a binding fault', async () => {
    sts.on(AssumeRoleCommand).rejects(throttled());
    const verdict = await preflightBedrockRoleBinding(
      { roleArn: ROLE_ARN, projectId: 'p-1', assumableRoleArns: ALLOWLIST },
      sts,
    );
    expect(verdict.cause).toBe(BEDROCK_PREFLIGHT_CAUSES.THROTTLED);
    expect(verdict.candidates).toEqual([]);
  });

  it('probes a platform binding with the shared preflight session name', async () => {
    sts.on(AssumeRoleCommand).rejects(denied());
    // A platform binding serves every space, so it has no single space to name —
    // and a StringEquals condition for one space SHOULD fail here, because such a
    // role cannot serve as a platform binding.
    const verdict = await preflightBedrockRoleBinding(
      { roleArn: ROLE_ARN, assumableRoleArns: ALLOWLIST },
      sts,
    );
    expect(verdict.sessionName).toBe(PREFLIGHT_SESSION_NAME);
    expect(sts.commandCalls(AssumeRoleCommand)[0].args[0].input.RoleSessionName).toBe(
      PREFLIGHT_SESSION_NAME,
    );
  });
});

describe('assumable-role allowlist matching', () => {
  it('honours IAM\u2019s two resource wildcards and anchors the match', () => {
    expect(roleArnMatchesAllowlist(ROLE_ARN, ALLOWLIST)).toBe(true);
    expect(roleArnMatchesAllowlist('arn:aws:iam::444455556666:role/aidlc-bedrock', ALLOWLIST)).toBe(
      false,
    );
    // Anchoring: a longer ARN that merely CONTAINS a match must not pass.
    expect(roleArnMatchesAllowlist(`prefix-${ROLE_ARN}`, ALLOWLIST)).toBe(false);
    // A regex metacharacter in the pattern is escaped, so a pattern cannot widen
    // itself into matching an unrelated ARN.
    expect(roleArnMatchesAllowlist('arn:aws:iam::444455556666:role/aXdlc', ['*:role/a.dlc'])).toBe(
      false,
    );
    expect(roleArnMatchesAllowlist(ROLE_ARN, ['*'])).toBe(true);
  });

  it('accepts ? as IAM\u2019s single-character wildcard, so the check cannot be stricter than the grant', () => {
    // IAM resource ARNs take BOTH * and ?. A pattern IAM would admit must not be
    // refused here: the verdict would reject a save that STS goes on to allow.
    const suffixed = 'arn:aws:iam::111122223333:role/aidlc-bedrock-1';
    expect(roleArnMatchesAllowlist(suffixed, ['arn:aws:iam::*:role/aidlc-bedrock-?'])).toBe(true);
    // Exactly ONE character, not any run of them.
    expect(
      roleArnMatchesAllowlist('arn:aws:iam::111122223333:role/aidlc-bedrock-12', [
        'arn:aws:iam::*:role/aidlc-bedrock-?',
      ]),
    ).toBe(false);
  });

  it('treats an unconfigured allowlist as unknown rather than deny-all', () => {
    // The check exists to produce a better message. Failing a save because the
    // variable was not plumbed through would be worse than letting STS answer.
    expect(roleArnMatchesAllowlist(ROLE_ARN, [])).toBe(true);
    expect(roleArnMatchesAllowlist(ROLE_ARN, undefined)).toBe(true);
  });

  it('parses the allowlist from JSON, a comma list or an array', () => {
    expect(parseAssumableRoleArns(JSON.stringify(ALLOWLIST))).toEqual(ALLOWLIST);
    expect(parseAssumableRoleArns('a,b , c')).toEqual(['a', 'b', 'c']);
    expect(parseAssumableRoleArns(ALLOWLIST)).toEqual(ALLOWLIST);
    expect(parseAssumableRoleArns('')).toEqual([]);
    expect(parseAssumableRoleArns('[not json')).toEqual([]);
  });
});

// specs/bedrock-iam-role-credential-mode — req-least-privilege-assume.
//
// The ceiling attached to every minted credential. Verified live on 2026-09-07 against
// a throwaway role holding the reference grant plus s3:ListAllMyBuckets: without a
// session policy the S3 call SUCCEEDED, with one it was denied while
// eu.anthropic.claude-sonnet-5 still invoked. These tests pin the plumbing that live
// result depends on.
describe('Bedrock session-policy ceiling', () => {
  const CEILING = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['bedrock:InvokeModel'], Resource: '*' }],
  });
  const credentials = {
    AccessKeyId: 'AKIA',
    SecretAccessKey: 'secret',
    SessionToken: 'token',
    Expiration: new Date('2026-01-01T01:00:00Z'),
  };

  beforeEach(() => {
    sts.reset();
    sts.on(AssumeRoleCommand).resolves({ Credentials: credentials });
  });

  const policySent = () => sts.commandCalls(AssumeRoleCommand)[0].args[0].input.Policy;

  it('attaches the ceiling to the AssumeRole that mints stage credentials', async () => {
    await assumeBedrockRole(
      { roleArn: ROLE_ARN, projectId: 'p-1', sessionPolicy: CEILING },
      new STSClient({}),
    );
    expect(JSON.parse(policySent())).toEqual(JSON.parse(CEILING));
  });

  it('attaches it on the preflight too, so the preflight predicts the real call', async () => {
    await preflightBedrockRoleBinding(
      { roleArn: ROLE_ARN, assumableRoleArns: ALLOWLIST, sessionPolicy: CEILING },
      new STSClient({}),
    );
    expect(JSON.parse(policySent())).toEqual(JSON.parse(CEILING));
  });

  // A missing ceiling applies none rather than refusing to mint. Same reasoning as an
  // empty assumable-role allowlist: a missing configuration means "unknown", not "deny
  // everything". Refusing would fail every stage during a partial deploy for the sake of
  // a defence-in-depth control whose primary is the role's own policy.
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['not JSON', 'not-json'],
    ['not an object', '"a string"'],
    ['an array', '[]'],
    ['missing Statement', '{"Version":"2012-10-17"}'],
    ['an empty Statement list', '{"Version":"2012-10-17","Statement":[]}'],
  ])('sends no Policy when the ceiling is %s, rather than failing the mint', async (_l, value) => {
    await assumeBedrockRole(
      { roleArn: ROLE_ARN, projectId: 'p-1', sessionPolicy: value },
      new STSClient({}),
    );
    expect(policySent()).toBeUndefined();
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });

  it('normalises the ceiling rather than forwarding raw text', () => {
    // Parsed and re-serialised, so trailing whitespace or formatting from an env var
    // cannot reach STS as a ValidationError.
    expect(readSessionPolicy(`  ${CEILING}\n`)).toBe(CEILING);
  });
});
