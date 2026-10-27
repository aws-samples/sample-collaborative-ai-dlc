import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const sourceHash = (source) => createHash('sha256').update(source).digest('hex');
const unknown = (reason) => ({ status: 'unknown', reason });
const position = (point) => point.line * 1e7 + point.column;
export const hasCoverage = (snapshot) => ['complete', 'partial'].includes(snapshot?.status);

// Assign outcomes at the branch's control location, not an arm's location:
// implicit else arms have no location and an arm can itself return a callback.
// The innermost enclosing function owns the branch.
export function attachCoverage(functions, source, file, snapshot, revision) {
  let reason;
  if (!hasCoverage(snapshot)) reason = 'Coverage report unavailable';
  else if (snapshot.revision !== revision) reason = 'Coverage revision does not match';
  else if (!file) reason = 'Outside coverage scope or missing from report';
  else if (file.sourceHash !== sourceHash(source)) reason = 'Coverage source does not match';
  if (reason) return functions.map((fn) => ({ ...fn, coverage: unknown(reason) }));

  const counts = new Map(functions.map((fn) => [fn, { covered: 0, total: 0 }]));
  for (const branch of file.branches) {
    const start = position(branch.start);
    const owner = functions
      .filter((fn) => position(fn.start) <= start && start < position(fn.end))
      .toSorted((a, b) => position(b.start) - position(a.start))[0];
    if (!owner) continue; // Module-level branches are not function coverage.
    const count = counts.get(owner);
    count.total++;
    if (branch.hit) count.covered++;
  }
  return functions.map((fn) => {
    const { covered, total } = counts.get(fn);
    return {
      ...fn,
      coverage: {
        status: 'measured',
        partial: snapshot.status === 'partial',
        covered,
        total,
        uncovered: total - covered,
        percent: total ? (100 * covered) / total : null,
      },
    };
  });
}

export function coverageChange(before, after) {
  if (before?.status !== 'measured' || after?.status !== 'measured') return null;
  return {
    percentagePoints:
      before.percent === null || after.percent === null ? null : after.percent - before.percent,
    uncovered: after.uncovered - before.uncovered,
  };
}

export function coverageRegressed(before, after) {
  const change = coverageChange(before, after);
  return change !== null && (change.percentagePoints < 0 || change.uncovered > 0);
}

export async function collectCoverage({ cwd, input, successful }) {
  cwd = await realpath(cwd);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const snapshot = { schemaVersion: 1, revision, status: 'unavailable', files: {} };
  if (!input && !successful) return snapshot;
  let raw;
  try {
    raw = JSON.parse(await readFile(input, 'utf8'));
  } catch (error) {
    if (!successful && error.code === 'ENOENT') return snapshot;
    throw error;
  }
  const require = createRequire(resolve(cwd, 'package.json'));
  snapshot.instrumenter = {
    node: process.versions.node,
    vitest: require('vitest/package.json').version,
    provider: require('@vitest/coverage-v8/package.json').version,
    config: sourceHash(await readFile(resolve(cwd, 'vitest.config.js'))),
  };
  for (const [path, coverage] of Object.entries(raw)) {
    const name = relative(cwd, path).split('\\').join('/');
    if (name.startsWith('../') || isAbsolute(name) || !name.startsWith('lambda/')) continue;
    const branches = [];
    for (const [id, branch] of Object.entries(coverage.branchMap)) {
      branch.locations.forEach((_location, index) => {
        const hits = coverage.b[id]?.[index];
        if (!Number.isFinite(hits) || !branch.loc?.start?.line) {
          throw new Error(`Invalid branch coverage in ${name}`);
        }
        // V8 can infer negative else counts. Match Istanbul's coverage
        // semantics: positive counts are covered; non-positive are uncovered.
        branches.push({ start: branch.loc.start, hit: hits > 0 });
      });
    }
    snapshot.files[name] = {
      sourceHash: sourceHash(await readFile(resolve(cwd, name))),
      branches,
    };
  }
  snapshot.status = successful ? 'complete' : 'partial';
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      cwd: { type: 'string', default: process.cwd() },
      input: { type: 'string' },
      output: { type: 'string' },
      successful: { type: 'boolean', default: false },
    },
  });
  try {
    const snapshot = await collectCoverage({
      cwd: resolve(values.cwd),
      input: values.input,
      successful: values.successful,
    });
    await writeFile(values.output, `${JSON.stringify(snapshot)}\n`);
  } catch (error) {
    console.error(`Coverage collection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
