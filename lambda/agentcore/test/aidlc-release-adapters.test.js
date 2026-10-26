// Per-release adapters at the RUNTIME seams: the stage
// prompt (scope policy + {{INVOKE}} dialect), the OpenCode turn cap, and the
// sensor `fire_on` planes. Each case also pins the legacy shape, because a
// catalog without the new fields must produce byte-identical output.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ANNEX_HANDLED_ENGINE_COMMANDS } from '../../shared/aidlc-capabilities.js';
import {
  INVOKE_FAMILY_FIDELITY,
  filesFromCompatibilityFixture,
} from '../../shared/aidlc-compatibility.js';
import { buildReleaseBundle } from '../../shared/aidlc-release.js';
import { annexReachingBlocks } from '../../shared/annex-reach.js';
import { RELEASE_LIBRARY_TYPES } from '../../shared/blocks.js';
import { COMPOSER_AGENT_ID } from '../../shared/compose-match.js';
import { createSensorRunner } from '../sensor-runner.js';
import {
  INVOKE_DIALECT_ANNEX,
  OPENCODE_DEFAULT_AGENT,
  buildOpenCodeConfig,
  buildStagePrompt,
  invokeDialectAnnex,
  neutralizeInvoke,
  renderScopePolicy,
} from '../stage-materializer.js';
import { buildComposePrompt } from '../commands/compose-plan-start.js';
import { composePersonaPrompt } from '../persona-dispatch.js';
import { __test as runStageInternals } from '../commands/run-stage.js';
import { workspaceRelativePath } from '../repo-paths.js';

const STAGE = Object.freeze({
  stageId: 'functional-design',
  phase: 'inception',
  agentRef: 'aidlc-architect-agent',
  inputArtifacts: [{ artifact: 'requirements', required: true }],
  outputArtifacts: [{ artifact: 'business-logic-model' }],
});

const SCOPE = Object.freeze({ executionId: 'e1', intentId: 'i1' });

const POLICY = Object.freeze({
  sensorsEnabled: true,
  reviewClass: 'adversarial',
  reviewArtifact: null,
  summaryConfirmation: 'none',
  changeControl: 'strict',
  learnings: 'on',
  skeleton: null,
});

describe('{{INVOKE}} dialect', () => {
  it('neutralizes the token to a clearly runtime-managed marker', () => {
    expect(neutralizeInvoke('run {{INVOKE}} engine gen scope-table')).toBe(
      'run <runtime-managed-engine> engine gen scope-table',
    );
  });

  it('appends the dialect annex only when the stage body carries the token', () => {
    const legacy = buildStagePrompt({ stage: STAGE, stageBody: '# Design\nDo the work.' });
    expect(legacy).not.toContain(INVOKE_DIALECT_ANNEX);
    expect(legacy).not.toContain('<runtime-managed-engine>');

    const body = '# Design\nRun `{{INVOKE}} engine orchestrate report --stage x --result done`.';
    const adapted = buildStagePrompt({ stage: STAGE, stageBody: body });
    const neutralized = buildStagePrompt({ stage: STAGE, stageBody: neutralizeInvoke(body) });

    expect(adapted).toBe(`${neutralized}\n\n${INVOKE_DIALECT_ANNEX}`);
    expect(adapted).not.toContain('{{INVOKE}}');
    expect(adapted).toContain('<runtime-managed-engine> engine orchestrate report');
  });

  it('detects the token in the conductor as well as the stage body', () => {
    const prompt = buildStagePrompt({
      stage: STAGE,
      stageBody: 'plain',
      conductor: 'Call {{INVOKE}} engine state practices-promote when a practice stabilizes.',
    });
    expect(prompt).toContain(INVOKE_DIALECT_ANNEX);
    expect(prompt).not.toContain('{{INVOKE}}');
  });

  // A release authors the persona and the reference knowledge to INSTRUCT the
  // agent just as it authors the stage body: the promotion guard counts an
  // engine command found in one of those bodies as answered, so the prompt that
  // renders it has to carry the answer. The compose prompt already gates on the
  // composer persona and its knowledge (commands/compose-plan-start.js); a stage
  // prompt renders the same kinds of body and gates on them the same way.
  it('appends the annex when the persona or the reference knowledge instructs', () => {
    for (const part of ['agentPersona', 'knowledge']) {
      const prompt = buildStagePrompt({
        stage: STAGE,
        stageBody: 'plain',
        [part]: 'Obtain the branch with `{{INVOKE}} engine worktree info --slug current`.',
      });
      expect(prompt, part).toContain(INVOKE_DIALECT_ANNEX);
      expect(prompt, part).not.toContain('{{INVOKE}}');
      expect(prompt, part).toContain('<runtime-managed-engine> engine worktree info');
    }
  });

  // The compiled context is runtime data the platform assembles, never authored
  // release content, so it is not evidence the guard reads and gating on it
  // would append the annex for an incidental quote.
  it('does not append the annex for an incidental mention in the compiled context', () => {
    const prompt = buildStagePrompt({
      stage: STAGE,
      stageBody: 'plain',
      compiledContext: 'Historically this ran {{INVOKE}} engine gen scope-table.',
    });
    expect(prompt).not.toContain(INVOKE_DIALECT_ANNEX);
    expect(prompt).not.toContain('{{INVOKE}}');
    expect(prompt).toContain('<runtime-managed-engine>');
  });

  it('never tells the agent a missing prerequisite is satisfied', () => {
    expect(INVOKE_DIALECT_ANNEX).not.toMatch(/treat that prerequisite as already satisfied/i);
    expect(INVOKE_DIALECT_ANNEX).not.toMatch(/prerequisite as (?:already )?satisfied/i);
    expect(INVOKE_DIALECT_ANNEX).toContain('is a GAP, not a satisfied prerequisite');
  });

  it('forbids fabricating engine-produced values and closes the command list', () => {
    expect(INVOKE_DIALECT_ANNEX).toContain('Never invent a value the engine would have generated');
    expect(INVOKE_DIALECT_ANNEX).toMatch(/no fingerprints/i);
    expect(INVOKE_DIALECT_ANNEX).toContain('closed list');
    expect(INVOKE_DIALECT_ANNEX).toMatch(/do not run anything and do not improvise/i);
  });

  it('makes practices promotion a recommendation, never a durable write', () => {
    expect(INVOKE_DIALECT_ANNEX).toMatch(/Do \*\*not\*\* call `record_learning_rule`/);
    expect(INVOKE_DIALECT_ANNEX).toMatch(/recommendation for the human/i);
  });

  it('says plainly that a human must rewind to recompose', () => {
    expect(INVOKE_DIALECT_ANNEX).toContain('RECOMMENDED STAGE ADDITION');
    expect(INVOKE_DIALECT_ANNEX).toMatch(/human must rewind and recompose/i);
  });

  it('maps every engine command family the annex is responsible for', () => {
    for (const fragment of [
      'orchestrate report',
      'recompose',
      'set-construction-iteration',
      'practices-event',
      'practices-promote',
      'scope-table',
      'codekb-scope-diff',
      'codekb --repo',
    ]) {
      expect(INVOKE_DIALECT_ANNEX).toContain(fragment);
    }
    expect(INVOKE_DIALECT_ANNEX).toContain('record_team_knowledge');
    expect(INVOKE_DIALECT_ANNEX).toContain('record_learning_rule');
    expect(INVOKE_DIALECT_ANNEX).toContain('emit_stage_note');
    expect(INVOKE_DIALECT_ANNEX).toContain('send_output');
  });

  // The promotion guard stops refusing a release for the families this annex
  // answers, so the two must not drift: a family dropped from the annex list
  // must stop being honoured, and a newly honoured family must be answered here.
  it('answers by name every engine-command family the promotion guard honours', () => {
    expect([...ANNEX_HANDLED_ENGINE_COMMANDS]).toContain('engine graph ars');
    for (const command of ANNEX_HANDLED_ENGINE_COMMANDS) {
      expect(INVOKE_DIALECT_ANNEX).toContain(`${command} `);
    }
  });

  // The composer persona of 2.8.2 and 2.9.0 runs `workspace detect`; the compose
  // prompt carries the platform's workspace signals instead.
  it('answers workspace detect from the workspace signals the compose prompt carries', () => {
    const row = INVOKE_DIALECT_ANNEX.split('\n').find((line) =>
      line.startsWith('- `engine workspace detect'),
    );
    expect(row).toContain('Workspace signals');
  });

  // Only a for_each stage runs in a per-unit lane; every other stage, such as
  // the pipeline and deployment stages whose agent invokes `worktree`, runs on
  // the intent branch.
  it('says which branch the working tree is on, in a lane and outside one', () => {
    const row = INVOKE_DIALECT_ANNEX.split('\n').find((line) =>
      line.startsWith('- `engine worktree create`'),
    );
    expect(row).toContain('In a per-unit lane your working tree is that unit');
    expect(row).toContain('otherwise it is the intent branch itself');
  });

  // A family classified `approximated` is no gap at all, so the annex is the only
  // place the agent learns what the platform does instead.
  it('answers by name every engine-command family classified approximated', () => {
    const approximated = INVOKE_FAMILY_FIDELITY.filter(
      (entry) => entry.handling === 'approximated',
    ).map((entry) => entry.family);

    expect(approximated).toEqual(
      expect.arrayContaining(['gen', 'workspace', 'worktree', 'graph validate-grid']),
    );
    for (const family of approximated) {
      expect(INVOKE_DIALECT_ANNEX, family).toContain(`engine ${family}`);
    }
  });
});

describe('scope policy in the stage prompt', () => {
  it('renders nothing for a legacy plan or an all-default policy', () => {
    expect(renderScopePolicy(null)).toBe('');
    expect(renderScopePolicy({ ...POLICY, changeControl: null })).toBe('');
    expect(buildStagePrompt({ stage: STAGE, stageBody: 'x' })).not.toContain('## Scope policy');
  });

  it('points at the confirm_summary checkpoint when confirmation is required', () => {
    const rendered = renderScopePolicy({ ...POLICY, summaryConfirmation: 'required' });
    expect(rendered).toContain('Summary confirmation is REQUIRED');
    // The checkpoint is a dedicated tool, not an ask_question the agent shapes:
    // the platform owns the two labels and the receipt they write.
    expect(rendered).toContain('confirm_summary');
    expect(rendered).not.toContain('ask_question');
  });

  it('points at the request_plan_approval checkpoint when plan approval applies', () => {
    const rendered = renderScopePolicy({ ...POLICY, planApproval: 'required' });
    expect(rendered).toContain('Plan approval is REQUIRED');
    expect(rendered).toContain('request_plan_approval');
  });

  // The registry declares `SCOPE:existing_code` handled by a seam in this
  // module, so the prompt must actually state the project type. Without this,
  // removing the whole block leaves the plan and registry suites green and the
  // "handled" claim is a comment.
  it('states the brownfield project type an existing-code scope authors', () => {
    const rendered = renderScopePolicy({ ...POLICY, existingCode: true });

    expect(rendered).toContain('Project type: BROWNFIELD');
    expect(
      buildStagePrompt({
        stage: { ...STAGE, policy: { ...POLICY, existingCode: true } },
        stageBody: 'x',
      }),
    ).toContain('Project type: BROWNFIELD');
  });

  // An explicit Greenfield choice is a DECISION, not an absence: the member said
  // there is no existing code. Rendering nothing for it made `false` and "the
  // release does not author the setting" the same prompt, so the choice had no
  // consumer at all.
  it('states the greenfield project type an explicit choice selects', () => {
    const rendered = renderScopePolicy({ ...POLICY, existingCode: false });

    expect(rendered).toContain('Project type: GREENFIELD');
    expect(
      buildStagePrompt({
        stage: { ...STAGE, policy: { ...POLICY, existingCode: false } },
        stageBody: 'x',
      }),
    ).toContain('Project type: GREENFIELD');
  });

  it('says nothing about the project type when the scope does not author it', () => {
    expect(renderScopePolicy({ ...POLICY, existingCode: null })).not.toContain('Project type');
  });

  // Workspace classification is the agent's own `record_project_type` path. When
  // the project type is already decided — by the scope or for this intent — that
  // decision wins: the stage records it instead of scanning and possibly
  // contradicting it.
  it('gives a decided project type precedence over the workspace scan', () => {
    const detection = (policy) =>
      buildStagePrompt({
        stage: { ...STAGE, stageId: 'workspace-detection', policy },
        stageBody: 'x',
      });

    const chosen = detection({
      ...POLICY,
      existingCode: false,
      existingCodeChoice: { source: 'intent' },
    });
    expect(chosen).toContain('`record_project_type`');
    expect(chosen).toContain('greenfield');
    expect(chosen).toContain('chosen for this intent by a project member');
    expect(chosen).not.toContain('deciding its project type');

    const scanned = detection({ ...POLICY, existingCode: null });
    expect(scanned).toContain('deciding its project type');
    expect(scanned).not.toContain('already decided');

    const fromScope = detection({
      ...POLICY,
      existingCode: true,
      existingCodeChoice: { source: 'scope-default' },
    });
    expect(fromScope).toContain('brownfield');
    expect(fromScope).toContain("the AI-DLC scope's own setting");
  });

  it('says nothing about learnings when the scope turns them off', () => {
    // `learnings: off` is enforced by WITHDRAWING the two tools in mcp/server.js,
    // so the prompt must not describe tools the agent cannot see.
    const rendered = renderScopePolicy({ ...POLICY, learnings: 'off' });
    expect(rendered).not.toContain('Learnings capture is OFF');
    expect(rendered).not.toContain('record_learning_rule');
    expect(rendered).not.toContain('record_team_knowledge');
  });

  it('explains both change-control modes', () => {
    expect(renderScopePolicy({ ...POLICY, changeControl: 'relaxed' })).toContain('CHANGE_ACCEPTED');
    expect(renderScopePolicy({ ...POLICY, changeControl: 'strict' })).toContain(
      'Change control is STRICT',
    );
  });

  it('states the skeleton ceremony and the advisory review class', () => {
    expect(renderScopePolicy({ ...POLICY, skeleton: 'on' })).toContain('Walking skeleton is ON');
    expect(renderScopePolicy({ ...POLICY, reviewClass: 'advisory' })).toContain(
      'Review is ADVISORY',
    );
    expect(renderScopePolicy({ ...POLICY, reviewClass: 'none' })).toContain(
      'No independent reviewer runs',
    );
  });

  it('injects the block into the prompt when the plan resolved a policy', () => {
    const prompt = buildStagePrompt({
      stage: { ...STAGE, policy: { ...POLICY, summaryConfirmation: 'required' } },
      stageBody: 'x',
    });
    expect(prompt).toContain('## Scope policy (authoritative for these rituals)');
    expect(prompt).toContain('Summary confirmation is REQUIRED');
  });
});

// A `fire_on: write` sweep reads workspace-relative paths, but
// git reports repo-relative ones. In multi-repo mode the two spaces differ.
describe('write-plane path space (multi-repo)', () => {
  it('leaves a single-repo path untouched', () => {
    expect(workspaceRelativePath({ repo: 'acme/api', file: 'src/a.ts', multi: false })).toBe(
      'src/a.ts',
    );
  });

  it('projects a repo-relative path into the workspace layout when multi-repo', () => {
    expect(workspaceRelativePath({ repo: 'acme/api', file: 'src/a.ts', multi: true })).toBe(
      'acme/api/src/a.ts',
    );
  });

  it('drops a path it cannot project rather than emitting a traversal', () => {
    expect(workspaceRelativePath({ repo: '../escape', file: 'src/a.ts', multi: true })).toBeNull();
    expect(workspaceRelativePath({ repo: 'acme/api', file: '', multi: true })).toBeNull();
    expect(workspaceRelativePath({ repo: 'acme/api', file: undefined, multi: true })).toBeNull();
  });
});

describe('AGENT.maxTurns on the OpenCode driver', () => {
  const base = { mcpEntry: '/srv/mcp.js', scope: SCOPE };

  it('emits no agent block when the block declares no cap', () => {
    expect(buildOpenCodeConfig(base).agent).toBeUndefined();
    expect(buildOpenCodeConfig({ ...base, maxTurns: null }).agent).toBeUndefined();
  });

  it('maps a declared cap onto the run agent step limit', () => {
    expect(buildOpenCodeConfig({ ...base, maxTurns: 60 }).agent).toEqual({
      [OPENCODE_DEFAULT_AGENT]: { steps: 60 },
    });
  });

  it('ignores a value that is not a positive integer rather than emitting junk', () => {
    for (const maxTurns of [0, -1, 12.5, '60', 'lots']) {
      expect(buildOpenCodeConfig({ ...base, maxTurns }).agent).toBeUndefined();
    }
  });

  it('keeps the reserved aidlc MCP entry last so a cap cannot reorder it', () => {
    const config = buildOpenCodeConfig({ ...base, maxTurns: 60 });
    expect(Object.keys(config.mcp).at(-1)).toBe('aidlc');
  });
});

describe('sensor fire_on planes', () => {
  let workspaceDir;
  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'sensor-release-adapter-'));
  });
  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });
  const graph = {
    lookupArtifacts: vi.fn(async () => []),
  };
  const runner = () =>
    createSensorRunner({
      graph,
      loadBlockScript: async () => '',
      workspaceDir: null,
      spawnFn: vi.fn(),
    });

  const scriptSensor = (extra = {}) => ({
    sensorId: 'linter',
    runtime: 'bun',
    command: 'bun run linter',
    matches: '**/*.ts',
    severity: 'advisory',
    ...extra,
  });

  it('records not-applicable for a gate sensor with no matching deliverable', async () => {
    const created = createSensorRunner({
      graph,
      loadBlockScript: async () => 'export default 1;',
      workspaceDir,
      spawnFn: vi.fn(),
    });
    const [verdict] = await created.runStageSensors({
      sensors: [scriptSensor({ fireOn: 'gate' })],
      stageId: 'code-generation',
    });
    expect(verdict.result).toBe('INCONCLUSIVE');
    expect(verdict.detail).toMatchObject({ notApplicable: true, fireOn: 'gate' });
    expect(verdict.held).toBe(false);
  });

  it('narrows a write-plane sensor to this attempt\u2019s changed files', async () => {
    await writeFile(path.join(workspaceDir, 'untouched.ts'), 'export {};');
    const spawnFn = vi.fn(() => {
      throw new Error('should not spawn: no changed file matches');
    });
    const created = createSensorRunner({
      graph,
      loadBlockScript: async () => 'export default 1;',
      workspaceDir,
      spawnFn,
    });
    const [verdict] = await created.runStageSensors({
      sensors: [scriptSensor({ fireOn: 'write' })],
      stageId: 'code-generation',
      changedFiles: ['README.md', 'docs/guide.md'],
    });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(verdict.result).toBe('INCONCLUSIVE');
    expect(verdict.detail).toMatchObject({
      reason: 'no changed files match',
      applicability: 'NOT_APPLICABLE',
      provenance: { state: 'known', files: ['README.md', 'docs/guide.md'] },
    });
    expect(verdict.detail.notApplicable).toBeUndefined();
  });

  it('keeps a sensor without fire_on on the workspace-wide sweep', async () => {
    const [verdict] = await runner().runStageSensors({
      sensors: [scriptSensor()],
      stageId: 'code-generation',
    });
    expect(verdict.result).toBe('INCONCLUSIVE');
    expect(verdict.detail).toEqual({ reason: 'no workspace' });
  });

  // A gate-plane sensor may only report not-applicable when
  // it found NOTHING to say. A missing REQUIRED deliverable is a finding, and
  // suppressing it behind `notApplicable` was hiding exactly the failure the
  // gate plane exists to catch.
  it('keeps a missing required deliverable as a finding even on the gate plane', async () => {
    const [verdict] = await runner().runStageSensors({
      sensors: [
        { sensorId: 'required-sections', severity: 'advisory', fireOn: 'gate', category: 'docs' },
      ],
      outputArtifacts: [{ artifact: 'business-logic-model' }],
      stageId: 'functional-design',
    });
    expect(verdict.kind).toBe('graph');
    expect(verdict.detail.notApplicable).toBeUndefined();
    expect(verdict.detail.artifacts).toEqual([
      { artifact: 'business-logic-model', reason: 'not found in graph' },
    ]);
  });

  it('reports a gate graph sensor as not-applicable when nothing was applicable', async () => {
    const [verdict] = await runner().runStageSensors({
      sensors: [
        { sensorId: 'required-sections', severity: 'advisory', fireOn: 'gate', category: 'docs' },
      ],
      // Only an OPTIONAL output: its absence is by design, so the sensor records
      // no finding and the gate plane genuinely has no deliverable to inspect.
      outputArtifacts: [{ artifact: 'frontend-components', optional: true }],
      stageId: 'functional-design',
    });
    expect(verdict.kind).toBe('graph');
    expect(verdict.detail).toMatchObject({ notApplicable: true, fireOn: 'gate' });
  });

  it('still reports a missing required deliverable when fire_on is absent', async () => {
    const [verdict] = await runner().runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'advisory', category: 'docs' }],
      outputArtifacts: [{ artifact: 'business-logic-model' }],
      stageId: 'functional-design',
    });
    expect(verdict.detail.notApplicable).toBeUndefined();
    expect(verdict.detail.artifacts).toEqual([
      { artifact: 'business-logic-model', reason: 'not found in graph' },
    ]);
  });
});

// `annex-reach.js` is a claim the PROMPT BUILDERS have to honour: the promotion
// guard stops blocking an engine command found in one of these blocks, so every
// session the runtime renders that block into must receive the answer. The
// builders and the guard share one module, but sharing a set is not the same as
// delivering it — a builder could gate on a part this set does not name, or stop
// gating on one it does. So rather than restate the rule, each case below walks
// the blocks of a REAL catalog and asserts the REAL prompt of each session that
// renders the block.
describe('annex reach, against the prompts the runtime really builds', () => {
  const PROFILE = 'v2.9.0';
  const { catalog } = buildReleaseBundle({
    profileId: PROFILE,
    files: filesFromCompatibilityFixture({
      profileId: PROFILE,
      fixture: JSON.parse(
        readFileSync(
          new URL(
            `../../shared/test/fixtures/aidlc-compatibility/${PROFILE}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    }),
  });
  const TOKEN_BODY = 'Run `{{INVOKE}} engine state practices-event --type x`.';
  const STAGES = catalog.blocks.STAGE;
  // These are CATALOG blocks (`block-mappers.js` `mapStage`), whose shape is
  // `supportAgents` and a `reviewer` STRING naming the reviewing agent — not the
  // resolved plan's `supportAgentRefs` / `reviewer.reviewerAgent`. Reading the
  // plan's field names here leaves both sets empty and silently reduces the
  // whole check to lead sessions, so the enumeration is pinned below.
  const LEAD_AGENTS = new Set(STAGES.map((stage) => stage.leadAgent).filter(Boolean));
  const SUPPORT_AGENTS = new Set(STAGES.flatMap((stage) => stage.supportAgents ?? []));
  const REVIEWER_AGENTS = new Set(STAGES.map((stage) => stage.reviewer).filter(Boolean));
  // The agentRef `loadMethodologyKnowledge` (commands/run-stage.js) renders into
  // every session regardless of which agent runs it.
  const SHARED_KNOWLEDGE_AGENT_REF = 'shared';
  const label = (block) => `${block.type}:${block.id}`;

  // One entry per session kind the runtime spawns, each rendering ONE authored
  // part through the builder that session really uses. `part` is `persona` or
  // `knowledge`: a release authors engine commands in both, and the guard counts
  // them the same way.
  const PROMPTS = Object.freeze({
    lead: (part, body) =>
      buildStagePrompt({
        stage: STAGE,
        stageBody: 'plain',
        ...(part === 'persona' ? { agentPersona: body } : { knowledge: body }),
      }),
    reviewer: (part, body) =>
      runStageInternals.buildReviewerPrompt({
        stage: { ...STAGE, reviewer: { artifact: 'business-logic-model' } },
        reviewerAgent: 'aidlc-architecture-reviewer-agent',
        reviewerPersona: part === 'persona' ? body : 'reviewer persona',
        knowledge: part === 'knowledge' ? body : '',
        round: 1,
      }),
    support: (part, body) => personaBrief('support', part, body),
    link: (part, body) => personaBrief('link', part, body),
    integrator: (part, body) => personaBrief('integrator', part, body),
    composer: (part, body) =>
      buildComposePrompt({
        mode: 'initial',
        persona: part === 'persona' ? body : '',
        knowledge: part === 'knowledge' ? body : '',
      }),
  });
  // The COMPOSER session registers no platform tools, so the form that has to
  // reach it is the tool-less one: an answer naming a tool it cannot call would
  // be reach without delivery (commands/compose-plan-start.js).
  const TOOLLESS_ANNEX = invokeDialectAnnex({ toolless: true });
  const expectedAnnex = (session) =>
    session === 'composer' ? TOOLLESS_ANNEX : INVOKE_DIALECT_ANNEX;

  const personaBrief = (role, part, body) =>
    composePersonaPrompt({
      brief: `${role} brief`,
      persona: part === 'persona' ? body : 'p',
      knowledge: part === 'knowledge' ? body : '',
      role,
    });

  // Which sessions render ONE claimed block, read off the real catalog. An agent
  // that leads one stage is frequently a support persona or the reviewer in
  // another, so these are not exclusive.
  const sessionsRendering = (block) => {
    if (block.type === 'STAGE') return ['lead'];
    const agentRef = block.type === 'AGENT' ? block.blockId : block.agentRef;
    if (agentRef === COMPOSER_AGENT_ID) return ['composer'];
    if (agentRef === SHARED_KNOWLEDGE_AGENT_REF) {
      return ['lead', 'reviewer', 'support', 'link', 'integrator'];
    }
    const sessions = [];
    if (LEAD_AGENTS.has(agentRef)) sessions.push('lead');
    if (REVIEWER_AGENTS.has(agentRef)) sessions.push('reviewer');
    if (SUPPORT_AGENTS.has(agentRef)) sessions.push('support', 'link', 'integrator');
    return sessions;
  };

  it('enumerates the catalog lead, support and reviewer agents, including dual-role ones', () => {
    expect(LEAD_AGENTS.size).toBeGreaterThan(0);
    expect(SUPPORT_AGENTS.size).toBeGreaterThan(0);
    expect(REVIEWER_AGENTS.size).toBeGreaterThan(0);
    const dualRole = [...LEAD_AGENTS].filter(
      (ref) => SUPPORT_AGENTS.has(ref) || REVIEWER_AGENTS.has(ref),
    );
    expect(dualRole.length).toBeGreaterThan(0);
    expect(sessionsRendering({ type: 'KNOWLEDGE', agentRef: dualRole[0] }).length).toBeGreaterThan(
      1,
    );
  });

  it('answers a claimed body in every session the runtime renders it into', () => {
    const claimed = annexReachingBlocks({ blocks: catalog.blocks });
    const checked = [];

    for (const block of claimed) {
      const sessions = sessionsRendering(block);
      // A claimed body no session renders would make the guard's claim vacuous
      // rather than wrong, and it would still be a hole: nothing would prove the
      // answer arrives.
      expect(sessions.length, label(block)).toBeGreaterThan(0);
      const parts = block.type === 'STAGE' ? ['stageBody'] : ['persona', 'knowledge'];
      for (const session of sessions) {
        for (const part of parts) {
          const prompt =
            part === 'stageBody'
              ? buildStagePrompt({ stage: STAGE, stageBody: TOKEN_BODY })
              : PROMPTS[session](part, TOKEN_BODY);
          const where = `${label(block)}:${session}:${part}`;
          expect(prompt, where).toContain(expectedAnnex(session));
          expect(prompt, where).not.toContain('{{INVOKE}}');
          if (session === 'composer') {
            expect(prompt, where).toContain('**You have no platform tools in this session.**');
            expect(prompt, where).not.toContain('`emit_stage_note`');
          }
          checked.push(`${session}:${part}`);
        }
      }
    }

    // Every session kind had to be exercised, or the catalog stopped covering a
    // role and the check quietly narrowed to the ones that remain.
    expect([...new Set(checked.map((entry) => entry.split(':')[0]))].toSorted()).toEqual(
      Object.keys(PROMPTS).toSorted(),
    );
    expect(checked.length).toBeGreaterThan(claimed.length);
  });

  // The other half of the claim: a body type NO builder gates on must stay out
  // of the set, because a command invoked only there reaches a session with no
  // answer and has to keep holding promotion.
  it('leaves the block types no builder gates on out of the set', () => {
    const claimedTypes = new Set(
      annexReachingBlocks({ blocks: catalog.blocks }).map((b) => b.type),
    );

    expect([...claimedTypes].toSorted()).toEqual(['AGENT', 'KNOWLEDGE', 'STAGE']);
    for (const type of ['RULE', 'SCOPE', 'ARTIFACT', 'SENSOR']) {
      expect((catalog.blocks[type] ?? []).length, type).toBeGreaterThan(0);
      expect(claimedTypes.has(type), type).toBe(false);
    }
  });
});

// AI-DLC 2.11's engine commands, against the REAL release: the exact verbatim
// `{{INVOKE}} engine` lines of the pinned upstream commit, in the files that
// carry them, mapped back onto the blocks the release imports.
//
// Two claims are proved here: the eleven refused commands are answered BY NAME
// with an answer that forbids fabricating a result, and every body that
// instructs one of them reaches a prompt that carries the annex. Reach is read
// off the ONE definition the promotion guard uses, never re-derived from a path,
// so a body type no prompt builder annexes would fail here rather than be
// quietly admitted.
describe('AI-DLC 2.11 engine commands, in the real release', () => {
  const PROFILE = 'v2.11.0';
  const INVOKE_LINES = JSON.parse(
    readFileSync(
      new URL('../../shared/test/fixtures/aidlc-release-invoke-lines.json', import.meta.url),
      'utf8',
    ),
  )[PROFILE];
  const fixtureFiles = filesFromCompatibilityFixture({
    profileId: PROFILE,
    fixture: JSON.parse(
      readFileSync(
        new URL(`../../shared/test/fixtures/aidlc-compatibility/${PROFILE}.json`, import.meta.url),
        'utf8',
      ),
    ),
  });
  // Each instructing file is tagged with a unique marker before the import, so
  // the block the importer made of it can be identified afterwards by the
  // marker in its body. Reach itself is read off the ONE definition the
  // promotion guard uses — nothing here re-derives the rule from a path.
  const PATHS = Object.keys(INVOKE_LINES.files).toSorted();
  const marker = (path) => `reach-probe-${PATHS.indexOf(path)}-end`;
  for (const path of PATHS) {
    expect(fixtureFiles.has(path), path).toBe(true);
    fixtureFiles.set(
      path,
      `${fixtureFiles.get(path)}\n${INVOKE_LINES.files[path].join('\n')}\n${marker(path)}\n`,
    );
  }
  const { catalog, objects } = buildReleaseBundle({ profileId: PROFILE, files: fixtureFiles });
  const bodyByKey = new Map(objects.map((object) => [object.key, object.body ?? '']));
  const bodiesOf = (blocks) =>
    blocks.map((block) => bodyByKey.get(block.bodyRef?.s3Key) ?? '').join('\n');
  const pathsIn = (blocks) => {
    const joined = bodiesOf(blocks);
    return new Set(PATHS.filter((path) => joined.includes(marker(path))));
  };
  const CONDUCTOR_PATH = 'core/aidlc-common/conductor.md';
  // What the promotion guard reads as prompt evidence at all: the bodies of the
  // blocks a release library resolves, plus the conductor. An upstream protocol,
  // hook or tool source is NOT evidence — it is the engine's own implementation
  // and no prompt renders it — so a command named only there was never a
  // blocker and is not claimed as answered either.
  const promptEvidence = new Set([
    ...pathsIn(Object.keys(RELEASE_LIBRARY_TYPES).flatMap((type) => catalog.blocks[type] ?? [])),
    CONDUCTOR_PATH,
  ]);
  const reaching = pathsIn(annexReachingBlocks({ blocks: catalog.blocks }));

  // The fourteen engine commands the real 2.11.0 prompt bodies invoke, verbatim.
  const REFUSED = Object.freeze([
    'engine config set',
    'engine log answer',
    'engine log decision',
    'engine orchestrate next',
    'engine state set-construction-execution',
    'engine state set-construction-verification-command',
    'engine testing-posture restore',
    'engine worktree discard',
    'engine worktree list',
    'engine worktree purge',
    'engine worktree restore',
  ]);
  const APPROXIMATED = Object.freeze([
    'engine audit append-raw',
    'engine config get',
    'engine now',
  ]);

  const filesInvoking = (command) =>
    Object.entries(INVOKE_LINES.files)
      .filter(([, lines]) => lines.some((line) => line.includes(`{{INVOKE}} ${command}`)))
      .map(([path]) => path);

  it('finds all fourteen commands in the release bodies', () => {
    for (const command of [...REFUSED, ...APPROXIMATED]) {
      expect(filesInvoking(command), command).not.toEqual([]);
    }
  });

  it('answers every refused command by name, and never tells the agent to produce a result', () => {
    for (const command of REFUSED) {
      const row = INVOKE_DIALECT_ANNEX.split('\n').find(
        (line) => line.startsWith('- `') && line.includes(command),
      );
      expect(row, command).toBeTruthy();
      expect(row, command).toMatch(/Refused|Do not run|do not run|unavailable/);
    }
    // And the annex's standing rules forbid the fabrication every one of those
    // rows would otherwise invite.
    expect(INVOKE_DIALECT_ANNEX).toContain('Never claim you ran an engine command');
    expect(INVOKE_DIALECT_ANNEX).toContain('Never invent a value the engine would have generated');
    expect(INVOKE_DIALECT_ANNEX).toContain('is a GAP, not a satisfied prerequisite');
  });

  it('honours a refused command only where the annex reaches every instructing body', () => {
    for (const command of REFUSED) {
      const evidence = filesInvoking(command).filter((path) => promptEvidence.has(path));
      expect(evidence, `${command} has no prompt-evidence body`).not.toEqual([]);
      for (const path of evidence) {
        expect(
          reaching.has(path) || path === CONDUCTOR_PATH,
          `${command} is instructed from ${path}, which no annex-bearing prompt renders`,
        ).toBe(true);
      }
    }
  });

  // The guard's evidence boundary, stated rather than assumed: 2.11 names engine
  // commands in its own protocol and tool sources too, and those are deliberately
  // not prompt evidence.
  it('reads no engine command out of a file no prompt renders', () => {
    const outsideEvidence = PATHS.filter((path) => !promptEvidence.has(path));

    expect(outsideEvidence).not.toEqual([]);
    expect(outsideEvidence.every((path) => !reaching.has(path))).toBe(true);
    expect(outsideEvidence.some((path) => path.startsWith('core/aidlc-common/protocols/'))).toBe(
      true,
    );
  });

  // The three approximated families are judged by the SAME reach as a refused
  // command: their substitute is named only in the annex, so a session that does
  // not receive it holds the authored step with no answer either way. `annexed`
  // on the approximated entry is what makes that claim checkable, and it is read
  // from the entry rather than from the honoured list, which — like #521's four
  // approximated families — never names them. In the real release every
  // instructing body of all three reaches an annex-bearing prompt, so they are
  // honoured here; a release that moves one into a body no builder gates on is
  // refused by name (release-registry.test.js).
  it('honours an approximated command only where the annex reaches every instructing body', () => {
    for (const command of APPROXIMATED) {
      const evidence = filesInvoking(command).filter((path) => promptEvidence.has(path));
      expect(evidence, `${command} has no prompt-evidence body`).not.toEqual([]);
      for (const path of evidence) {
        expect(
          reaching.has(path) || path === CONDUCTOR_PATH,
          `${command} is instructed from ${path}, which no annex-bearing prompt renders`,
        ).toBe(true);
      }
      expect(
        INVOKE_FAMILY_FIDELITY.find((entry) => `engine ${entry.family}` === command),
        command,
      ).toMatchObject({ handling: 'approximated', annexed: true });
      expect(INVOKE_DIALECT_ANNEX, command).toContain(`${command} `);
    }
  });

  // The completeness invariant: a name the promotion guard honours must resolve
  // to an annex row that refuses it. A name with neither is a failure here, not
  // a silent pass at promotion time.
  it('answers by name every command the promotion guard honours', () => {
    for (const command of ANNEX_HANDLED_ENGINE_COMMANDS) {
      expect(INVOKE_DIALECT_ANNEX, command).toContain(`${command} `);
    }
    expect([...ANNEX_HANDLED_ENGINE_COMMANDS].toSorted()).toEqual(
      [
        'engine graph ars',
        'engine orchestrate',
        'engine recompose',
        'engine state',
        ...REFUSED,
      ].toSorted(),
    );
  });

  // Three refusals are engine MACHINERY rather than a command, so no
  // `{{INVOKE}}` scanner reports them and only the annex can state them.
  // The generic "never claim you ran it" rules are not those named answers.
  it('names the engine machinery it refuses, not only the commands', () => {
    const section = INVOKE_DIALECT_ANNEX.slice(
      INVOKE_DIALECT_ANNEX.indexOf('Engine-owned machinery this runtime does not have'),
      INVOKE_DIALECT_ANNEX.indexOf('Rules that override any engine-flavoured prose'),
    );

    expect(section).toContain('The Plan Approval state machine');
    expect(section).toMatch(/`plan` \/ `revise` \/ `repair` \/ `approved` states/);
    expect(section).toContain('The review-finding ledger');
    expect(section).toMatch(/do not invent an id, a status or a disposition/);
    expect(section).toContain('Unit-preserving replans');
    expect(section).toContain('a human decides the rewind target');
  });

  it('answers `doctor` and the CodeKB publication check, which no scanner reports', () => {
    expect(INVOKE_DIALECT_ANNEX).toContain('doctor');
    expect(INVOKE_DIALECT_ANNEX).toMatch(/never emit `VALID`\/`INVALID`|never emit VALID/);
    expect(INVOKE_DIALECT_ANNEX).toContain('codekb-scope-diff --check');
  });
});
