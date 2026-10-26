// Script-sensor INTEGRATION test — proves the code-quality verification axis
// end-to-end with a REAL bun + the REAL upstream sensor script against a REAL
// throwaway project on disk. This is the slice the deployed `intent-capture`
// validation could NOT exercise (that run only produced methodology documents,
// which the graph sensors check in-process — no code on disk to lint/type-check).
//
// What it proves, through the actual `createSensorRunner` path (not a fake spawn):
//   workspace glob → materialize the sensor script from "S3" (loadBlockScript
//   returns the fixture bytes) → spawn `bun <script> --file-path <rel>` against
//   the checkout → parse the stdout JSON verdict → severity gate.
//
// Gated: skips when `bun` is not on PATH (CI image may lack it; the deployed
// AgentCore image installs it — see the Dockerfile). When it runs, it uses
// `bunx tsc`, which the upstream script fetches on first use.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSensorRunner } from '../sensor-runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'aidlc-sensor-type-check.ts');
const LINTER_FIXTURE = path.join(here, 'fixtures', 'aidlc-sensor-linter.ts');
const LINTER_CLOSURE_FIXTURE = path.join(here, 'fixtures', 'aidlc-sensor-linter-runtime-budget.ts');

// Is a usable `bun` on PATH? (The runner spawns `bun`; the script then shells
// out to `bunx tsc`.) Skip the whole suite when absent so CI stays green.
const bunAvailable = (() => {
  try {
    return spawnSync('bun', ['--version'], { encoding: 'utf-8' }).status === 0;
  } catch {
    return false;
  }
})();

// The seeded SENSOR block shape for `type-check` (mirrors block-mappers mapSensor
// + the resolved plan sensor): a server-controlled bun command + the code glob.
const typeCheckSensor = (severity = 'blocking') => ({
  sensorId: 'type-check',
  severity,
  runtime: 'bun',
  command: 'bun <runtime-managed>/tools/aidlc-sensor-type-check.ts',
  matches: '**/*.{ts,tsx}',
  timeoutSeconds: 120,
});

describe.skipIf(!bunAvailable)('script-sensor integration (real bun + real tsc)', () => {
  let ws;
  let fixtureScript;

  beforeAll(async () => {
    fixtureScript = await readFile(FIXTURE, 'utf-8');
  });

  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'aidlc-codesensor-'));
    // A minimal but REAL TypeScript project so `tsc --project` has settings.
    await writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }),
    );
    await writeFile(
      path.join(ws, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
    );
    await mkdir(path.join(ws, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  // The runner materializes the script from loadBlockScript (== S3 in prod); the
  // fixture is the verbatim upstream script, so this is the production code path.
  const runner = () =>
    createSensorRunner({
      graph: null,
      loadBlockScript: async () => fixtureScript,
      workspaceDir: ws,
    });

  it('PASSES a clean TypeScript file', async () => {
    await writeFile(path.join(ws, 'src', 'good.ts'), 'export const n: number = 42;\n');
    const [verdict] = await runner().runStageSensors({
      sensors: [typeCheckSensor('blocking')],
      stageId: 'code-generation',
    });
    expect(verdict).toMatchObject({ kind: 'script', result: 'PASS', held: false });
    const file = verdict.detail.files.find((f) => f.file === 'src/good.ts');
    expect(file.detail.pass).toBe(true);
  }, 120_000);

  it('FAILS a file with a real type error and (blocking) holds the stage', async () => {
    await writeFile(path.join(ws, 'src', 'bad.ts'), 'export const n: number = "not a number";\n');
    const [verdict] = await runner().runStageSensors({
      sensors: [typeCheckSensor('blocking')],
      stageId: 'code-generation',
    });
    expect(verdict.result).toBe('FAIL');
    expect(verdict.held).toBe(true);
    const file = verdict.detail.files.find((f) => f.file === 'src/bad.ts');
    expect(file.detail.pass).toBe(false);
    expect(file.detail.errors[0].message).toMatch(/not assignable/i);
  }, 120_000);

  it('an advisory type-error FAILS the sensor but does NOT hold the stage', async () => {
    await writeFile(path.join(ws, 'src', 'bad.ts'), 'export const n: number = "still wrong";\n');
    const [verdict] = await runner().runStageSensors({
      sensors: [typeCheckSensor('advisory')],
      stageId: 'code-generation',
    });
    expect(verdict.result).toBe('FAIL');
    expect(verdict.held).toBe(false);
  }, 120_000);
});

// Script-sensor INTEGRATION test for the documented exit codes — the REAL 2.11
// `linter` script, spawned by a REAL bun against a REAL project that has no
// eslint configuration, which is the shape every repository in a lane workspace
// had on staging. The script's contract (core/tools/aidlc-sensor-linter.ts,
// 6a378b53c0) reserves exit 127 for "eslint unresolvable OR no eslint config
// found", and its dispatcher answers 127 with a PASS noted tool-unavailable.
// Which of the two markers this machine produces depends on whether an eslint@10
// is resolvable here, so the test accepts either and asserts the reason names
// whichever one the script actually reported.
describe.skipIf(!bunAvailable)('script-sensor exit codes (real bun + the real 2.11 linter)', () => {
  let ws;
  let linterScript;
  let closureScript;

  beforeAll(async () => {
    linterScript = await readFile(LINTER_FIXTURE, 'utf-8');
    closureScript = await readFile(LINTER_CLOSURE_FIXTURE, 'utf-8');
  });

  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'aidlc-lintexit-'));
    // A real project root (the script walks up to the nearest package.json) with
    // deliberately NO eslint config of any flavour.
    await writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }),
    );
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'only.ts'), 'export const n = 1;\n');
  });

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  // The release path: the script plus the one sibling module it imports, which
  // the resolver publishes under its upstream relative path.
  const runner = () =>
    createSensorRunner({
      graph: null,
      loadBlockScript: async () => linterScript,
      loadScriptClosure: async () => [
        { relativePath: 'aidlc-runtime-budget.ts', content: closureScript },
      ],
      workspaceDir: ws,
    });

  const linter = (extra = {}) => ({
    sensorId: 'linter',
    severity: 'advisory',
    runtime: 'bun',
    command: '{{INVOKE}} engine sensor-linter',
    matches: '**/*.{ts,js}',
    timeoutSeconds: 120,
    ...extra,
  });

  const MARKER_REASONS = Object.freeze({
    'eslint-unavailable': 'eslint is not available here, so the check did not run',
    'no-eslint-config': 'no eslint configuration was found, so the check did not run',
  });

  it('passes the real 127 exit and names the tool or config the script reported', async () => {
    const [verdict] = await runner().runStageSensors({
      sensors: [linter({ dispatcherExitCodes: true })],
      stageId: 'functional-design',
    });
    expect(verdict).toMatchObject({ kind: 'script', result: 'PASS', held: false });
    const file = verdict.detail.files.find((f) => f.file === 'src/only.ts');
    expect(file.detail).toMatchObject({ toolUnavailable: true, exitCode: 127 });
    expect(Object.values(MARKER_REASONS)).toContain(file.detail.reason);
    expect(verdict.detail.reason).toBe(`1 of 1 files: ${file.detail.reason}`);
  }, 120_000);

  // Same real script, same real exit, with no authored contract on the sensor:
  // the default exit mapping, kept for unpinned runs and every catalog that
  // invokes its scripts directly. It carries no sensor-level reason and none of
  // the dispatcher contract's reading of the exit.
  it('is the default mapping with no reason when the catalog authors no contract', async () => {
    const [verdict] = await runner().runStageSensors({
      sensors: [linter()],
      stageId: 'functional-design',
    });
    expect(verdict).toMatchObject({ kind: 'script', result: 'INCONCLUSIVE', held: false });
    expect(verdict.detail).not.toHaveProperty('reason');
    expect(verdict.detail.harnessFailures[0]).toMatchObject({
      reason: 'tool-unavailable',
      exitCode: 127,
    });
    expect(verdict.detail.harnessFailures[0]).not.toHaveProperty('toolUnavailable');
  }, 120_000);
});
