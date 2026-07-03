import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTPUT_CONTRACT,
  MCP_EXECUTION_ANNEX,
  neutralizeHarnessDir,
  buildStagePrompt,
  renderUnitScope,
  buildMcpConfig,
  buildKiroAgentConfig,
  materializeKiroAgent,
  KIRO_AGENT_NAME,
  renderRulesDoc,
  materializeStage,
} from '../stage-materializer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The real, filesystem-laden upstream stage body — proves the annex governs
// genuine prose (aidlc-docs paths, bun tools, [Answer]: files, approval block).
const upstreamBody = readFileSync(path.join(here, 'fixtures', 'requirements-analysis.md'), 'utf8');

const stage = (extra = {}) => ({
  stageId: 'requirements-analysis',
  phase: 'inception',
  agentRef: 'aidlc-product-agent',
  inputArtifacts: [{ artifact: 'intent-capture', required: true, producedBy: ['intent-capture'] }],
  outputArtifacts: [{ artifact: 'requirements-analysis' }],
  rules: { universal: ['aidlc-org', 'aidlc-team'], phase: ['aidlc-phase-inception'] },
  humanValidation: 'required',
  ...extra,
});

describe('buildStagePrompt', () => {
  it('includes role, instructions, inputs, outputs, and the output contract', () => {
    const prompt = buildStagePrompt({
      stage: stage(),
      stageBody: 'Analyze the intent.',
      agentPersona: 'You are a product manager.',
      knowledge: 'Requirements elicitation guide.',
    });
    expect(prompt).toContain('# Stage: requirements-analysis');
    expect(prompt).toContain('aidlc-product-agent');
    expect(prompt).toContain('## Your role');
    expect(prompt).toContain('Analyze the intent.');
    expect(prompt).toContain('- intent-capture — from intent-capture');
    expect(prompt).toContain('- requirements-analysis');
    expect(prompt).toContain('## Reference knowledge');
    expect(prompt).toContain('reviewed by a human out-of-band');
    expect(prompt).toContain(OUTPUT_CONTRACT);
  });

  it('renders "none" for empty inputs/outputs and omits optional sections', () => {
    const prompt = buildStagePrompt({
      stage: stage({ inputArtifacts: [], outputArtifacts: [], humanValidation: 'none' }),
      stageBody: 'x',
    });
    expect(prompt).toContain('## Inputs (read via the MCP tools)\n- none');
    expect(prompt).not.toContain('## Your role');
    expect(prompt).not.toContain('## Reference knowledge');
    expect(prompt).not.toContain('reviewed by a human out-of-band');
    // The annex is unconditional — present even when optional sections are omitted.
    expect(prompt).toContain(MCP_EXECUTION_ANNEX);
  });

  it('calls out an expectedAbsent input so the agent never fabricates it (lean scopes)', () => {
    const prompt = buildStagePrompt({
      stage: stage({
        inputArtifacts: [
          { artifact: 'intent-capture', required: true, producedBy: ['intent-capture'] },
          { artifact: 'unit-of-work', required: true, expectedAbsent: true, producedBy: [] },
        ],
      }),
      stageBody: 'x',
    });
    // Present inputs keep the normal rendering.
    expect(prompt).toContain('- intent-capture — from intent-capture');
    // Absent-by-design inputs carry the explicit degradation instruction.
    expect(prompt).toContain('- unit-of-work — NOT produced in this scope');
    expect(prompt).toContain('Do NOT fabricate its content');
    expect(prompt).toContain('fall back to the available in-scope context');
  });
});

describe('buildStagePrompt — MCP execution annex binding', () => {
  it('injects the annex exactly once, ahead of the stage body and the output contract', () => {
    const prompt = buildStagePrompt({
      stage: stage(),
      stageBody: upstreamBody,
      agentPersona: 'You are a product manager.',
    });
    // Present exactly once.
    expect(prompt.split(MCP_EXECUTION_ANNEX)).toHaveLength(2);
    // Ordering: annex < persona < stage instructions < output contract.
    const iAnnex = prompt.indexOf(MCP_EXECUTION_ANNEX);
    const iRole = prompt.indexOf('## Your role');
    const iBody = prompt.indexOf('## Stage instructions');
    const iContract = prompt.indexOf(OUTPUT_CONTRACT);
    expect(iAnnex).toBeGreaterThanOrEqual(0);
    expect(iAnnex).toBeLessThan(iRole);
    expect(iRole).toBeLessThan(iBody);
    expect(iBody).toBeLessThan(iContract);
  });

  it('carries the translation-table keywords the agent needs to redirect to MCP', () => {
    const prompt = buildStagePrompt({ stage: stage(), stageBody: upstreamBody });
    for (const kw of [
      'overrides stage mechanics',
      'create_artifact',
      'ask_question',
      'send_output',
      'IGNORE',
      'runtime-owned bookkeeping',
    ]) {
      expect(prompt).toContain(kw);
    }
  });

  it('neutralizes every {{HARNESS_DIR}} token from the rendered prompt', () => {
    // The fixture body carries multiple raw tokens.
    expect(upstreamBody).toContain('{{HARNESS_DIR}}');
    const prompt = buildStagePrompt({
      stage: stage(),
      stageBody: upstreamBody,
      agentPersona: 'knowledge from {{HARNESS_DIR}}/knowledge/',
      knowledge: 'see {{HARNESS_DIR}}/rules/',
    });
    expect(prompt).not.toContain('{{HARNESS_DIR}}');
    expect(prompt).toContain('<runtime-managed>');
  });

  it('still emits the annex when the stage body is empty', () => {
    const prompt = buildStagePrompt({ stage: stage(), stageBody: '' });
    expect(prompt.split(MCP_EXECUTION_ANNEX)).toHaveLength(2);
    expect(prompt).toContain('(no stage body supplied)');
  });
});

describe('neutralizeHarnessDir', () => {
  it('replaces every occurrence and leaves token-free text untouched', () => {
    expect(neutralizeHarnessDir('{{HARNESS_DIR}}/a and {{HARNESS_DIR}}/b')).toBe(
      '<runtime-managed>/a and <runtime-managed>/b',
    );
    expect(neutralizeHarnessDir('no token here')).toBe('no token here');
    expect(neutralizeHarnessDir('')).toBe('');
  });
});

describe('buildMcpConfig', () => {
  it('points at the stdio MCP entry and passes the trusted scope as child ENV', () => {
    const cfg = buildMcpConfig({
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: {
        executionId: 'e1',
        intentId: 'i1',
        projectId: 'p1',
        stageInstanceId: 'si1',
        role: 'author',
      },
      env: { V2_PROCESS_TABLE: 'proc', NEPTUNE_ENDPOINT: 'neptune', AWS_REGION: 'us-east-1' },
    });
    expect(cfg.mcpServers.aidlc.command).toBe('node');
    expect(cfg.mcpServers.aidlc.args).toEqual(['/opt/agentcore/mcp/index.js']);
    expect(cfg.mcpServers.aidlc.env).toMatchObject({
      V2_EXECUTION_ID: 'e1',
      V2_INTENT_ID: 'i1',
      V2_PROJECT_ID: 'p1',
      V2_STAGE_INSTANCE_ID: 'si1',
      V2_MCP_ROLE: 'author',
      V2_PROCESS_TABLE: 'proc',
      NEPTUNE_ENDPOINT: 'neptune',
    });
  });

  it('defaults the role to author', () => {
    const cfg = buildMcpConfig({ mcpEntry: 'x', scope: { executionId: 'e', intentId: 'i' } });
    expect(cfg.mcpServers.aidlc.env.V2_MCP_ROLE).toBe('author');
  });
});

describe('renderRulesDoc', () => {
  it('concatenates universal + phase rule bodies, skipping missing ones', () => {
    const doc = renderRulesDoc(stage(), {
      'aidlc-org': 'ORG RULES',
      'aidlc-phase-inception': 'INCEPTION RULES',
      // aidlc-team body intentionally missing
    });
    expect(doc).toContain('ORG RULES');
    expect(doc).toContain('INCEPTION RULES');
    expect(doc).not.toContain('undefined');
  });
});

describe('materializeStage (workspace write)', () => {
  it('writes rules.md + mcp-config.json into .aidlc and returns the prompt', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-ws-'));
    const out = await materializeStage({
      workspaceDir: ws,
      stage: stage(),
      stageBody: 'do it',
      agentPersona: 'persona',
      knowledge: '',
      rulesDoc: 'RULES',
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1', projectId: 'p1', stageInstanceId: 'si1' },
      env: { V2_PROCESS_TABLE: 'proc' },
    });
    expect(out.prompt).toContain('# Stage: requirements-analysis');
    const cfg = JSON.parse(await readFile(out.mcpConfigPath, 'utf8'));
    expect(cfg.mcpServers.aidlc.env.V2_EXECUTION_ID).toBe('e1');
    expect(await readFile(path.join(ws, '.aidlc', 'rules.md'), 'utf8')).toBe('RULES');
  });
});

describe('buildKiroAgentConfig', () => {
  it('wraps the same MCP server spec in a Kiro agent envelope', () => {
    const cfg = buildKiroAgentConfig({
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1' },
      env: { V2_PROCESS_TABLE: 'proc' },
    });
    expect(cfg.name).toBe(KIRO_AGENT_NAME);
    // Same server spec buildMcpConfig produces, just under the agent envelope.
    expect(cfg.mcpServers.aidlc.command).toBe('node');
    expect(cfg.mcpServers.aidlc.env.V2_EXECUTION_ID).toBe('e1');
    expect(cfg.tools).toEqual(['*']);
  });
});

describe('materializeKiroAgent (workspace write)', () => {
  it('writes .kiro/agents/aidlc.json and returns the agent name', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-kiro-'));
    const name = await materializeKiroAgent({
      workspaceDir: ws,
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1' },
      env: { V2_PROCESS_TABLE: 'proc' },
    });
    expect(name).toBe('aidlc');
    const cfg = JSON.parse(await readFile(path.join(ws, '.kiro', 'agents', 'aidlc.json'), 'utf8'));
    expect(cfg.name).toBe('aidlc');
    expect(cfg.mcpServers.aidlc.env.V2_EXECUTION_ID).toBe('e1');
  });
});

// ── WP4: unit lanes (docs/v2-parallel.md) ────────────────────────────────────

describe('renderUnitScope + the prompt unit-scope block', () => {
  it('renders the unit, its dependencies, and the lane boundary', () => {
    const block = renderUnitScope({ slug: 'billing', dependsOn: ['auth', 'catalog'] });
    expect(block).toContain('## Unit scope (fan-out)');
    expect(block).toContain('**billing**');
    expect(block).toContain('Depends on (already completed): auth, catalog');
  });

  it('renders "none" for an independent unit and empty for no unit', () => {
    expect(renderUnitScope({ slug: 'auth', dependsOn: [] })).toContain(
      'Depends on (already completed): none',
    );
    expect(renderUnitScope(null)).toBe('');
    expect(renderUnitScope({})).toBe('');
  });

  it('buildStagePrompt injects the unit block BEFORE the stage instructions on lane runs only', () => {
    const withUnit = buildStagePrompt({
      stage: stage(),
      unit: { slug: 'billing', dependsOn: ['auth'] },
      stageBody: 'Generate the code.',
    });
    expect(withUnit).toContain('## Unit scope (fan-out)');
    expect(withUnit.indexOf('## Unit scope (fan-out)')).toBeLessThan(
      withUnit.indexOf('## Stage instructions'),
    );
    const withoutUnit = buildStagePrompt({ stage: stage(), stageBody: 'x' });
    expect(withoutUnit).not.toContain('## Unit scope');
  });
});

describe('buildMcpConfig — unit lane scope', () => {
  it('passes V2_UNIT_SLUG to the MCP child env (empty outside a lane)', () => {
    const laneCfg = buildMcpConfig({
      mcpEntry: 'x',
      scope: { executionId: 'e', intentId: 'i', unitSlug: 'billing' },
    });
    expect(laneCfg.mcpServers.aidlc.env.V2_UNIT_SLUG).toBe('billing');
    const plainCfg = buildMcpConfig({ mcpEntry: 'x', scope: { executionId: 'e', intentId: 'i' } });
    expect(plainCfg.mcpServers.aidlc.env.V2_UNIT_SLUG).toBe('');
  });
});

// ── The intent must reach the agent ──────────────────────────────────────────

import { renderIntentBlock } from '../stage-materializer.js';

describe('renderIntentBlock + prompt placement', () => {
  it('renders title, scope, and the originating request with the precedence note', () => {
    const block = renderIntentBlock({
      title: 'Bookstore API',
      prompt: 'Build a REST API for a bookstore with auth and orders.',
      scope: 'feature',
    });
    expect(block).toContain('## The intent (originating request)');
    expect(block).toContain('**Bookstore API** (scope: feature)');
    expect(block).toContain('Build a REST API for a bookstore');
    expect(block).toContain('take');
    expect(block).toContain('precedence over this raw request');
  });

  it('tolerates partial/absent intent (no empty section rendered)', () => {
    expect(renderIntentBlock({})).toBe('');
    expect(renderIntentBlock()).toBe('');
    expect(renderIntentBlock({ title: 'T only' })).toContain('**T only**');
    expect(renderIntentBlock({ prompt: 'P only' })).toContain('P only');
  });

  it('buildStagePrompt places the intent right after the annex, before the stage prose', () => {
    const prompt = buildStagePrompt({
      stage: stage(),
      intent: { title: 'Bookstore API', prompt: 'Build it.', scope: 'feature' },
      stageBody: 'Analyze the intent.',
    });
    const annexIdx = prompt.indexOf(MCP_EXECUTION_ANNEX);
    const intentIdx = prompt.indexOf('## The intent (originating request)');
    const bodyIdx = prompt.indexOf('## Stage instructions');
    expect(annexIdx).toBeGreaterThan(-1);
    expect(intentIdx).toBeGreaterThan(annexIdx);
    expect(intentIdx).toBeLessThan(bodyIdx);
    // Absent intent → no section (older callers unchanged).
    expect(buildStagePrompt({ stage: stage(), stageBody: 'x' })).not.toContain('## The intent');
  });
});
