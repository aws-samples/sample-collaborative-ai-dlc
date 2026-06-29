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
