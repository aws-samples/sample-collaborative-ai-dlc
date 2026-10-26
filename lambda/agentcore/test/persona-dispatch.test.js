import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { dispatchPersona, composePersonaPrompt } from '../persona-dispatch.js';
import { INVOKE_DIALECT_ANNEX } from '../stage-materializer.js';
import { __test as runStageInternals } from '../commands/run-stage.js';
import { toolsForRole } from '../mcp/server.js';

// A child mock that resolves 'close' with exit code 0 and records whatever was
// piped to stdin — every driver here (claude/kiro/opencode) delivers its prompt
// via promptViaStdin, so capturing `.stdin.end(data)` is how a test recovers the
// exact rendered prompt without depending on argv shape.
const capturingSpawn = (capture) => (command, args) => {
  capture.command = command;
  capture.args = args;
  return {
    on: (event, cb) => event === 'close' && setImmediate(() => cb(0)),
    stdin: {
      end(data) {
        capture.stdin = data;
      },
    },
  };
};

const okSpawn = () => ({
  on: (event, cb) => event === 'close' && setImmediate(() => cb(0)),
  stdin: { end() {} },
});

const baseDeps = (overrides = {}) => ({
  cli: 'claude',
  cliModels: {},
  tierModels: null,
  env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
  workspaceDir: '/ws',
  spawnFn: okSpawn,
  mcpEntry: '/opt/agentcore/mcp/index.js',
  materializeMcpConfig: async () => '/ws/.aidlc/mcp.json',
  materializeKiroAgent: async () => 'aidlc',
  materializeOpenCodeConfig: async () => '{"share":"disabled"}',
  materializeCodexHome: async () => '/ws/.aidlc/codex-home',
  cleanupCodexHome: async () => true,
  executionId: 'exec-blind-e1',
  projectId: 'proj-blind-p1',
  intentId: 'intent-blind-i1',
  stageInstanceId: 'si-blind-1',
  unitSlug: null,
  sectionIndex: null,
  ids: () => 'sess-1',
  ...overrides,
});

describe('dispatchPersona — role: reviewer', () => {
  const reviewerArgs = (overrides = {}) => ({
    ...baseDeps(),
    role: 'reviewer',
    personaScope: { agentRef: 'aidlc-reviewer-agent' },
    agentBlock: { modelOverride: null },
    persona: 'Run {{INVOKE}} engine gen stage-table',
    knowledge: 'See {{HARNESS_DIR}}/tools',
    brief: 'Clean-room review brief: check the produced artifacts against the requirements.',
    ...overrides,
  });

  it('passes the caller brief through verbatim, with persona + knowledge appended (blindness seam)', async () => {
    const capture = {};
    const result = await dispatchPersona(reviewerArgs({ spawnFn: capturingSpawn(capture) }));

    expect(result.ok).toBe(true);
    // The brief text — fully controlled by the caller — appears untouched.
    expect(capture.stdin).toContain(
      'Clean-room review brief: check the produced artifacts against the requirements.',
    );
    // Persona + knowledge are the ONLY other inputs that reach the prompt,
    // appended via the shared generic tail (role heading + neutralized body).
    expect(capture.stdin).toContain('## Reviewer role');
    expect(capture.stdin).toContain('## Reference knowledge');
    expect(capture.stdin).not.toContain('{{INVOKE}}');
    expect(capture.stdin).not.toContain('{{HARNESS_DIR}}');
    expect(capture.stdin).toContain('<runtime-managed-engine>');
    // Byte-identical to the shared composer given the same inputs.
    expect(capture.stdin).toBe(
      composePersonaPrompt({
        brief: 'Clean-room review brief: check the produced artifacts against the requirements.',
        persona: 'Run {{INVOKE}} engine gen stage-table',
        knowledge: 'See {{HARNESS_DIR}}/tools',
        role: 'reviewer',
      }),
    );
    // Nothing beyond brief + persona + knowledge reaches the prompt: none of
    // the scope/identity plumbing leaks into the rendered text.
    expect(capture.stdin).not.toContain('exec-blind-e1');
    expect(capture.stdin).not.toContain('proj-blind-p1');
    expect(capture.stdin).not.toContain('si-blind-1');
  });

  it('selects the reviewer MCP role and stamps the trusted reviewerAgent identity', async () => {
    let capturedScope = null;
    const deps = reviewerArgs({
      materializeMcpConfig: async ({ scope }) => {
        capturedScope = scope;
        return '/ws/.aidlc/mcp.json';
      },
    });

    const result = await dispatchPersona(deps);

    expect(result.ok).toBe(true);
    expect(capturedScope).toMatchObject({
      role: 'reviewer',
      reviewerAgent: 'aidlc-reviewer-agent',
    });
  });

  it('uses the injected OpenCode store wrapper for an OpenCode child session', async () => {
    let wrapped = 0;
    const result = await dispatchPersona(
      reviewerArgs({
        cli: 'opencode',
        withOpenCodeStore: async ({ operation }) => {
          wrapped += 1;
          return operation();
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(wrapped).toBe(1);
  });

  it('returns a structured failure shape instead of throwing when the dispatch mechanics blow up', async () => {
    const boom = new Error('mcp materialize boom');
    const deps = reviewerArgs({
      materializeMcpConfig: async () => {
        throw boom;
      },
    });

    const result = await dispatchPersona(deps);

    expect(result).toEqual({ ok: false, detail: boom });
  });

  it('still runs codex cleanup on a session failure (finally semantics preserved)', async () => {
    let cleanedUp = null;
    const failingSpawn = () => {
      throw new Error('spawn E2BIG');
    };
    const deps = reviewerArgs({
      cli: 'codex',
      spawnFn: failingSpawn,
      materializeCodexHome: async () => '/ws/.aidlc/codex-home/reviewer',
      cleanupCodexHome: async ({ codexHome }) => {
        cleanedUp = codexHome;
        return true;
      },
    });

    const result = await dispatchPersona(deps);

    expect(result.ok).toBe(false);
    expect(result.detail).toBeInstanceOf(Error);
    expect(cleanedUp).toBe('/ws/.aidlc/codex-home/reviewer');
  });
});

// Generic persona roles use the author MCP role without reviewer-specific wiring.
describe('dispatchPersona — generic role: support', () => {
  it('dispatches an author-role session from a caller-built brief', async () => {
    const capture = {};
    let capturedScope = null;
    const result = await dispatchPersona({
      ...baseDeps({
        spawnFn: capturingSpawn(capture),
        materializeMcpConfig: async ({ scope }) => {
          capturedScope = scope;
          return '/ws/.aidlc/mcp.json';
        },
      }),
      role: 'support',
      personaScope: { agentRef: 'aidlc-support-agent' },
      agentBlock: { modelOverride: null },
      persona: 'You review the lead draft and record AGREE/OBJECT positions.',
      knowledge: 'Team convention: prefer composition over inheritance.',
      brief: 'Support brief: here is the lead draft — record your position on it.',
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toMatchObject({ mcpRole: 'author' });
    // 'support' is not 'reviewer': author MCP role, no reviewerAgent pin.
    expect(capturedScope.role).toBe('author');
    expect(capturedScope.reviewerAgent).toBeUndefined();
    // Same brief + persona/knowledge tail contract as the reviewer role.
    expect(capture.stdin).toContain(
      'Support brief: here is the lead draft — record your position on it.',
    );
    expect(capture.stdin).toContain('## Support role');
    expect(capture.stdin).toContain('You review the lead draft and record AGREE/OBJECT positions.');
    expect(capture.stdin).toContain('## Reference knowledge');
    expect(capture.stdin).toContain('Team convention: prefer composition over inheritance.');
  });

  it('falls back to a "no persona supplied" marker when the caller sends none', async () => {
    const capture = {};
    const result = await dispatchPersona({
      ...baseDeps({ spawnFn: capturingSpawn(capture) }),
      role: 'support',
      personaScope: { agentRef: 'aidlc-support-agent' },
      persona: '',
      knowledge: '',
      brief: 'Support brief with no persona body.',
    });

    expect(result.ok).toBe(true);
    expect(capture.stdin).toContain('(no support persona supplied)');
    expect(capture.stdin).not.toContain('## Reference knowledge');
  });

  it('classifies a non-zero CLI exit as a failed persona session', async () => {
    const result = await dispatchPersona({
      ...baseDeps({
        spawnFn: () => ({
          on: (event, callback) => event === 'close' && setImmediate(() => callback(7)),
          stdin: { end() {} },
        }),
      }),
      role: 'support',
      personaScope: { agentRef: 'aidlc-support-agent' },
      persona: 'Review the draft.',
      knowledge: '',
      brief: 'Inspect the current output.',
    });

    expect(result).toMatchObject({ ok: false, detail: { exitCode: 7 } });
  });

  it('kills and awaits a timed-out CLI child before returning a session failure', async () => {
    const child = new EventEmitter();
    child.stdin = { end() {} };
    let killed = false;
    let closed = false;
    child.kill = (signal) => {
      killed = signal === 'SIGKILL';
      setTimeout(() => {
        closed = true;
        child.emit('close', null);
      }, 5);
      return true;
    };

    const result = await Promise.race([
      dispatchPersona({
        ...baseDeps({ spawnFn: () => child }),
        timeoutMs: 10,
        role: 'support',
        personaScope: { agentRef: 'aidlc-support-agent' },
        persona: 'Review the draft.',
        knowledge: '',
        brief: 'Inspect the current output.',
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), 100)),
    ]);

    expect(result).toMatchObject({ ok: false, detail: { timedOut: true } });
    expect(killed).toBe(true);
    expect(closed).toBe(true);
  });
});

// A dispatched persona inherits the stage policy, leaves checkpoint ownership
// with the lead, and uses its server-supplied identity for author-side writes.
describe('dispatchPersona — process groups', () => {
  const optionsOf = async (overrides) => {
    const seen = [];
    await dispatchPersona({
      ...baseDeps({
        spawnFn: (_command, _args, options) => {
          seen.push(options);
          return okSpawn();
        },
      }),
      personaScope: { agentRef: 'aidlc-support-agent' },
      brief: 'brief',
      ...overrides,
    });
    return seen[0];
  };

  it('spawns a reviewer exactly as before, with no process group', async () => {
    expect(await optionsOf({ role: 'reviewer' })).not.toHaveProperty('detached');
  });

  it('spawns a session that asks for it as its own process group', async () => {
    const options = await optionsOf({ role: 'support', processGroup: true });
    expect(options.detached).toBe(process.platform !== 'win32');
  });
});

describe('dispatchPersona — the trusted scope of a dispatched persona', () => {
  const POLICY = { summaryConfirmation: 'required', learnings: 'off' };

  const scopeFor = async (role) => {
    const scopes = [];
    const res = await dispatchPersona({
      ...baseDeps({ stageId: 'user-stories', stageAttempt: 2 }),
      role,
      personaScope: { agentRef: 'aidlc-design-agent', policy: POLICY, checkpointOwner: false },
      persona: 'p',
      knowledge: '',
      brief: 'b',
      materializeMcpConfig: async ({ scope }) => {
        scopes.push(scope);
        return '/ws/.aidlc/mcp.json';
      },
    });
    expect(res.ok).toBe(true);
    return scopes[0];
  };

  it('carries the policy, withholds checkpoint ownership and pins the author identity', async () => {
    const scope = await scopeFor('support');
    expect(scope).toMatchObject({
      role: 'author',
      policy: POLICY,
      checkpointOwner: false,
      agentRef: 'aidlc-design-agent',
      stageId: 'user-stories',
      stageAttempt: 2,
    });
    expect(scope.reviewerAgent).toBeUndefined();
  });

  it('keeps the reviewer identity on the reviewer role and pins no author identity', async () => {
    const scope = await scopeFor('reviewer');
    expect(scope).toMatchObject({
      role: 'reviewer',
      reviewerAgent: 'aidlc-design-agent',
      checkpointOwner: false,
    });
    expect(scope.agentRef).toBeUndefined();
  });

  it('owns the checkpoint by default, so an un-updated caller is unchanged', async () => {
    const scopes = [];
    await dispatchPersona({
      ...baseDeps(),
      role: 'support',
      personaScope: { agentRef: 'aidlc-design-agent' },
      persona: 'p',
      knowledge: '',
      brief: 'b',
      materializeMcpConfig: async ({ scope }) => {
        scopes.push(scope);
        return '/ws/.aidlc/mcp.json';
      },
    });
    expect(scopes[0]).toMatchObject({ checkpointOwner: true, policy: null });
    expect(scopes[0]).not.toHaveProperty('canAsk');
  });

  it('carries a withheld ask_question into the session scope', async () => {
    const scopes = [];
    await dispatchPersona({
      ...baseDeps(),
      role: 'support',
      personaScope: { agentRef: 'aidlc-design-agent', canAsk: false },
      persona: 'p',
      knowledge: '',
      brief: 'b',
      materializeMcpConfig: async ({ scope }) => {
        scopes.push(scope);
        return '/ws/.aidlc/mcp.json';
      },
    });
    expect(scopes[0]).toMatchObject({ canAsk: false });
  });
});

// A secondary session receives the same authored bodies as the lead: the
// reviewer brief and every ensemble persona brief render a persona and the
// reference knowledge (commands/run-stage.js buildReviewerPrompt,
// loadMethodologyKnowledge). The promotion guard may only call an engine command
// answered if EVERY prompt rendering that body carries the answer, so this tail
// is the secondary-session half of that claim.
describe('composePersonaPrompt — the dialect annex in a secondary session', () => {
  const INSTRUCTING = 'Obtain the branch with `{{INVOKE}} engine worktree info --slug current`.';

  it('answers an engine command the persona or the knowledge instructs', () => {
    for (const part of ['persona', 'knowledge']) {
      for (const role of ['support', 'link', 'integrator']) {
        const prompt = composePersonaPrompt({
          brief: 'b',
          persona: 'p',
          knowledge: 'k',
          role,
          [part]: INSTRUCTING,
        });

        expect(prompt, `${role}/${part}`).toContain(INVOKE_DIALECT_ANNEX);
        expect(prompt, `${role}/${part}`).not.toContain('{{INVOKE}}');
        // An author role HAS the tools the annex names, so it gets the annex
        // verbatim; the read-only redirection would be wrong for it.
        expect(prompt, `${role}/${part}`).not.toContain('**You are a read-only session.**');
      }
    }
  });

  // Every answer in the annex names an author tool (`emit_stage_note`,
  // `send_output`). The reviewer's MCP role may only `submit_review`, so the
  // rows stay verbatim and a preamble redirects the recording channel; handing
  // it the annex unchanged would instruct a tool it was never registered for.
  it('redirects the recording channel for the read-only reviewer role', () => {
    const prompt = composePersonaPrompt({
      brief: 'b',
      persona: 'p',
      knowledge: INSTRUCTING,
      role: 'reviewer',
    });

    expect(prompt).toContain(INVOKE_DIALECT_ANNEX);
    expect(prompt).toContain('**You are a read-only session.**');
    expect(prompt).toContain('`submit_review`');
  });

  it('leaves a brief whose bodies instruct nothing unchanged', () => {
    for (const role of ['reviewer', 'support']) {
      const prompt = composePersonaPrompt({
        brief: 'b',
        persona: 'You are the designer.',
        knowledge: 'Prefer composition over inheritance.',
        role,
      });

      expect(prompt, role).not.toContain(INVOKE_DIALECT_ANNEX);
      expect(prompt, role).not.toContain('read-only session');
    }
  });

  // `engine log answer` / `engine log decision` are mapped onto `ask_question`
  // and `confirm_summary`, and tool registration withholds BOTH from a session
  // that does not own the stage's checkpoint and withholds `confirm_summary`
  // wherever the policy asks for no summary confirmation. Advertising them
  // regardless told a session to call a tool it was deliberately never
  // registered for — the same mismatch already fixed for `learnings: off`.
  describe('the checkpoint mapping follows the session that receives it', () => {
    const CHECKPOINT_KNOWLEDGE = 'Log the answer: `{{INVOKE}} engine log answer --question q`.';
    const VERBATIM_ROW = 'Ask with `ask_question`, confirm with `confirm_summary`';

    const promptFor = (overrides) =>
      composePersonaPrompt({
        brief: 'b',
        persona: 'p',
        knowledge: CHECKPOINT_KNOWLEDGE,
        role: 'support',
        ...overrides,
      });

    it('keeps the mapping verbatim for the session that has both tools', () => {
      const prompt = promptFor({ policy: { summaryConfirmation: 'required' } });

      expect(prompt).toContain(VERBATIM_ROW);
    });

    it('withdraws the confirmation where the policy asks for none', () => {
      const prompt = promptFor({ policy: { summaryConfirmation: 'none' } });

      expect(prompt).not.toContain(VERBATIM_ROW);
      expect(prompt).toContain('no `confirm_summary` tool exists for this session');
      expect(prompt).toContain('Ask with `ask_question`');
      // The refusal half of the row is untouched in every form.
      expect(prompt).toContain('The protected checkpoints are **unavailable**');
    });

    it('defers to the owning session for a support that cannot ask', () => {
      for (const overrides of [
        { policy: { summaryConfirmation: 'required' }, canAsk: false },
        { policy: { summaryConfirmation: 'required' }, checkpointOwner: false },
      ]) {
        const prompt = promptFor(overrides);

        expect(prompt).not.toContain(VERBATIM_ROW);
        expect(prompt).toContain('cannot raise either checkpoint in this session');
        expect(prompt).toContain('defer to the owning session');
      }
    });

    it('defers for the reviewer, which has neither tool', () => {
      const prompt = composePersonaPrompt({
        brief: 'b',
        persona: 'p',
        knowledge: CHECKPOINT_KNOWLEDGE,
        role: 'reviewer',
        policy: { summaryConfirmation: 'required' },
        checkpointOwner: false,
        canAsk: false,
      });

      expect(prompt).toContain('**You are a read-only session.**');
      expect(prompt).not.toContain(VERBATIM_ROW);
      expect(prompt).toContain('cannot raise either checkpoint in this session');
    });

    // And a release that never invokes these commands reads the row as inert
    // prose, so its prompt keeps the annex verbatim — which is what leaves every
    // older pinned release's prompt byte-for-byte unchanged.
    it('leaves the annex verbatim for a release that invokes neither command', () => {
      const prompt = composePersonaPrompt({
        brief: 'b',
        persona: 'p',
        knowledge: INSTRUCTING,
        role: 'support',
        policy: { summaryConfirmation: 'none' },
        canAsk: false,
        checkpointOwner: false,
      });

      expect(prompt).toContain(INVOKE_DIALECT_ANNEX);
    });
  });

  // The LIVE reviewer path is `runReviewer` → `dispatchPersona`, which composes
  // the prompt itself. A helper that passes the right flags proves nothing about
  // that path: the dispatcher defaulted checkpoint ownership and `ask_question`
  // to true, so the reviewer's own prompt told it to call a tool MCP never
  // registers for its role.
  it('refuses the checkpoints in the prompt the live reviewer dispatch builds', async () => {
    const capture = {};
    const scopes = [];
    const res = await dispatchPersona({
      ...baseDeps({ stageId: 'design' }),
      role: 'reviewer',
      personaScope: { agentRef: 'aidlc-architecture-reviewer-agent' },
      agentBlock: { modelOverride: null },
      persona: 'You are the independent reviewer.',
      knowledge: 'Log the answer: `{{INVOKE}} engine log answer --question q`.',
      brief: 'Clean-room review brief.',
      spawnFn: capturingSpawn(capture),
      materializeMcpConfig: async ({ scope }) => {
        scopes.push(scope);
        return '/ws/.aidlc/mcp.json';
      },
    });

    expect(res.ok).toBe(true);
    const prompt = capture.stdin ?? capture.args.join(' ');
    expect(prompt).toContain('**You cannot raise either checkpoint in this session**');
    expect(prompt).not.toContain('Ask with `ask_question`');
    // And the trusted scope agrees with the prompt, so the tools MCP registers
    // for this role are the tools the prompt names.
    expect(scopes[0]).toMatchObject({ role: 'reviewer', checkpointOwner: false, canAsk: false });
    expect(
      toolsForRole('reviewer', 'design', null, { checkpointOwner: false, canAsk: false }),
    ).not.toContain('ask_question');
  });

  // An author session keeps everything it had: the role owns the checkpoints,
  // so only the resolved policy decides whether a confirmation exists.
  it('keeps the checkpoint mapping of an author-role dispatch', async () => {
    const capture = {};
    await dispatchPersona({
      ...baseDeps({ stageId: 'design' }),
      role: 'support',
      personaScope: {
        agentRef: 'aidlc-design-agent',
        policy: { summaryConfirmation: 'required' },
      },
      agentBlock: { modelOverride: null },
      persona: 'p',
      knowledge: 'Log the answer: `{{INVOKE}} engine log answer --question q`.',
      brief: 'b',
      spawnFn: capturingSpawn(capture),
    });

    const prompt = capture.stdin ?? capture.args.join(' ');
    expect(prompt).toContain('Ask with `ask_question`, confirm with `confirm_summary`');
    expect(prompt).not.toContain('**You cannot raise either checkpoint in this session**');
  });

  it('answers it in the real reviewer prompt the runtime builds', () => {
    const prompt = runStageInternals.buildReviewerPrompt({
      stage: {
        stageId: 'functional-design',
        phase: 'inception',
        outputArtifacts: [{ artifact: 'business-logic-model' }],
        inputArtifacts: [{ artifact: 'requirements' }],
        reviewer: { artifact: 'business-logic-model' },
      },
      reviewerAgent: 'aidlc-architecture-reviewer-agent',
      reviewerPersona: 'You are the independent reviewer.',
      knowledge: INSTRUCTING,
      round: 1,
    });

    expect(prompt).toContain(INVOKE_DIALECT_ANNEX);
    expect(prompt).toContain('**You are a read-only session.**');
    expect(prompt).not.toContain('{{INVOKE}}');
  });
});
