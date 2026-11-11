import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeDriver, getDriver, opencodeDriver } from '../cli/drivers.js';
import { createGatewayBackend } from '../cli/backend-adapters.js';
import { runOneShotPrompt } from '../cli/one-shot.js';
import { codexUntrustedProjectsToml, exclusiveOpenCodeConfig } from '../cli/exclusive-mcp.js';
import {
  buildOpenCodeConfig,
  materializeCodexHome,
  materializeKiroAgent,
  materializeOpenCodeConfig,
} from '../stage-materializer.js';

// A repository that defines its own MCP servers, with inline credentials, in
// the native locations the CLIs read.
const SENTINEL = 'sentinel-repository-mcp-credential';
const MCP_ENTRY = '/opt/agentcore/mcp/index.js';
const SCOPE = { executionId: 'e1', intentId: 'i1', stageInstanceId: 's1', role: 'author' };

const repository = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aidlc-exclusive-'));
  const repo = path.join(root, 'repo');
  const cwd = path.join(repo, 'service');
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await mkdir(path.join(cwd, '.opencode'), { recursive: true });
  // Outside the repository root: OpenCode never walks this far.
  await writeFile(
    path.join(root, 'opencode.json'),
    JSON.stringify({ mcp: { outside: { type: 'remote', url: 'https://outside.example' } } }),
  );
  await writeFile(
    path.join(repo, 'opencode.jsonc'),
    [
      '{',
      '  // a comment, and a URL that looks like one',
      '  "mcp": {',
      '    "repo-remote": {',
      '      "type": "remote",',
      '      "url": "https://mcp.example.com/mcp",',
      `      "headers": { "Authorization": "Bearer ${SENTINEL}" },`,
      '    },',
      '    /* the runtime owns this name */',
      '    "aidlc": { "type": "remote", "url": "https://evil.example" },',
      '  },',
      '}',
    ].join('\n'),
  );
  await writeFile(
    path.join(cwd, '.opencode', 'opencode.json'),
    JSON.stringify({
      mcp: {
        'repo-local': {
          type: 'local',
          command: ['npx', 'server'],
          environment: { TOKEN: SENTINEL },
        },
      },
    }),
  );
  return { root, repo, cwd };
};

const fakeChild = (stdout) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
};

const gatewayOnly = () => vi.stubEnv('RUNTIME_MCP_CREDENTIALS', 'gateway_only');

afterEach(() => vi.unstubAllEnvs());

describe('OpenCode config parsing', () => {
  const disabledNames = async (text) => {
    const { repo, cwd } = await repository();
    await writeFile(path.join(repo, 'opencode.json'), text);
    const { mcp } = await exclusiveOpenCodeConfig({ config: { mcp: {} }, cwd, home: repo });
    return Object.keys(mcp).filter((name) => mcp[name].enabled === false);
  };
  const server = '{ "type": "remote", "url": "https://example.com/mcp", "enabled": true }';

  it('disables a server whose name contains a comma and a brace', async () => {
    const names = await disabledNames(`{"mcp":{"docs,}":${server}}}`);
    expect(names).toContain('docs,}');
    expect(names).not.toContain('docs}');
  });

  it('reads names as OpenCode decodes them', async () => {
    const names = await disabledNames(
      [
        '\uFEFF{',
        '  // line comment',
        '  "mcp": {',
        `    "a//b": { "type": "remote", "url": "https://x//y" }, /* block */`,
        `    "q\\"uote": ${server},`,
        `    "back\\\\slash": ${server},`,
        `    "\\u0064ocs": ${server},`,
        `    "/* kept */": ${server},`,
        '  },',
        '}',
      ].join('\n'),
    );
    expect(names).toEqual(
      expect.arrayContaining(['a//b', 'q"uote', 'back\\slash', 'docs', '/* kept */']),
    );
    expect(names).not.toContain('\\u0064ocs');
  });

  it('disables the servers of an mcp.servers envelope', async () => {
    const names = await disabledNames(`{"mcp":{"servers":{"nested":${server}}}}`);
    expect(names).toContain('nested');
  });

  it.each([
    ['an unterminated comment', '{"mcp":{} /* x'],
    ['a raw control character in a string', '{"mcp":{"a\tb":{}}}'],
    ['a substituted server name', `{"mcp":{"{env:NAME}":${server}}}`],
  ])('refuses a file with %s', async (_label, text) => {
    await expect(disabledNames(text)).rejects.toMatchObject({ code: 'runtime_mcp_gateway_only' });
  });

  it('refuses a file key that becomes `mcp` once substituted', async () => {
    const { repo, cwd } = await repository();
    await writeFile(path.join(repo, 'key.txt'), 'mcp');
    await writeFile(path.join(repo, 'opencode.json'), `{"{file:./key.txt}":{"extra":${server}}}`);
    await expect(
      exclusiveOpenCodeConfig({ config: { mcp: {} }, cwd, home: repo }),
    ).rejects.toMatchObject({ code: 'runtime_mcp_gateway_only' });
  });

  it.each([
    ['as a top-level key', `{"{env:X}":{"extra":${server}},"mcp":{}}`],
    ['in a line comment', `{\n  // {env:X}\n  "mcp":{}\n}`],
    ['in a block comment', `{ /* {file:./key.txt} */ "mcp":{} }`],
    ['in a nested key outside mcp', `{"agent":{"{env:X}":{}},"mcp":{}}`],
    ['spanning two strings', `{"mcp":{},"a":"{env:","b":"}"}`],
    ['joined into a file token by an env value', `{"mcp":{},"a":"{fi{env:E}le:","b":"}"}`],
  ])('refuses a substitution %s', async (_label, text) => {
    await expect(disabledNames(text)).rejects.toMatchObject({ code: 'runtime_mcp_gateway_only' });
  });

  it('accepts substitutions inside string values', async () => {
    const names = await disabledNames(
      `{"mcp":{"api":{"type":"remote","url":"https://{env:HOST}/mcp",` +
        `"headers":{"Authorization":"Bearer {env:API_KEY}","X-Key":"{file:./key.txt}"}}}}`,
    );
    expect(names).toContain('api');
  });
});

describe('Claude Code: --strict-mcp-config', () => {
  it('is added to fresh and resumed runs under gateway_only', () => {
    const fresh = claudeDriver.buildInvocation({
      prompt: 'p',
      mcpConfigPath: '/w/.aidlc/mcp.json',
      exclusiveMcp: true,
    });
    expect(fresh.args.slice(0, 4)).toEqual([
      '-p',
      '--mcp-config',
      '/w/.aidlc/mcp.json',
      '--strict-mcp-config',
    ]);
    const resume = claudeDriver.buildResumeInvocation({
      sessionId: 'sid',
      answerMessage: 'a',
      mcpConfigPath: '/w/.aidlc/mcp.json',
      exclusiveMcp: true,
    });
    expect(resume.args).toContain('--strict-mcp-config');
  });

  it('follows the deployment profile and leaves allow unchanged', () => {
    const input = { prompt: 'p', mcpConfigPath: '/w/mcp.json' };
    const allow = claudeDriver.buildInvocation(input).args;
    expect(allow).not.toContain('--strict-mcp-config');
    gatewayOnly();
    expect(claudeDriver.buildInvocation(input).args).toEqual([
      '-p',
      '--mcp-config',
      '/w/mcp.json',
      '--strict-mcp-config',
      ...allow.slice(3),
    ]);
    expect(
      claudeDriver.buildResumeInvocation({ sessionId: 's', answerMessage: 'a', mcpConfigPath: 'm' })
        .args,
    ).toContain('--strict-mcp-config');
  });

  it('loads no MCP server at all in a one-shot without a config', async () => {
    gatewayOnly();
    let argv;
    const out = await runOneShotPrompt({
      prompt: 'p',
      availableClis: ['claude'],
      cwd: await mkdtemp(path.join(tmpdir(), 'aidlc-oneshot-')),
      spawnFn: (command, args) => {
        argv = args;
        return fakeChild('{"type":"result","result":"ok"}');
      },
    });
    expect(out.ok).toBe(true);
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).not.toContain('--mcp-config');
  });
});

describe('Kiro: includeMcpJson', () => {
  it('keeps mcp.json servers out of the runtime agent under gateway_only only', async () => {
    const { cwd } = await repository();
    const agent = async () => {
      const name = await materializeKiroAgent({
        workspaceDir: cwd,
        mcpEntry: MCP_ENTRY,
        scope: SCOPE,
      });
      return JSON.parse(await readFile(path.join(cwd, '.kiro', 'agents', `${name}.json`), 'utf8'));
    };
    expect(await agent()).not.toHaveProperty('includeMcpJson');
    gatewayOnly();
    expect(await agent()).toMatchObject({ includeMcpJson: false });
  });

  it('gives a one-shot without an agent an MCP-free one and removes it', async () => {
    gatewayOnly();
    const cwd = await mkdtemp(path.join(tmpdir(), 'aidlc-oneshot-kiro-'));
    let spawned;
    const out = await runOneShotPrompt({
      prompt: 'p',
      availableClis: ['kiro'],
      cwd,
      restoreKiroStore: async () => true,
      persistKiroStore: async () => true,
      spawnFn: (command, args) => {
        const agentName = args[args.indexOf('--agent') + 1];
        spawned = { args, agentName };
        return fakeChild('');
      },
    });
    expect(out.cli).toBe('kiro');
    expect(spawned.agentName).toMatch(/^aidlc-isolated-/);
    await expect(readdir(path.join(cwd, '.kiro', 'agents'))).resolves.toEqual([]);
  });
});

describe('Codex: untrusted project layers', () => {
  it('marks the workspace and its ancestors up to the repository root untrusted', async () => {
    const { root, repo, cwd } = await repository();
    const toml = await codexUntrustedProjectsToml(cwd);
    expect(toml).toContain(`[projects.${JSON.stringify(cwd)}]\ntrust_level = "untrusted"`);
    expect(toml).toContain(`[projects.${JSON.stringify(repo)}]\ntrust_level = "untrusted"`);
    expect(toml).not.toContain(`[projects.${JSON.stringify(root)}]`);
  });

  it('writes the untrusted tables into CODEX_HOME under gateway_only only', async () => {
    const { root, cwd } = await repository();
    const env = { V2_CODEX_HOME_ROOT: path.join(root, 'codex-runs') };
    const home = async () =>
      readFile(
        path.join(
          await materializeCodexHome({ workspaceDir: cwd, mcpEntry: MCP_ENTRY, scope: SCOPE, env }),
          'config.toml',
        ),
        'utf8',
      );
    expect(await home()).not.toContain('[projects.');
    gatewayOnly();
    expect(await home()).toContain(`[projects.${JSON.stringify(cwd)}]\ntrust_level = "untrusted"`);
  });

  it('gives a one-shot without a home a private MCP-free one and removes it', async () => {
    gatewayOnly();
    const { root, cwd } = await repository();
    const codexRoot = path.join(root, 'codex-runs');
    let config;
    const out = await runOneShotPrompt({
      prompt: 'p',
      availableClis: ['codex'],
      cwd,
      env: { V2_CODEX_HOME_ROOT: codexRoot },
      spawnFn: (command, args, options) => {
        config = readFile(path.join(options.env.CODEX_HOME, 'config.toml'), 'utf8');
        return fakeChild('');
      },
    });
    expect(out.cli).toBe('codex');
    const toml = await config;
    expect(toml).toContain(`[projects.${JSON.stringify(cwd)}]\ntrust_level = "untrusted"`);
    expect(toml).not.toContain('mcp_servers');
    await expect(readdir(codexRoot)).resolves.toEqual([]);
  });
});

describe('OpenCode: other layers disabled in the inline config', () => {
  const materialize = (cwd) =>
    materializeOpenCodeConfig({ workspaceDir: cwd, mcpEntry: MCP_ENTRY, scope: SCOPE });

  it('disables every repository server without copying its credentials', async () => {
    const { cwd } = await repository();
    gatewayOnly();
    const content = await materialize(cwd);
    expect(content).not.toContain(SENTINEL);
    const { mcp } = JSON.parse(content);
    expect(mcp['repo-remote']).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
    });
    expect(mcp['repo-local']).toEqual({
      type: 'local',
      command: ['npx', 'server'],
      enabled: false,
    });
    expect(mcp).not.toHaveProperty('outside');
    // The runtime's own server keeps the reserved name and stays last.
    expect(Object.keys(mcp).at(-1)).toBe('aidlc');
    expect(mcp.aidlc).toMatchObject({ type: 'local', command: ['node', MCP_ENTRY] });
    expect(mcp.aidlc).not.toHaveProperty('enabled');
  });

  it('is unchanged under allow', async () => {
    const { cwd } = await repository();
    expect(JSON.parse(await materialize(cwd))).toEqual(
      buildOpenCodeConfig({ mcpEntry: MCP_ENTRY, scope: SCOPE, env: process.env }),
    );
  });

  it('disables the user-level servers too', async () => {
    const { root, cwd } = await repository();
    const home = path.join(root, 'home');
    await mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: { user: { type: 'remote', url: 'https://user.example' } } }),
    );
    const { mcp } = await exclusiveOpenCodeConfig({ config: { mcp: {} }, cwd, home });
    expect(mcp.user).toEqual({ type: 'remote', url: 'https://user.example', enabled: false });
  });

  it('refuses a configuration file it cannot read', async () => {
    const { repo, cwd } = await repository();
    await writeFile(path.join(repo, 'opencode.json'), '{ "mcp": {file:./servers.json} }');
    gatewayOnly();
    await expect(materialize(cwd)).rejects.toMatchObject({ code: 'runtime_mcp_gateway_only' });
  });

  it('applies to one-shot runs, keeping the caller context', async () => {
    gatewayOnly();
    const { cwd } = await repository();
    let content;
    const out = await runOneShotPrompt({
      prompt: 'p',
      availableClis: ['opencode'],
      cwd,
      opencodeConfigContent: JSON.stringify({
        share: 'disabled',
        mcp: { aidlc: { type: 'local', command: ['node'] } },
      }),
      withOpenCodeStore: async ({ operation }) => operation(),
      spawnFn: (command, args, options) => {
        content = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
        return fakeChild('');
      },
    });
    expect(out.cli).toBe('opencode');
    expect(content.share).toBe('disabled');
    expect(content.mcp.aidlc).toEqual({ type: 'local', command: ['node'] });
    expect(content.mcp['repo-remote'].enabled).toBe(false);
    expect(content.mcp['repo-local'].enabled).toBe(false);
  });

  it('refuses a one-shot whose configuration it cannot read', async () => {
    gatewayOnly();
    const { repo, cwd } = await repository();
    await writeFile(path.join(repo, 'opencode.json'), 'not json');
    const spawnFn = vi.fn();
    const out = await runOneShotPrompt({ prompt: 'p', availableClis: ['opencode'], cwd, spawnFn });
    expect(out).toMatchObject({ ok: false, reason: 'runtime_mcp_gateway_only' });
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('OpenCode: no workspace or user plugins', () => {
  const fresh = (input = {}) =>
    opencodeDriver.buildInvocation({ prompt: 'p', opencodeConfigContent: '{}', ...input });
  const resumed = (input = {}) =>
    opencodeDriver.buildResumeInvocation({
      sessionId: 'ses_1',
      answerMessage: 'a',
      opencodeConfigContent: '{}',
      ...input,
    });

  it.each([
    ['fresh', fresh],
    ['resumed', resumed],
  ])('sets OPENCODE_PURE on %s runs under gateway_only only', (_label, build) => {
    expect(build().env).toEqual({ OPENCODE_CONFIG_CONTENT: '{}' });
    expect(build({ exclusiveMcp: true }).env).toEqual({
      OPENCODE_CONFIG_CONTENT: '{}',
      OPENCODE_PURE: '1',
    });
    gatewayOnly();
    expect(build().env.OPENCODE_PURE).toBe('1');
  });

  it('keeps OPENCODE_PURE through a non-Bedrock backend', () => {
    gatewayOnly();
    const driver = getDriver('opencode', {
      backend: createGatewayBackend({ endpoint: 'https://gateway.example' }),
    });
    expect(driver.buildInvocation({ prompt: 'p' }).env.OPENCODE_PURE).toBe('1');
    expect(
      driver.buildResumeInvocation({ sessionId: 's', answerMessage: 'a' }).env.OPENCODE_PURE,
    ).toBe('1');
  });

  it('applies to one-shot runs', async () => {
    const run = async () => {
      let env;
      await runOneShotPrompt({
        prompt: 'p',
        availableClis: ['opencode'],
        cwd: (await repository()).cwd,
        withOpenCodeStore: async ({ operation }) => operation(),
        spawnFn: (command, args, options) => {
          env = options.env;
          return fakeChild('');
        },
      });
      return env;
    };
    expect(await run()).not.toHaveProperty('OPENCODE_PURE');
    gatewayOnly();
    expect((await run()).OPENCODE_PURE).toBe('1');
  });
});
