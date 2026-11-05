#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  analyzeSource,
  compareFunctions,
  complexityRule,
  complexityThreshold,
  createAnalyzer,
  summarizeFunctions,
} from './complexity-analysis.mjs';
import { attachCoverage, hasCoverage } from './complexity-coverage.mjs';
import {
  renderComparison,
  renderComplexityDetails,
  renderDependencyDetails,
} from './complexity-report.mjs';
export { renderComparison } from './complexity-report.mjs';

const require = createRequire(import.meta.url);
const loadCoverage = async (path) => (path ? JSON.parse(await readFile(path, 'utf8')) : undefined);
// This advisory comparison tolerates Node minor/patch changes within a major.
const instrumenterKey = (snapshot) =>
  JSON.stringify({
    ...snapshot.instrumenter,
    node: snapshot.instrumenter?.node?.split('.')[0],
  });

function git(cwd, args) {
  return execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveCommit(cwd, ref) {
  return git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
}

function changedFiles(cwd, base, pr) {
  const fields = git(cwd, ['diff', '--name-status', '-z', '--find-renames', base, pr, '--']).split(
    '\0',
  );
  const files = [];
  for (let index = 0; fields[index];) {
    const status = fields[index++];
    const oldPath = fields[index++];
    const path = status.startsWith('R') ? fields[index++] : oldPath;
    files.push({
      path,
      previousPath: status === 'A' ? null : oldPath,
      prPath: status === 'D' ? null : path,
    });
  }
  return files;
}

async function measure(cwd, analyzer, revision, path, coverage) {
  if (path === null) return null;
  const fileConfig = await analyzer.calculateConfigForFile(resolve(cwd, path));
  if (!fileConfig?.rules?.[complexityRule]) return null;
  const tree = git(cwd, ['ls-tree', '-z', revision, '--', path]);
  if (!/^100(644|755) blob /.test(tree)) {
    throw new Error(`${revision}:${path}: expected a regular source file`);
  }
  const source = git(cwd, ['show', `${revision}:${path}`]);
  return attachCoverage(
    await analyzeSource(cwd, path, source),
    source,
    coverage?.files[path],
    coverage,
    revision,
  );
}

async function dependentFiles(cwd, analyzer, pr) {
  const snapshot = await mkdtemp(join(tmpdir(), 'complexity-dependencies-'));
  try {
    const counts = new Map();
    const files = [];
    const entries = git(cwd, ['ls-tree', '-r', '-z', pr, '--', 'lambda', 'package.json']).split(
      '\0',
    );
    for (const entry of entries.filter(Boolean)) {
      const path = entry.slice(entry.indexOf('\t') + 1);
      const source =
        /\.[cm]?js$/.test(path) &&
        (await analyzer.calculateConfigForFile(resolve(cwd, path)))?.rules?.[complexityRule];
      if (!source && !path.endsWith('package.json')) continue;
      const blob = /^100(?:644|755) blob ([a-f0-9]+)\t/.exec(entry);
      if (!blob) throw new Error(`${pr}:${path}: expected a regular file`);
      files.push({ path, objectId: blob[1] });
      if (source) counts.set(path, new Set());
    }
    if (!counts.size) return new Map();
    // One Git process, using object IDs so filenames cannot affect the batch protocol.
    // Read raw blobs: archive/checkout can omit or transform files via Git attributes.
    const blobs = execFileSync('git', ['cat-file', '--batch'], {
      cwd,
      input: files.map((file) => `${file.objectId}\n`).join(''),
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let offset = 0;
    for (const { path, objectId } of files) {
      const headerEnd = blobs.indexOf(10, offset);
      const header = /^([a-f0-9]+) blob (\d+)$/.exec(blobs.toString('ascii', offset, headerEnd));
      if (headerEnd < offset || header?.[1] !== objectId) throw new Error('Invalid Git blob batch');
      const end = headerEnd + 1 + Number(header[2]);
      if (end >= blobs.length || blobs[end] !== 10) throw new Error('Truncated Git blob batch');
      await mkdir(dirname(join(snapshot, path)), { recursive: true });
      await writeFile(join(snapshot, path), blobs.subarray(headerEnd + 1, end));
      offset = end + 1;
    }
    if (offset !== blobs.length) throw new Error('Unexpected Git blob batch data');
    // Use the installed CLI in an isolated source snapshot: no PR configuration,
    // dependencies, scripts or dirty files are loaded or executed.
    const cli = fileURLToPath(
      new URL('../../bin/dependency-cruise.mjs', import.meta.resolve('dependency-cruiser')),
    );
    const graph = JSON.parse(
      execFileSync(
        process.execPath,
        [
          cli,
          '--no-config',
          '--output-type',
          'json',
          '--include-only',
          '^lambda/',
          '--do-not-follow',
          'node_modules',
          'lambda',
        ],
        {
          cwd: snapshot,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
    for (const module of graph.modules) {
      if (!counts.has(module.source)) continue;
      for (const dependency of module.dependencies) {
        if (!dependency.couldNotResolve && dependency.resolved !== module.source) {
          counts.get(dependency.resolved)?.add(module.source);
        }
      }
    }
    return new Map([...counts].map(([path, importers]) => [path, [...importers].toSorted()]));
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

export async function compareRevisions({
  cwd,
  base = 'origin/main',
  pr = 'HEAD',
  baseRef,
  baseCoverage,
  prCoverage,
  baseFrontendCoverage,
  prFrontendCoverage,
  coverageNotNeeded = false,
}) {
  const baseSha = resolveCommit(cwd, base);
  const prSha = resolveCommit(cwd, pr);
  const mergeBase = git(cwd, ['merge-base', baseSha, prSha]).trim();
  const analyzer = createAnalyzer(cwd);
  const candidates = changedFiles(cwd, mergeBase, prSha);
  const coverageNotes = [];
  const pairs = {
    backend: [baseCoverage, prCoverage],
    frontend: [baseFrontendCoverage, prFrontendCoverage],
  };
  for (const [scope, pair] of Object.entries(pairs)) {
    const relevant =
      scope === 'backend' ||
      pair.some(Boolean) ||
      candidates.some((file) => file.path.startsWith('frontend/src/'));
    if (!relevant) continue;
    const prefix = scope === 'frontend' ? 'Frontend ' : '';
    for (const [index, label, revision] of [
      [0, 'Merge-base', mergeBase],
      [1, 'PR', prSha],
    ]) {
      const snapshot = pair[index];
      if (!snapshot) {
        coverageNotes.push(
          `${prefix}${label} coverage: ${coverageNotNeeded && scope === 'backend' ? 'not needed for this change' : 'unknown (no report supplied)'}.`,
        );
      } else if (!hasCoverage(snapshot)) {
        coverageNotes.push(
          `${prefix}${label} coverage: unknown (test run or coverage collection failed to produce a report).`,
        );
      } else if (snapshot.revision !== revision) {
        coverageNotes.push(
          `${prefix}${label} coverage: unknown (report belongs to a different revision).`,
        );
      } else if (snapshot.status === 'partial') {
        coverageNotes.push(
          `${prefix}${label} coverage: measured with failing or interrupted tests (*). Counts and deltas may reflect incomplete execution.`,
        );
      }
    }
    if (pair.every(hasCoverage) && instrumenterKey(pair[0]) !== instrumenterKey(pair[1])) {
      coverageNotes.push(
        `${prefix}Coverage is unknown: Node major, Vitest, provider, or coverage configuration differs.`,
      );
      pair.fill(undefined);
    }
  }
  const coverageFor = (path, index) =>
    pairs[path?.startsWith('frontend/') ? 'frontend' : 'backend'][index];
  const files = [];
  for (const file of candidates) {
    const before = await measure(
      cwd,
      analyzer,
      mergeBase,
      file.previousPath,
      coverageFor(file.previousPath, 0),
    );
    const after = await measure(cwd, analyzer, prSha, file.prPath, coverageFor(file.prPath, 1));
    if (before === null && after === null) continue;
    files.push({
      path: file.path,
      previousPath: file.previousPath,
      prPath: file.prPath,
      before: before ?? [],
      after: after ?? [],
      summary: {
        before: summarizeFunctions(before ?? []),
        after: summarizeFunctions(after ?? []),
      },
    });
  }
  const comparison = compareFunctions(files);
  const rows = [...comparison.findings, ...comparison.improvements];
  let dependents = new Map();
  let dependencyNote;
  if (files.some((file) => file.prPath?.startsWith('lambda/'))) {
    try {
      dependents = await dependentFiles(cwd, analyzer, prSha);
    } catch (error) {
      console.warn(`Dependency analysis failed: ${error.message}`);
      dependencyNote = 'Depending files: unknown (dependency analysis failed).';
    }
  }
  for (const row of rows) row.dependentFiles = dependents.get(row.path)?.length ?? null;
  const dependencies = files.map((file) => ({
    path: file.path,
    importers: dependents.get(file.prPath) ?? null,
    reason: !file.prPath
      ? 'File deleted in PR'
      : !file.prPath.startsWith('lambda/')
        ? 'Backend only'
        : dependents.has(file.prPath)
          ? null
          : 'Dependency analysis unavailable',
  }));
  return {
    schemaVersion: 1,
    base: baseSha,
    baseRef,
    mergeBase,
    pr: prSha,
    coverageNotes,
    ...(dependencyNote ? { dependencyNote } : {}),
    analyzer: {
      rule: complexityRule,
      sonarjs: require('eslint-plugin-sonarjs/package.json').version,
      eslint: require('eslint/package.json').version,
      parser: require('@typescript-eslint/parser/package.json').version,
      threshold: complexityThreshold,
    },
    files,
    dependencies,
    ...comparison,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'origin/main' },
      pr: { type: 'string', default: 'HEAD' },
      'base-ref': { type: 'string' },
      'output-dir': { type: 'string', default: 'reports/complexity' },
      'base-coverage': { type: 'string' },
      'pr-coverage': { type: 'string' },
      'base-frontend-coverage': { type: 'string' },
      'pr-frontend-coverage': { type: 'string' },
      'coverage-not-needed': { type: 'boolean', default: false },
    },
  });
  const cwd = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const report = await compareRevisions({
    cwd,
    base: values.base,
    pr: values.pr,
    baseRef: values['base-ref'],
    baseCoverage: await loadCoverage(values['base-coverage']),
    prCoverage: await loadCoverage(values['pr-coverage']),
    baseFrontendCoverage: await loadCoverage(values['base-frontend-coverage']),
    prFrontendCoverage: await loadCoverage(values['pr-frontend-coverage']),
    coverageNotNeeded: values['coverage-not-needed'],
  });
  const markdown = renderComparison(report);
  const outputDir = resolve(cwd, values['output-dir']);
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outputDir, 'comparison.md'), markdown);
  const { schemaVersion, mergeBase, pr, analyzer, coverageNotes, files, dependencies } = report;
  await writeFile(
    join(outputDir, 'complexity.json'),
    `${JSON.stringify({ schemaVersion, mergeBase, pr, analyzer, coverageNotes, files }, null, 2)}\n`,
  );
  await writeFile(join(outputDir, 'complexity.md'), renderComplexityDetails(report));
  await writeFile(
    join(outputDir, 'dependencies.json'),
    `${JSON.stringify({ schemaVersion, pr, scope: 'Direct production importers, backend only', files: dependencies }, null, 2)}\n`,
  );
  await writeFile(join(outputDir, 'dependencies.md'), renderDependencyDetails(report));
  process.stdout.write(markdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Complexity comparison failed: ${error.message}`);
    process.exitCode = 1;
  });
}
