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
