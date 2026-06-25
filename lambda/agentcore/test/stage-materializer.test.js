import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  OUTPUT_CONTRACT,
  buildStagePrompt,
  buildMcpConfig,
  renderRulesDoc,
  materializeStage,
} from '../stage-materializer.js';

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
    expect(prompt).toContain('Reference knowledge');
    expect(prompt).toContain('requires human approval');
    expect(prompt).toContain(OUTPUT_CONTRACT);
  });

  it('renders "none" for empty inputs/outputs and omits optional sections', () => {
    const prompt = buildStagePrompt({
      stage: stage({ inputArtifacts: [], outputArtifacts: [], humanValidation: 'none' }),
      stageBody: 'x',
    });
    expect(prompt).toContain('## Inputs (read via the MCP tools)\n- none');
    expect(prompt).not.toContain('## Your role');
    expect(prompt).not.toContain('Reference knowledge');
    expect(prompt).not.toContain('requires human approval');
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
