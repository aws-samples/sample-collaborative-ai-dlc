import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// specs/bedrock-iam-role-credential-mode — req-execution-role-no-bedrock.
//
// This is the load-bearing fail-closed test for the whole feature, and it is a
// test rather than an assertion in prose for a specific reason: per
// con-mmds-chain-live, AgentCore exposes execution-role credentials through a
// MicroVM Metadata Service and the platform DELIBERATELY forwards the AWS
// credential-chain variables to the reserved `aidlc` MCP child, so its SDK
// clients can resolve credentials. That chain is live and cannot be removed.
//
// Fail-closed therefore rests entirely on the execution role's POLICY holding
// nothing useful. If a future change adds a bedrock, bedrock-mantle or sts action
// to it, every stage silently gains a shared account-level Bedrock credential and
// the per-space, one-hour, invoke-only credential this feature exists to deliver
// stops being the only path. Nothing else in the system would notice.
//
// The spec is explicit that we must NOT claim the credential chain is absent —
// only that the policy makes it inert. This test is that claim, mechanised.

const agentcoreTerraform = readFileSync(
  fileURLToPath(new URL('../../../terraform/modules/compute/agentcore/main.tf', import.meta.url)),
  'utf8',
);

// Extract one top-level `resource "<type>" "<name>" { ... }` block by brace
// balance. A regex cannot do this: the policy body is built with concat() over
// nested lists and objects.
const terraformBlock = (source, header) => {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`terraform block not found: ${header}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced terraform block: ${header}`);
};

describe('AgentCore execution role IAM', () => {
  const policy = terraformBlock(agentcoreTerraform, 'resource "aws_iam_role_policy" "agentcore"');

  it('extracts a plausible policy block (guards the extractor itself)', () => {
    // Without this, a failed extraction would make every assertion below pass
    // vacuously — the classic way a negative test rots into a no-op.
    expect(policy.length).toBeGreaterThan(500);
    expect(policy).toContain('aws_iam_role.agentcore.id');
    expect(policy).toContain('"lambda:InvokeFunction"');
  });

  it.each(['bedrock', 'bedrock-mantle', 'sts'])(
    'grants no %s action, so the live container credential chain is inert',
    (service) => {
      // Match an ACTION string for the service, e.g. "bedrock:InvokeModel".
      // bedrock-agentcore appears legitimately as a trust-policy principal and as
      // a log-group path, neither of which is an action, so the colon-suffixed
      // quoted form is the precise test.
      const actions = [...policy.matchAll(/"([a-z0-9-]+):([A-Za-z*]+)"/g)].map((m) => m[1]);
      expect(actions).not.toContain(service);
    },
  );

  // The check above is a lint over literal quoted action strings, so on its own it
  // could be bypassed by indirection — `Action = [local.verb]` puts the literal
  // outside this block, and `Action = ["bedrock:${local.verb}"]` is not matched by
  // the pattern. Either would reintroduce a Bedrock grant while keeping the
  // assertion green, which is exactly the "a future change cannot reintroduce
  // them" guarantee the requirement asks for. Requiring every action to be a plain
  // quoted literal closes that, and fails loudly if someone introduces
  // indirection here for a legitimate reason — at which point this test should be
  // replaced by an assertion over the rendered policy JSON, not relaxed.
  it('expresses every action as a plain quoted literal, so the lint cannot be bypassed', () => {
    const assignments = [];
    const pattern = /Action\s*=\s*/g;
    for (let match = pattern.exec(policy); match; match = pattern.exec(policy)) {
      const rest = policy.slice(match.index + match[0].length);
      // Either a single quoted string or a bracketed list; take exactly that much.
      if (rest.startsWith('[')) {
        assignments.push(rest.slice(0, rest.indexOf(']') + 1));
      } else {
        assignments.push(rest.slice(0, rest.indexOf('\n')));
      }
    }
    expect(assignments.length).toBeGreaterThan(3);
    for (const assignment of assignments) {
      // No interpolation, and no reference that would carry the verb in from
      // elsewhere in the module.
      expect(assignment).not.toMatch(/\$\{/);
      expect(assignment).not.toMatch(/\b(?:local|var|data|module)\./);
      // Every element is a quoted "service:Action" literal.
      const elements = assignment.replace(/^\[|\]$/g, '').split(',');
      for (const element of elements) {
        const trimmed = element.trim();
        if (!trimmed) continue;
        expect(trimmed).toMatch(/^"[a-z0-9-]+:[A-Za-z*]+"$/);
      }
    }
  });

  it('names the credential broker as the only path to a Bedrock credential', () => {
    // The role may INVOKE the broker; the broker holds the sts:AssumeRole. That
    // asymmetry is the design (req-broker-side-assume).
    expect(policy).toContain('local.credential_broker_function_arn');
  });

  it('keeps sts:AssumeRole in the trust policy only, which is not a permission', () => {
    const role = terraformBlock(agentcoreTerraform, 'resource "aws_iam_role" "agentcore"');
    // The service principal assuming the role is how the role is used at all; it
    // grants the role's holder nothing.
    expect(role).toContain('"sts:AssumeRole"');
    expect(role).toContain('bedrock-agentcore.${local.dns_suffix}');
    // And it is genuinely a different resource from the permission policy.
    expect(role).not.toContain('aws_iam_role_policy');
  });
});
