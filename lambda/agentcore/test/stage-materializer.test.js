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
