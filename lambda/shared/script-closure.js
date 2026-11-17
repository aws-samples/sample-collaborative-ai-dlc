// One relative-import resolver, shared by the release compatibility analyzer and
// the sensor runtime.
//
// The analyzer reports `dependencyClosureComplete` for a release's sensor
// scripts; the runtime has to materialize that closure next to the script it
// spawns. Deriving both from the same walk is the point: a guard that promises a
// complete closure must not be computing it differently from the code that
// writes it.

const importSpecifiers = (content = '') =>
  [...String(content).matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .toSorted();

const relativeImportCandidate = (path, relativePath) => {
  const parts = path.split('/');
  parts.pop();
  for (const part of relativePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
};

// TypeScript sources may name a sibling module by its emitted extension
// (`./lib.js` for `lib.ts`). Bun, the release sensor runtime, resolves these to
// the source file; this mirrors its substitutions.
const TS_SOURCE_EXTENSIONS = Object.freeze({
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
});

const typeScriptSourceFor = (candidate) => {
  const extension = Object.keys(TS_SOURCE_EXTENSIONS).find((item) => candidate.endsWith(item));
  if (!extension) return [];
  const stem = candidate.slice(0, -extension.length);
  return TS_SOURCE_EXTENSIONS[extension].map((source) => `${stem}${source}`);
};

const resolveRelativeImport = (files, path, relativePath) => {
  const candidate = relativeImportCandidate(path, relativePath);
  const candidates = [
    candidate,
    ...typeScriptSourceFor(candidate),
    `${candidate}.ts`,
    `${candidate}.js`,
    `${candidate}.mjs`,
    `${candidate}.cjs`,
    `${candidate}/index.ts`,
    `${candidate}/index.js`,
    `${candidate}/index.mjs`,
    `${candidate}/index.cjs`,
  ];
  return candidates.find((item) => files.has(item)) ?? candidate;
};

const dependencyClosure = (files, entryPath) => {
  const visited = new Set();
  const visiting = [];
  const missing = new Set();
  const external = new Set();
  const cycles = new Set();

  const walk = (path) => {
    if (visited.has(path)) return;
    const cycleIndex = visiting.indexOf(path);
    if (cycleIndex !== -1) {
      cycles.add([...visiting.slice(cycleIndex), path].join(' -> '));
      return;
    }
    const content = files.get(path);
    if (content == null) {
      missing.add(path);
      return;
    }
    visiting.push(path);
    for (const specifier of importSpecifiers(content)) {
      if (!specifier.startsWith('.')) {
        external.add(specifier);
        continue;
      }
      const resolved = resolveRelativeImport(files, path, specifier);
      if (!files.has(resolved)) missing.add(resolved);
      else walk(resolved);
    }
    visiting.pop();
    visited.add(path);
  };

  walk(entryPath);
  return {
    files: [...visited].toSorted(),
    missing: [...missing].toSorted(),
    external: [...external].toSorted(),
    cycles: [...cycles].toSorted(),
  };
};

export { importSpecifiers, relativeImportCandidate, resolveRelativeImport, dependencyClosure };
export default { importSpecifiers, resolveRelativeImport, dependencyClosure };
