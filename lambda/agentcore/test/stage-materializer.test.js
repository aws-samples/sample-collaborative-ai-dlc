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
  buildOpenCodeConfig,
  buildCodexConfigToml,
  toCodexMcpToml,
  materializeCliContext,
  OPENCODE_INSTRUCTIONS,
  renderRulesDoc,
  materializeStage,
  materializeCustomRules,
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

  it('injects the structure contract for registered output types, after the outputs list', () => {
    const prompt = buildStagePrompt({
      stage: stage({ outputArtifacts: [{ artifact: 'stories' }] }),
      stageBody: 'x',
    });
    expect(prompt).toContain('# Artifact structure contracts');
    expect(prompt).toContain('## Structure contract — stories');
    expect(prompt).toContain('stories:'); // the fenced YAML example key
    expect(prompt).toContain('at least two `##` section headings');
    expect(prompt.indexOf('## Expected outputs')).toBeLessThan(
      prompt.indexOf('# Artifact structure contracts'),
    );
  });

  it('injects BOTH the units: and contracts: specs for the DAG artifact', () => {
    const prompt = buildStagePrompt({
      stage: stage({ outputArtifacts: [{ artifact: 'unit-of-work-dependency' }] }),
      stageBody: 'x',
    });
    expect(prompt).toContain('Structured block: `units:` (REQUIRED');
    expect(prompt).toContain('Structured block: `contracts:`');
  });

  it('injects NO structure section for unregistered output types', () => {
    const prompt = buildStagePrompt({
      stage: stage({ outputArtifacts: [{ artifact: 'walking-skeleton-notes' }] }),
      stageBody: 'x',
    });
    expect(prompt).not.toContain('# Artifact structure contracts');
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
        sectionIndex: 2,
        stageAttempt: 3,
        role: 'author',
      },
      env: {
        V2_PROCESS_TABLE: 'proc',
        DYNAMODB_LOCAL_ENDPOINT: 'http://dynamodb:8000',
        NEPTUNE_ENDPOINT: 'neptune',
        AWS_REGION: 'us-east-1',
      },
    });
    expect(cfg.mcpServers.aidlc.command).toBe('node');
    expect(cfg.mcpServers.aidlc.args).toEqual(['/opt/agentcore/mcp/index.js']);
    expect(cfg.mcpServers.aidlc.env).toMatchObject({
      V2_EXECUTION_ID: 'e1',
      V2_INTENT_ID: 'i1',
      V2_PROJECT_ID: 'p1',
      V2_STAGE_INSTANCE_ID: 'si1',
      V2_SECTION_INDEX: '2',
      V2_STAGE_ATTEMPT: '3',
      V2_MCP_ROLE: 'author',
      V2_PROCESS_TABLE: 'proc',
      DYNAMODB_LOCAL_ENDPOINT: 'http://dynamodb:8000',
      NEPTUNE_ENDPOINT: 'neptune',
    });
  });

  it('defaults the role to author', () => {
    const cfg = buildMcpConfig({ mcpEntry: 'x', scope: { executionId: 'e', intentId: 'i' } });
    expect(cfg.mcpServers.aidlc.env.V2_MCP_ROLE).toBe('author');
  });

  it('passes the trusted reviewer identity on reviewer scopes (empty otherwise)', () => {
    const reviewerCfg = buildMcpConfig({
      mcpEntry: 'x',
      scope: {
        executionId: 'e',
        intentId: 'i',
        role: 'reviewer',
        reviewerAgent: 'aidlc-architecture-reviewer-agent',
      },
    });
    expect(reviewerCfg.mcpServers.aidlc.env.V2_REVIEWER_AGENT).toBe(
      'aidlc-architecture-reviewer-agent',
    );
    const authorCfg = buildMcpConfig({ mcpEntry: 'x', scope: { executionId: 'e', intentId: 'i' } });
    expect(authorCfg.mcpServers.aidlc.env.V2_REVIEWER_AGENT).toBe('');
  });

  it('merges custom servers alongside the reserved aidlc server', () => {
    const cfg = buildMcpConfig({
      mcpEntry: 'x',
      scope: { executionId: 'e', intentId: 'i' },
      customServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } },
    });
    expect(cfg.mcpServers.fetch).toEqual({ command: 'uvx', args: ['mcp-server-fetch'] });
    expect(cfg.mcpServers.aidlc.command).toBe('node');
  });

  it('never lets a custom server override the reserved aidlc entry', () => {
    const cfg = buildMcpConfig({
      mcpEntry: '/real/mcp.js',
      scope: { executionId: 'e', intentId: 'i' },
      customServers: { aidlc: { command: 'evil' } },
    });
    // The reserved aidlc entry (spread last) wins.
    expect(cfg.mcpServers.aidlc.command).toBe('node');
    expect(cfg.mcpServers.aidlc.args).toEqual(['/real/mcp.js']);
  });

  it('keeps ${VAR} secret refs VERBATIM (resolved value lives only in the child env)', () => {
    const cfg = buildMcpConfig({
      mcpEntry: 'x',
      scope: { executionId: 'e', intentId: 'i' },
      customServers: {
        ctx: {
          type: 'http',
          url: 'https://e.com',
          headers: { Authorization: 'Bearer ${CTX_KEY}' },
        },
        tool: { command: 'npx', env: { API: '${API_KEY}' } },
      },
    });
    expect(cfg.mcpServers.ctx.headers.Authorization).toBe('Bearer ${CTX_KEY}');
    expect(cfg.mcpServers.tool.env.API).toBe('${API_KEY}');
    // The reserved aidlc entry never carries refs.
    expect(JSON.stringify(cfg.mcpServers.aidlc)).not.toContain('${');
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

  it('merges custom servers and writes custom rules into the driver rules dir (claude)', async () => {
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
      customServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } },
      cli: 'claude',
      customRules: [{ filename: 'standards.md', body: 'Always use tabs.' }],
    });
    const cfg = JSON.parse(await readFile(out.mcpConfigPath, 'utf8'));
    expect(cfg.mcpServers.fetch).toEqual({ command: 'uvx', args: ['mcp-server-fetch'] });
    expect(cfg.mcpServers.aidlc.command).toBe('node');
    // Custom rules go into the CLI's NATIVE rules dir (auto-loaded), NOT the prompt.
    expect(out.prompt).not.toContain('Custom project rules');
    const ruleBody = await readFile(
      path.join(ws, '.claude', 'rules', 'custom--standards.md'),
      'utf8',
    );
    expect(ruleBody).toBe('Always use tabs.');
  });

  it('writes custom rules to .kiro/steering for the kiro driver', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-ws-'));
    await materializeStage({
      workspaceDir: ws,
      stage: stage(),
      stageBody: 'do it',
      agentPersona: 'persona',
      knowledge: '',
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1' },
      cli: 'kiro',
      customRules: [{ filename: 'api.md', body: 'REST only.' }],
    });
    const ruleBody = await readFile(path.join(ws, '.kiro', 'steering', 'custom--api.md'), 'utf8');
    expect(ruleBody).toBe('REST only.');
  });

  it('writes OpenCode instructions under .aidlc without touching repository instruction files', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-ws-'));
    await materializeStage({
      workspaceDir: ws,
      stage: stage(),
      stageBody: 'do it',
      agentPersona: 'persona',
      knowledge: '',
      rulesDoc: 'RUNTIME RULES',
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1' },
      cli: 'opencode',
      customRules: [{ filename: 'api.md', body: 'REST only.' }],
    });
    expect(
      await readFile(path.join(ws, '.aidlc', 'opencode-instructions', 'custom--api.md'), 'utf8'),
    ).toBe('REST only.');
    expect(await readFile(path.join(ws, '.aidlc', 'rules.md'), 'utf8')).toBe('RUNTIME RULES');
    await expect(readFile(path.join(ws, 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });

  it('neutralizes path traversal (basename) and skips non-.md rule filenames', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-ws-'));
    const written = await materializeCustomRules({
      workspaceDir: ws,
      cli: 'claude',
      customRules: [
        { filename: '../evil.md', body: 'x' }, // basename → evil.md (safe)
        { filename: 'notmd.txt', body: 'y' }, // skipped: not .md
        { filename: 'ok.md', body: 'z' },
      ],
    });
    expect(written).toEqual(['custom--evil.md', 'custom--ok.md']);
    // The traversal-neutralized file lands INSIDE the rules dir, never above it.
    const evil = await readFile(path.join(ws, '.claude', 'rules', 'custom--evil.md'), 'utf8');
    expect(evil).toBe('x');
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
    // Custom-agent steering isn't auto-loaded by Kiro — the resources glob wires
    // .kiro/steering (where materializeCustomRules writes the project's rules).
    expect(cfg.resources).toContain('file://.kiro/steering/**/*.md');
  });

  it('merges custom servers into the Kiro agent envelope', () => {
    const cfg = buildKiroAgentConfig({
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1' },
      env: { V2_PROCESS_TABLE: 'proc' },
      customServers: { git: { command: 'uvx', args: ['mcp-server-git'] } },
    });
    expect(cfg.mcpServers.git).toEqual({ command: 'uvx', args: ['mcp-server-git'] });
    expect(cfg.mcpServers.aidlc.command).toBe('node');
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

describe('OpenCode inline config', () => {
  it('converts stdio and remote MCP servers to OpenCode-native transports', () => {
    const cfg = buildOpenCodeConfig({
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1' },
      customServers: {
        local: {
          command: 'uvx',
          args: ['server'],
          env: { API_KEY: '${LOCAL_KEY}', MIXED: 'Bearer ${LOCAL_KEY}' },
        },
        remote: {
          type: 'sse',
          url: 'https://mcp.example/sse',
          headers: { Authorization: 'Bearer ${REMOTE_KEY}' },
        },
      },
    });
    expect(cfg.share).toBe('disabled');
    expect(cfg.instructions).toEqual(OPENCODE_INSTRUCTIONS);
    expect(cfg.mcp.local).toEqual({
      type: 'local',
      command: ['uvx', 'server'],
      environment: { API_KEY: '{env:LOCAL_KEY}', MIXED: 'Bearer {env:LOCAL_KEY}' },
    });
    expect(cfg.mcp.remote).toEqual({
      type: 'remote',
      url: 'https://mcp.example/sse',
      headers: { Authorization: 'Bearer {env:REMOTE_KEY}' },
    });
  });

  it('merges the reserved aidlc server last', () => {
    const cfg = buildOpenCodeConfig({
      mcpEntry: '/real/mcp.js',
      scope: { executionId: 'e', intentId: 'i' },
      customServers: { aidlc: { command: 'evil' }, other: { command: 'node' } },
    });
    expect(Object.keys(cfg.mcp).at(-1)).toBe('aidlc');
    expect(cfg.mcp.aidlc.command).toEqual(['node', '/real/mcp.js']);
  });

  it('materializes only the selected CLI context and never writes .opencode', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-opencode-'));
    const context = await materializeCliContext({
      cli: 'opencode',
      workspaceDir: ws,
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e', intentId: 'i' },
    });
    expect(JSON.parse(context.opencodeConfigContent).share).toBe('disabled');
    await expect(readFile(path.join(ws, '.opencode', 'opencode.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(ws, 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });
});

describe('Codex config (per-stage CODEX_HOME)', () => {
  it('pins the Bedrock provider, full-auto policy, and ephemeral sqlite home', () => {
    const toml = buildCodexConfigToml({
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1' },
    });
    expect(toml).toContain('model_provider = "amazon-bedrock"');
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain('sandbox_mode = "danger-full-access"');
    expect(toml).toContain('project_doc_fallback_filenames = [".aidlc/rules.md"]');
    expect(toml).toContain('sqlite_home = "/home/node/.codex-state"');
    expect(toml).toContain('persistence = "save-all"');
  });

  it('emits the aidlc MCP server as required, with scope env and timeouts', () => {
    const toml = buildCodexConfigToml({
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1' },
    });
    expect(toml).toContain('[mcp_servers."aidlc"]');
    expect(toml).toContain('required = true');
    expect(toml).toContain('startup_timeout_sec = 30');
    expect(toml).toContain('tool_timeout_sec = 600');
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('args = ["/opt/agentcore/mcp/index.js"]');
    expect(toml).toContain('[mcp_servers."aidlc".env]');
    expect(toml).toContain('"V2_EXECUTION_ID" = "e1"');
  });

  it('resolves ${VAR} refs to LITERAL values (codex env maps do not interpolate)', () => {
    const toml = toCodexMcpToml(
      {
        local: { command: 'uvx', args: ['server'], env: { API_KEY: 'Bearer ${LOCAL_KEY}' } },
        remote: { url: 'https://mcp.example/sse', headers: { Authorization: '${REMOTE_KEY}' } },
      },
      { LOCAL_KEY: 'k-123', REMOTE_KEY: 'r-456' },
    );
    expect(toml).toContain('"API_KEY" = "Bearer k-123"');
    expect(toml).toContain('url = "https://mcp.example/sse"');
    expect(toml).toContain('[mcp_servers."remote".http_headers]');
    expect(toml).toContain('"Authorization" = "r-456"');
    expect(toml).not.toContain('${');
  });

  it('forwards the AWS credential chain to the aidlc bridge ONLY (codex sanitizes MCP child env)', () => {
    const env = {
      AWS_ACCESS_KEY_ID: 'AKIALOCAL',
      AWS_SECRET_ACCESS_KEY: 'secretlocal',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/creds',
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'container-token',
      UNRELATED_VAR: 'never-forwarded',
    };
    const toml = buildCodexConfigToml({
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1' },
      env,
      customServers: { custom: { command: 'uvx', args: ['server'], env: { FOO: 'bar' } } },
    });
    const aidlcSection = toml.slice(toml.indexOf('[mcp_servers."aidlc"]'));
    expect(aidlcSection).toContain('"AWS_ACCESS_KEY_ID" = "AKIALOCAL"');
    expect(aidlcSection).toContain('"AWS_SECRET_ACCESS_KEY" = "secretlocal"');
    expect(aidlcSection).toContain(
      '"AWS_CONTAINER_CREDENTIALS_FULL_URI" = "http://169.254.170.2/creds"',
    );
    expect(aidlcSection).not.toContain('UNRELATED_VAR');
    // The custom server never inherits runtime credentials.
    const customSection = toml.slice(
      toml.indexOf('[mcp_servers."custom"]'),
      toml.indexOf('[mcp_servers."aidlc"]'),
    );
    expect(customSection).toContain('"FOO" = "bar"');
    expect(customSection).not.toContain('AWS_ACCESS_KEY_ID');
    expect(customSection).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('omits absent credential vars instead of writing empty strings', () => {
    const toml = buildCodexConfigToml({
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e1', intentId: 'i1' },
      env: { AWS_ACCESS_KEY_ID: '' },
    });
    expect(toml).not.toContain('"AWS_ACCESS_KEY_ID"');
    expect(toml).not.toContain('"AWS_SESSION_TOKEN"');
  });

  it('emits the reserved aidlc server LAST so a custom entry can never shadow it', () => {
    const toml = buildCodexConfigToml({
      mcpEntry: '/real/mcp.js',
      scope: { executionId: 'e', intentId: 'i' },
      customServers: { aidlc: { command: 'evil' }, other: { command: 'node' } },
    });
    const aidlcIdx = toml.lastIndexOf('[mcp_servers."aidlc"]');
    const otherIdx = toml.indexOf('[mcp_servers."other"]');
    expect(aidlcIdx).toBeGreaterThan(otherIdx);
    expect(toml.slice(aidlcIdx)).toContain('args = ["/real/mcp.js"]');
    expect(toml.slice(aidlcIdx)).not.toContain('"evil"');
  });

  it('materializes CODEX_HOME under .aidlc with config.toml + AGENTS.md, repo files untouched', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-codex-'));
    const context = await materializeCliContext({
      cli: 'codex',
      workspaceDir: ws,
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e', intentId: 'i' },
    });
    expect(context.codexHome).toBe(path.join(ws, '.aidlc', 'codex-home'));
    const toml = await readFile(path.join(context.codexHome, 'config.toml'), 'utf8');
    expect(toml).toContain('model_provider = "amazon-bedrock"');
    const agentsMd = await readFile(path.join(context.codexHome, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('.aidlc/rules.md');
    expect(agentsMd).toContain('.aidlc/codex-instructions');
    // Repo-level files stay untouched.
    await expect(readFile(path.join(ws, 'AGENTS.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(ws, '.codex', 'config.toml'), 'utf8')).rejects.toThrow();
  });

  it('writes custom rules to .aidlc/codex-instructions for the codex driver', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-codex-rules-'));
    const written = await materializeCustomRules({
      workspaceDir: ws,
      cli: 'codex',
      customRules: [{ filename: 'team.md', body: '# team rules' }],
    });
    expect(written).toEqual(['custom--team.md']);
    const body = await readFile(
      path.join(ws, '.aidlc', 'codex-instructions', 'custom--team.md'),
      'utf8',
    );
    expect(body).toBe('# team rules');
  });

  it('honors the V2_CODEX_SQLITE_HOME override', async () => {
    const toml = buildCodexConfigToml({
      mcpEntry: '/opt/agentcore/mcp/index.js',
      scope: { executionId: 'e', intentId: 'i' },
      env: { V2_CODEX_SQLITE_HOME: '/tmp/codex-state' },
    });
    expect(toml).toContain('sqlite_home = "/tmp/codex-state"');
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
