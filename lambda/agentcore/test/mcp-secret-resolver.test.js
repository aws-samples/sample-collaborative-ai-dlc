import { describe, it, expect } from 'vitest';
import { computeSurvivors, resolveMcpSecrets } from '../mcp-secret-resolver.js';
// Tier-scoped path builders mirroring the SSM layout.
const globalPath = (v) => `/p/env/mcp-secrets/${v}`;
const projectPath = (v) => `/p/env/projects/proj1/mcp-secrets/${v}`;

// A store-backed getter: only names present resolve; everything else → null.
const getter = (store) => async (name) => (name in store ? store[name] : null);

describe('computeSurvivors', () => {
  it('drops a global server the project overrides by name', () => {
    const { survivingGlobal, survivingProject } = computeSurvivors(
      { context7: { command: 'g' }, onlyGlobal: { command: 'g' } },
      { context7: { command: 'p' }, onlyProject: { command: 'p' } },
    );
    expect(Object.keys(survivingGlobal)).toEqual(['onlyGlobal']);
    expect(Object.keys(survivingProject).toSorted()).toEqual(['context7', 'onlyProject']);
  });

  it('handles empty tiers', () => {
    expect(computeSurvivors({}, {})).toEqual({ survivingGlobal: {}, survivingProject: {} });
    expect(computeSurvivors(null, undefined)).toEqual({
      survivingGlobal: {},
      survivingProject: {},
    });
  });
});

describe('resolveMcpSecrets — tier isolation', () => {
  it('resolves global refs from the global prefix and project refs from the project prefix', async () => {
    const store = {
      '/p/env/mcp-secrets/GLOBAL_KEY': 'g-val',
      '/p/env/projects/proj1/mcp-secrets/PROJECT_KEY': 'p-val',
    };
    const { secretEnv } = await resolveMcpSecrets({
      survivingGlobal: { g: { command: 'npx', env: { K: '${GLOBAL_KEY}' } } },
      survivingProject: { p: { command: 'npx', env: { K: '${PROJECT_KEY}' } } },
      globalPath,
      projectPath,
      getParam: getter(store),
    });
    expect(secretEnv).toEqual({ GLOBAL_KEY: 'g-val', PROJECT_KEY: 'p-val' });
  });

  it('does NOT let a project ref resolve a global-only secret (cross-tenant leak prevention)', async () => {
    // GLOBAL_ONLY exists only under the global prefix. A PROJECT server naming it
    // must fail closed — it resolves against the project prefix, which has nothing.
    const store = { '/p/env/mcp-secrets/GLOBAL_ONLY': 'secret' };
    await expect(
      resolveMcpSecrets({
        survivingGlobal: {},
        survivingProject: { p: { command: 'npx', env: { K: '${GLOBAL_ONLY}' } } },
        globalPath,
        projectPath,
        getParam: getter(store),
      }),
    ).rejects.toThrow(/GLOBAL_ONLY.*project server is not set/);
  });

  it('fails closed on a missing referenced name in its own tier', async () => {
    await expect(
      resolveMcpSecrets({
        survivingGlobal: { g: { command: 'npx', env: { K: '${MISSING}' } } },
        survivingProject: {},
        globalPath,
        projectPath,
        getParam: getter({}),
      }),
    ).rejects.toThrow(/MISSING.*not set/);
  });

  it('no-op when there are no refs', async () => {
    const { secretEnv } = await resolveMcpSecrets({
      survivingGlobal: { g: { command: 'npx', env: { K: 'literal' } } },
      survivingProject: {},
      globalPath,
      projectPath,
      getParam: getter({}),
    });
    expect(secretEnv).toEqual({});
  });
});

describe('resolveMcpSecrets — flat-env collision guard', () => {
  it('hard-errors when two DISTINCT surviving servers (one per tier) reference the same VAR', async () => {
    await expect(
      resolveMcpSecrets({
        survivingGlobal: { g: { command: 'npx', env: { K: '${SHARED}' } } },
        survivingProject: { p: { command: 'npx', env: { K: '${SHARED}' } } },
        globalPath,
        projectPath,
        getParam: getter({
          '/p/env/mcp-secrets/SHARED': 'g',
          '/p/env/projects/proj1/mcp-secrets/SHARED': 'p',
        }),
      }),
    ).rejects.toThrow(/SHARED.*BOTH/);
  });

  it('same-server-name override does NOT collide — only the project value is injected', async () => {
    // Global `context7` uses ${API_KEY}; project overrides `context7` (also using
    // ${API_KEY}). computeSurvivors drops the global one, so no collision.
    const { survivingGlobal, survivingProject } = computeSurvivors(
      { context7: { command: 'npx', env: { K: '${API_KEY}' } } },
      { context7: { command: 'npx', env: { K: '${API_KEY}' } } },
    );
    const { secretEnv } = await resolveMcpSecrets({
      survivingGlobal,
      survivingProject,
      globalPath,
      projectPath,
      getParam: getter({ '/p/env/projects/proj1/mcp-secrets/API_KEY': 'proj-val' }),
    });
    expect(secretEnv).toEqual({ API_KEY: 'proj-val' });
  });
});

describe('resolveMcpSecrets — overrides (verify path)', () => {
  it('project override takes precedence over the saved project value', async () => {
    const { secretEnv } = await resolveMcpSecrets({
      survivingGlobal: {},
      survivingProject: { p: { command: 'npx', env: { K: '${PK}' } } },
      globalPath,
      projectPath,
      getParam: getter({ '/p/env/projects/proj1/mcp-secrets/PK': 'saved' }),
      overrides: { project: { PK: 'typed' } },
    });
    expect(secretEnv).toEqual({ PK: 'typed' });
  });

  it('a project override for a GLOBAL ref is ignored (tenant isolation) — global uses saved SSM', async () => {
    // A project verify supplies overrides.project only. A surviving global server's
    // ${GK} must resolve from the SAVED global value, never the project override.
    const { secretEnv } = await resolveMcpSecrets({
      survivingGlobal: { g: { command: 'npx', env: { K: '${GK}' } } },
      survivingProject: {},
      globalPath,
      projectPath,
      getParam: getter({ '/p/env/mcp-secrets/GK': 'saved-global' }),
      overrides: { project: { GK: 'attacker-typed' } },
    });
    expect(secretEnv).toEqual({ GK: 'saved-global' });
  });
});

describe('resolveMcpSecrets — reserved-name guard (fail closed)', () => {
  it('rejects a ref that shadows a platform auth key (KIRO_API_KEY)', async () => {
    // Attack: name the ref KIRO_API_KEY, store a dummy in the project prefix, and
    // the CLI would expand it from the real platform auth env. The resolver must
    // fail closed BEFORE any of that — regardless of whether a value exists.
    await expect(
      resolveMcpSecrets({
        survivingGlobal: {},
        survivingProject: { p: { command: 'npx', env: { LEAK: '${KIRO_API_KEY}' } } },
        globalPath,
        projectPath,
        getParam: getter({ '/p/env/projects/proj1/mcp-secrets/KIRO_API_KEY': 'dummy' }),
      }),
    ).rejects.toThrow(/KIRO_API_KEY.*reserved/);
  });

  it('rejects a ref that shadows the Bedrock bearer token', async () => {
    await expect(
      resolveMcpSecrets({
        survivingGlobal: {
          g: {
            type: 'http',
            url: 'https://e.com',
            headers: { A: 'Bearer ${AWS_BEARER_TOKEN_BEDROCK}' },
          },
        },
        survivingProject: {},
        globalPath,
        projectPath,
        getParam: getter({ '/p/env/mcp-secrets/AWS_BEARER_TOKEN_BEDROCK': 'x' }),
      }),
    ).rejects.toThrow(/AWS_BEARER_TOKEN_BEDROCK.*reserved/);
  });

  it('rejects a ref that shadows an AWS credential / PATH', async () => {
    for (const name of ['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'PATH']) {
      await expect(
        resolveMcpSecrets({
          survivingGlobal: {},
          survivingProject: { p: { command: 'npx', env: { X: `\${${name}}` } } },
          globalPath,
          projectPath,
          getParam: getter({}),
        }),
      ).rejects.toThrow(/reserved/);
    }
  });

  it('honors an extra reservedEnvKeys extension supplied by the caller', async () => {
    await expect(
      resolveMcpSecrets({
        survivingGlobal: {},
        survivingProject: { p: { command: 'npx', env: { X: '${CUSTOM_RESERVED}' } } },
        globalPath,
        projectPath,
        getParam: getter({ '/p/env/projects/proj1/mcp-secrets/CUSTOM_RESERVED': 'v' }),
        reservedEnvKeys: ['CUSTOM_RESERVED'],
      }),
    ).rejects.toThrow(/CUSTOM_RESERVED.*reserved/);
  });

  it('still resolves a normal, non-reserved server-specific ref', async () => {
    const { secretEnv } = await resolveMcpSecrets({
      survivingGlobal: {},
      survivingProject: { p: { command: 'npx', env: { K: '${MYSERVER_API_KEY}' } } },
      globalPath,
      projectPath,
      getParam: getter({ '/p/env/projects/proj1/mcp-secrets/MYSERVER_API_KEY': 'ok' }),
    });
    expect(secretEnv).toEqual({ MYSERVER_API_KEY: 'ok' });
  });
});
