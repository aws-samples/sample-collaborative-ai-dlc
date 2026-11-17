// Container dependency-closure guard — the regression net for the exact
// failure mode that took down the runtime in the field: a shared/ module
// required a package (`js-yaml`) that resolved from the repo root's HOISTED
// node_modules locally (a transitive dev dependency of secretlint!), but the
// Dockerfile installs ONLY lambda/agentcore/package.json dependencies, so the
// container crashed at boot with MODULE_NOT_FOUND and every stage invoke
// failed with "error occurred when starting the runtime".
//
// The test recursively walks the REAL import graph from the container
// entrypoint (http-server.js) across agentcore/ + ../shared/ (exactly the two
// trees the Dockerfile COPYs) and asserts every external package it reaches is
// DECLARED in lambda/agentcore/package.json — the only manifest the image
// installs. Local hoisting can never mask a missing container dep again.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentcoreDir = path.join(here, '..');
const sharedDir = path.join(here, '..', '..', 'shared');
const dockerfile = readFileSync(path.join(agentcoreDir, 'Dockerfile'), 'utf8');

const pkg = JSON.parse(readFileSync(path.join(agentcoreDir, 'package.json'), 'utf8'));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));

// Match both module systems: import/export-from/dynamic import + require.
// Specifiers never contain whitespace — prose in comments must not match.
const SPEC_RE =
  /(?:from\s+['"]([^'"\s]+)['"]|import\s*\(\s*['"]([^'"\s]+)['"]\s*\)|^import\s+['"]([^'"\s]+)['"]|require\s*\(\s*['"]([^'"\s]+)['"]\s*\))/gm;

// Strip line + block comments (naive but sufficient for this codebase's
// style) so commented-out imports and prose never register.
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const specifiersOf = (source) =>
  [...stripComments(source).matchAll(SPEC_RE)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? m[4])
    .filter(Boolean);

// Bare package name from a specifier ('@scope/pkg/sub' → '@scope/pkg').
const packageName = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

const isExternal = (spec) =>
  !spec.startsWith('.') && !spec.startsWith('node:') && !isNodeBuiltin(spec);
const NODE_BUILTINS = new Set([
  'fs',
  'path',
  'crypto',
  'http',
  'https',
  'os',
  'url',
  'util',
  'zlib',
  'stream',
  'events',
  'child_process',
  'buffer',
  'assert',
  'net',
  'tls',
  'dns',
  'readline',
  'querystring',
  'string_decoder',
  'timers',
  'worker_threads',
  'process',
  'module',
]);
const isNodeBuiltin = (spec) => NODE_BUILTINS.has(packageName(spec));

// Resolve a relative specifier to a file within the two copied trees.
const resolveLocal = (fromFile, spec) => {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* next candidate */
    }
  }
  return null;
};

const walk = (entry) => {
  const seen = new Set();
  const externals = new Map(); // package → first importer (for the error message)
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const spec of specifiersOf(source)) {
      if (spec.startsWith('.')) {
        const resolved = resolveLocal(file, spec);
        if (resolved) queue.push(resolved);
      } else if (isExternal(spec)) {
        const name = packageName(spec);
        if (!externals.has(name)) externals.set(name, path.relative(agentcoreDir, file));
      }
    }
  }
  return externals;
};

describe('container dependency closure (Dockerfile installs ONLY agentcore/package.json)', () => {
  it('every external package reachable from the container entrypoint is declared', () => {
    const externals = walk(path.join(agentcoreDir, 'http-server.js'));
    const missing = [...externals.entries()].filter(([name]) => !declared.has(name));
    expect(
      missing,
      `undeclared container deps (add to lambda/agentcore/package.json): ${missing
        .map(([name, importer]) => `${name} (via ${importer})`)
        .join(', ')}`,
    ).toEqual([]);
  });

  it('the MCP child entrypoint is covered too (spawned by the CLI, same image)', () => {
    const externals = walk(path.join(agentcoreDir, 'mcp', 'index.js'));
    const missing = [...externals.keys()].filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  it('sanity: the walk actually reaches the shared tree and finds js-yaml', () => {
    // Guards the guard: if the walker ever silently stops resolving ../shared
    // requires, these assertions catch it before a false green.
    const externals = walk(path.join(agentcoreDir, 'http-server.js'));
    expect([...externals.keys()]).toContain('js-yaml');
    expect([...externals.keys()]).toContain('gremlin');
    void sharedDir; // documented anchor of the second copied tree
  });
});

describe('protected engine dependency closure (same image, same single install)', () => {
  // The first live engine run was refused on every request: the image gave the
  // engine an install of its own beside the one the shared/ helpers resolve
  // from. The engine's graph connection and the shared membership lookup then
  // came from two copies of the graph library, which do not recognise each
  // other's objects, and the query reached the graph malformed. One checkout
  // has one copy, so no host test saw it. The image therefore has one install,
  // and this is its only manifest.
  const engineEntry = path.join(
    agentcoreDir,
    '..',
    'native-runtime-control',
    'workflow-engine-entry.js',
  );

  it('every external package reachable from the engine entry is declared', () => {
    const externals = walk(engineEntry);
    const missing = [...externals.entries()].filter(([name]) => !declared.has(name));
    expect(
      missing,
      `undeclared engine deps (add to lambda/agentcore/package.json): ${missing
        .map(([name, importer]) => `${name} (via ${importer})`)
        .join(', ')}`,
    ).toEqual([]);
  });

  it('sanity: the walk reaches the engine, its jobs and the shared membership lookup', () => {
    const externals = walk(engineEntry);
    expect(externals.get('@aws-sdk/client-codebuild')).toMatch(/workflow-engine-entry\.js$/);
    expect([...externals.keys()]).toContain('@aws-sdk/s3-request-presigner');
    expect(externals.get('gremlin')).toMatch(/workflow-engine-entry\.js$/);
    expect(specifiersOf(readFileSync(engineEntry, 'utf8'))).toContain(
      '../shared/workflow-source-membership.js',
    );
    expect(
      specifiersOf(readFileSync(path.join(sharedDir, 'workflow-source-membership.js'), 'utf8')),
    ).toContain('gremlin');
  });

  it('resolves the engine and the shared helpers from the one install and refuses a second', () => {
    // No install for the engine: every npm command belongs to another directory.
    const installs = dockerfile.split('\n').filter((line) => /\bnpm (?:install|ci)\b/.test(line));
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) expect(line).not.toContain('/opt/native-runtime-control');
    expect(dockerfile).not.toMatch(/COPY[^\n]*native-runtime-control\/package\.json/);
    expect(dockerfile).toContain(
      'RUN ln -s /opt/agentcore/node_modules /opt/shared/node_modules \\\n' +
        '    && ln -s /opt/agentcore/node_modules /opt/native-runtime-control/node_modules',
    );
    // The build itself refuses a second tree and an entry that does not load.
    for (const root of ['shared', 'native-runtime-control'])
      expect(dockerfile).toContain(
        `test "$(readlink -f /opt/${root}/node_modules)" = /opt/agentcore/node_modules`,
      );
    expect(dockerfile).toContain(
      'find /opt/shared /opt/native-runtime-control -mindepth 2 -name node_modules -print -quit',
    );
    expect(dockerfile).toContain("import('/opt/native-runtime-control/workflow-engine-entry.js')");
    const check = dockerfile.indexOf('readlink -f /opt/native-runtime-control/node_modules');
    expect(check).toBeGreaterThan(
      dockerfile.indexOf(
        'ln -s /opt/agentcore/node_modules /opt/native-runtime-control/node_modules',
      ),
    );
    expect(dockerfile.lastIndexOf('\nUSER node')).toBeGreaterThan(check);
  });
});

describe('protected engine Lambda interface stage', () => {
  it('installs the runtime interface client from its lockfile with its documented build tools', () => {
    const stage = dockerfile.slice(
      dockerfile.indexOf(' AS native-lambda-interface'),
      dockerfile.indexOf('\nFROM ', dockerfile.indexOf(' AS native-lambda-interface')),
    );
    for (const tool of [
      'autoconf',
      'automake',
      'cmake',
      'g++',
      'gcc',
      'libtool',
      'make',
      'xz-utils',
    ])
      expect(stage).toMatch(new RegExp(`apt-get install[^&]*\\s${tool.replace('+', '\\+')}\\s`));
    expect(stage).toContain('npm ci --omit=dev');
    expect(stage).not.toContain('npm install');
    const lock = JSON.parse(
      readFileSync(
        path.join(agentcoreDir, '..', 'native-runtime-control/runtime-interface/package-lock.json'),
        'utf8',
      ),
    );
    expect(lock.packages['node_modules/aws-lambda-ric'].version).toBe('4.0.2');
    expect(lock.packages['node_modules/aws-lambda-ric'].integrity).toMatch(/^sha512-/);
  });
});

describe('container runtime file ownership', () => {
  // Two requirements meet here. Runtime code must stay readable by the node
  // user even when the checkout is restrictive (0600 files), and it must not
  // be replaceable by that user: an isolated check or reviewer child runs as
  // node between phases of a root observer that imports this code. Neither may
  // cost a recursive ownership layer, which once was a third of the image.
  const roots = ['agentcore', 'shared', 'native-runtime-control'];

  it('copies runtime code readable by the node user but owned by root', () => {
    const createDirs = dockerfile.indexOf('RUN install -d -o root -g root -m 0755');
    const copyManifest = dockerfile.indexOf(
      'COPY --chown=root:root --chmod=0644 agentcore/package.json /opt/agentcore/package.json',
    );
    expect(createDirs).toBeGreaterThan(-1);
    expect(copyManifest).toBeGreaterThan(createDirs);
    expect(dockerfile).toMatch(
      /RUN install -d -o root -g root -m 0755 \\\n\s+\/opt\/agentcore \\\n\s+\/opt\/shared \\\n\s+\/opt\/native-runtime-control \\\n/,
    );
    for (const root of roots)
      expect(dockerfile).toContain(
        `COPY --chown=root:root --chmod=u=rwX,go=rX ${root}/ /opt/${root}/`,
      );
    expect(dockerfile).toContain(
      'COPY --from=native-lambda-interface --chown=root:root /opt/native-lambda-interface',
    );
    // The writable runtime locations keep the node user.
    expect(dockerfile).toMatch(
      /install -d -o node -g node -m 0755 \\\n\s+\/mnt\/workspace \\\n\s+\/home\/node\/\.codex-state/,
    );
  });

  it('never gives the node user the runtime code and adds no recursive ownership layer', () => {
    const copies = dockerfile.split('\n').filter((line) => /^COPY\b.*\s\/opt\//.test(line));
    expect(copies.length).toBeGreaterThanOrEqual(6);
    for (const line of copies) {
      expect(line).toContain('--chown=root:root');
      expect(line).not.toContain('node:node');
    }
    expect(dockerfile).not.toMatch(/ch(?:own|mod) -R [^\n]*\/opt\//);
    expect(dockerfile).not.toMatch(/install -d -o node[^\n]*\\\n(?:\s+\S+ \\\n)*\s+\/opt\//);
    // The build itself refuses node-owned or group/world-writable runtime code.
    expect(dockerfile).toMatch(
      /find \/opt\/agentcore \/opt\/shared \/opt\/native-runtime-control \/opt\/native-lambda-interface \\\n\s+! -type l \\\( -user node -o -group node -o -perm \/022 \\\) -print -quit/,
    );
    const user = dockerfile.lastIndexOf('\nUSER node');
    expect(user).toBeGreaterThan(dockerfile.indexOf('-perm /022'));
  });
});
