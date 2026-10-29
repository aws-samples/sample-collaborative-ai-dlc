import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analysisMap, loadFrame, nestedPicture } from './frame.mjs';
import { digestOf, loadAnchors } from './anchors.mjs';
import { evidenceOf } from './evidence.mjs';
import { guardRead } from './reader-guard.mjs';

const exec = promisify(execFile);
export const ISOBAR_REVISION = '2ec719904ac7dc30de08e152e4622fe8e02fa57a';
const SHA = /^[a-f0-9]{40}$/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST =
  /(^|\/)(test|tests|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/;

// Repository content is data: these commands do not run builds, hooks, or PR scripts.
export async function runGit(argv) {
  if (argv[0] !== 'git') throw new Error('The Isobar adapter only permits Git reads');
  try {
    const { stdout } = await exec('git', argv.slice(1), {
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.code ?? 1, stdout: error.stdout ?? '' };
  }
}

export async function gitText(repo, ...args) {
  const result = await runGit(['git', '-C', repo, '-c', 'diff.autoRefreshIndex=false', ...args]);
  if (result.exitCode !== 0) throw new Error(`Git ${args[0]} failed (${result.exitCode})`);
  return result.stdout;
}

// Read immutable blobs instead of the working tree. This also supports a bare
// object store in CI, where no contributor files are ever checked out.
export function treeRun(headSha, invoke = runGit) {
  return async (argv) => {
    let command = 3;
    while (argv[command] === '-c') command += 2;
    if (argv[command] === 'rev-parse' && argv[command + 1] === 'HEAD') {
      return invoke([...argv.slice(0, command + 1), headSha]);
    }
    if (argv[command] === 'log') {
      return invoke([...argv, headSha, '--']);
    }
    if (argv[command] !== 'grep' && argv[command] !== 'ls-files') return invoke(argv);
    if (argv[command] === 'ls-files') {
      const result = await invoke([...argv.slice(0, command), 'ls-tree', '-r', '-z', headSha]);
      return {
        ...result,
        stdout: result.stdout
          .split('\0')
          .map((row) => row.replace(/^([0-7]+) blob ([a-f0-9]+)\t/, '$1 $2 0\t'))
          .join('\0'),
      };
    }
    const args = argv.slice(command + 1);
    const separator = args.indexOf('--');
    const end = separator < 0 ? args.length : separator;
    let hasRevision = false;
    for (let i = 0; i < end; i++) {
      if (args[i] === '-e' || args[i] === '-f') {
        i++;
        continue;
      }
      if (SHA.test(args[i]) || args[i] === 'HEAD') hasRevision = true;
    }
    if (hasRevision) return invoke(argv);
    args.splice(end, 0, headSha);
    const result = await invoke([...argv.slice(0, command + 1), ...args]);
    const prefix = `${headSha}:`;
    return {
      ...result,
      stdout: result.stdout
        .split('\n')
        .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
        .join('\n'),
    };
  };
}

export function changeFlags(status) {
  const parts = status.split('\0');
  const flags = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    flags.set(parts[i + 1], { isNew: parts[i] === 'A', isDeleted: parts[i] === 'D' });
  }
  return flags;
}

export function summaryOf(changes) {
  return {
    files: changes.length,
    added: changes.reduce((sum, change) => sum + change.added, 0),
    deleted: changes.reduce((sum, change) => sum + change.deleted, 0),
    testFiles: changes.filter(({ path }) => TEST.test(path)).length,
  };
}

export async function render({
  repo,
  upstream,
  mapPath,
  baseSha,
  headSha,
  prNumber,
  repository,
  out,
  python = 'python3',
}) {
  if (!SHA.test(baseSha) || !SHA.test(headSha))
    throw new Error('Expected full base and head commit SHAs');
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('Invalid PR number');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  await gitText(repo, 'cat-file', '-e', `${headSha}^{commit}`);
  await gitText(repo, 'cat-file', '-e', `${baseSha}^{commit}`);
  if ((await gitText(upstream, 'rev-parse', 'HEAD')).trim() !== ISOBAR_REVISION) {
    throw new Error('Isobar checkout does not match the pinned tool revision');
  }
  const mergeBaseSha = (await gitText(repo, 'merge-base', baseSha, headSha)).trim();
  if (!SHA.test(mergeBaseSha)) throw new Error('No merge base found');
  const load = (path) => import(pathToFileURL(resolve(upstream, path)).href);
  const [
    { gatherFacts, parseNumstat },
    { graphOf, reachOf, isTest },
    { readChange, textsOf },
    { layoutOf },
    { fieldOf },
    { inksOf },
  ] = await Promise.all([
    load('hooks/engine/git.ts'),
    load('hooks/engine/graph.ts'),
    load('hooks/engine/symbols.ts'),
    load('hooks/render/layout.ts'),
    load('hooks/render/field.ts'),
    load('hooks/render/palette.ts'),
  ]);
  // Never call Isobar's preview CLI: its missing-map fallback invokes a model.
  const mapBytes = await readFile(mapPath);
  const mapDigest = digestOf(mapBytes);
  const frame = loadFrame(JSON.parse(mapBytes));
  const anchorSource = JSON.parse(
    await readFile(resolve(dirname(mapPath), 'anchors.json'), 'utf8'),
  );
  if (anchorSource.mapDigest !== mapDigest) throw new Error('Fixed anchors do not match the map');
  const anchors = loadAnchors(anchorSource, frame);
  const [facts, numstat, status] = await Promise.all([
    // History is not part of the orientation map.
    gatherFacts(treeRun(headSha), repo, 0),
    gitText(
      repo,
      'diff',
      '--numstat',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      mergeBaseSha,
      headSha,
      '--',
    ),
    gitText(
      repo,
      'diff',
      '--name-status',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      mergeBaseSha,
      headSha,
      '--',
    ),
  ]);
  if (facts.head !== headSha || facts.lines.size === 0)
    throw new Error('Isobar could not read the PR tree');
  const flags = changeFlags(status);
  const changes = parseNumstat(numstat).map((change) => ({ ...change, ...flags.get(change.path) }));
  const graph = graphOf(facts.edges);
  const knownMap = analysisMap(frame, [...facts.lines.keys(), ...changes.map(({ path }) => path)]);
  const read = await readChange(
    runGit,
    repo,
    facts,
    changes,
    { from: mergeBaseSha, to: headSha },
    graph,
  );
  const guardedPaths = [...read.shapes].filter(([, s]) => s.kind !== 'file').map(([p]) => p);
  if (guardedPaths.length) {
    const [before, after] = await Promise.all(
      [mergeBaseSha, headSha].map(async (sha) => {
        const result = await runGit([
          'git',
          '-C',
          repo,
          'grep',
          '-z',
          '-n',
          '-I',
          '-e',
          '',
          sha,
          '--',
          ...guardedPaths,
        ]);
        if (result.exitCode !== 0 && result.exitCode !== 1)
          throw new Error('Source evidence grep failed');
        return result.stdout;
      }),
    );
    guardRead(read, textsOf(before, mergeBaseSha), textsOf(after, headSha));
  }
  const baseGraph = changes.some(({ isDeleted }) => isDeleted)
    ? graphOf((await gatherFacts(treeRun(mergeBaseSha), repo, 0)).edges)
    : undefined;
  const evidence = evidenceOf({
    frame,
    facts,
    changes,
    read,
    graph,
    baseGraph,
    reachOf,
    isTest,
    anchors,
    revision: ISOBAR_REVISION,
    mapDigest,
  });
  // Upstream's visual field uses weather-shaped inputs. Supply a constant
  // marker for every change; no score or history influences the image.
  const weather = {
    cells: evidence.changes.map(({ path, leafId }) => ({
      path,
      region: leafId,
      risk: 0.5,
      isLatest: true,
    })),
    reach: [],
    arms: [],
    offshoots: [],
    expected: [],
  };
  const picture = await nestedPicture({
    frame,
    facts,
    weather,
    map: knownMap,
    layoutOf,
    fieldOf,
    inks: inksOf('paper', 'truecolor'),
    anchors,
    evidence,
  });
  const summary = summaryOf(changes);
  picture.caption = `PR #${prNumber} · ${headSha.slice(0, 7)} · ${summary.files} files · +${summary.added} / −${summary.deleted} · full PR diff`;
  const report = {
    schemaVersion: 1,
    repository,
    prNumber,
    headSha,
    baseSha,
    mergeBaseSha,
    generatedAt: new Date().toISOString(),
    tool: { name: 'isobar', revision: ISOBAR_REVISION },
    summary,
    files: changes,
    reach: evidence.reachByCause.map(({ path, of, hop }) => ({ path, of, hop })),
    evidence,
    provenance: {
      mapDigest,
      anchorVersion: anchors.version,
      anchorBaselineSha: anchors.baselineSha,
    },
  };
  await mkdir(out, { recursive: true });
  const gridPath = resolve(out, 'grid.json');
  await writeFile(gridPath, JSON.stringify(picture));
  await exec(
    python,
    [resolve(ROOT, 'scripts/pr-impact/render-frame.py'), gridPath, resolve(out, 'map.png')],
    { timeout: 120_000 },
  );
  await writeFile(resolve(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `PR #${prNumber}: ${report.summary.files} files · +${report.summary.added} −${report.summary.deleted} · ${evidence.reachByCause.length} static reach links`,
  );
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      upstream: { type: 'string' },
      map: { type: 'string', default: resolve(ROOT, '.isobar/map.json') },
      base: { type: 'string' },
      head: { type: 'string' },
      number: { type: 'string' },
      repository: { type: 'string', default: 'aws-samples/sample-collaborative-ai-dlc' },
      out: { type: 'string' },
      python: { type: 'string', default: 'python3' },
    },
  });
  for (const key of ['repo', 'upstream', 'base', 'head', 'number', 'out']) {
    if (!values[key]) throw new Error(`Missing --${key}`);
  }
  await render({
    repo: resolve(values.repo),
    upstream: resolve(values.upstream),
    mapPath: resolve(values.map),
    baseSha: values.base,
    headSha: values.head,
    prNumber: Number(values.number),
    repository: values.repository,
    out: resolve(values.out),
    python: values.python,
  });
}
