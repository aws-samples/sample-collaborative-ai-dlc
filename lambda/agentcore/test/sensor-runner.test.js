import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSensorRunner, __test } from '../sensor-runner.js';

const { globToRegExp, resultFromScript } = __test;

describe('globToRegExp', () => {
  it('matches a brace-alternation code glob', () => {
    const re = globToRegExp('**/*.{ts,tsx}');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/a.tsx')).toBe(true);
    expect(re.test('src/a.js')).toBe(false);
  });
  it('matches an aidlc-docs path glob', () => {
    const re = globToRegExp('**/aidlc-docs/**');
    expect(re.test('aidlc-docs/x/y.md')).toBe(true);
    expect(re.test('src/aidlc-docs/z.md')).toBe(true);
    expect(re.test('src/other.md')).toBe(false);
  });
});

describe('resultFromScript', () => {
  it('reads the stdout JSON pass field over the exit code', () => {
    expect(resultFromScript({ exitCode: 0, stdout: '{"pass":false}' }).result).toBe('FAIL');
    expect(resultFromScript({ exitCode: 0, stdout: '{"pass":true}' }).result).toBe('PASS');
  });
  it('falls back to the exit code without JSON', () => {
    expect(resultFromScript({ exitCode: 2, stdout: '' }).result).toBe('INCONCLUSIVE');
  });
});

// A fake graph-writer returning canned artifact rows by type.
const fakeGraph = (byType) => ({
  lookupArtifacts: async ({ artifactType }) => byType[artifactType] ?? [],
});

describe('runStageSensors — graph kind', () => {
  it('passes required-sections when produced content has >= 2 H2s', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ requirements: [{ id: 'r1', content: '## A\n## B\n' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'requirements' }],
      stageId: 'requirements-analysis',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'graph', result: 'PASS', held: false });
  });

  it('a blocking required-sections that fails marks the verdict held', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ requirements: [{ id: 'r1', content: '## only one' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'blocking' }],
      outputArtifacts: [{ artifact: 'requirements' }],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ result: 'FAIL', held: true });
  });

  it('upstream-coverage flags an unreferenced consume', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ design: [{ id: 'd1', content: 'mentions requirements only' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'upstream-coverage', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'design' }],
      inputArtifacts: [{ artifact: 'requirements' }, { artifact: 'security-design' }],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('FAIL');
    expect(verdicts[0].detail.artifacts[0].unreferenced).toEqual(['security-design']);
  });

  it('upstream-coverage skips expectedAbsent consumes (no false FAIL in lean scopes)', async () => {
    // `unit-of-work` is never produced in this scope (producer out of scope) —
    // the output can't legitimately reference it, so it must not be threaded
    // into the coverage check. Only the present input counts.
    const runner = createSensorRunner({
      graph: fakeGraph({ design: [{ id: 'd1', content: 'derived from requirements' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'upstream-coverage', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'design' }],
      inputArtifacts: [
        { artifact: 'requirements', required: true },
        { artifact: 'unit-of-work', required: true, expectedAbsent: true },
      ],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('PASS');
  });

  it('INCONCLUSIVE when the stage produced no artifacts', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({}),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'advisory' }],
      outputArtifacts: [],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
  });
});

describe('runStageSensors — script kind', () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-ws-'));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  // A fake spawn that emits a JSON verdict on stdout and exits 0.
  const fakeSpawn =
    (stdout, code = 0) =>
    () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', code);
      }, 0);
      return child;
    };

  it('INCONCLUSIVE when no workspace file matches the glob', async () => {
    await writeFile(path.join(ws, 'README.md'), '# hi');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'console.log("{}")',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.{ts,js}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
    expect(verdicts[0].detail.reason).toBe('no files match');
  });

  it('spawns the materialized script per matching file and reads its verdict', async () => {
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'a.ts'), 'export const x = 1;');
    let scriptWritten = '';
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        scriptWritten = 'SENSOR_SCRIPT_BODY';
        return scriptWritten;
      },
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true,"errorCount":0}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun <runtime-managed>/tools/aidlc-sensor-linter.ts',
          matches: '**/*.{ts,js}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'script', result: 'PASS', held: false });
    expect(verdicts[0].detail.files[0].file).toBe('src/a.ts');
  });

  it('BLOCKED when a script sensor has no script bytes', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => '',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ result: 'BLOCKED', held: true });
  });
});
