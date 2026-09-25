// `SENSOR.fire_on` — the two execution planes.
//
// The correctness claim these tests defend is a TIMING claim: the write plane
// runs post-agent on the attempt's delta, the gate plane runs after the reviewer
// loop on every declared deliverable, and a legacy caller that asks for neither
// still gets exactly one pass over everything. A plane that quietly narrowed its
// candidate set, or a `planes: null` call that stopped running a `gate` sensor at
// all, would both be invisible without these.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSensorRunner } from '../sensor-runner.js';
import { sensorGateFindings } from '../../shared/gate-preconditions.js';

const graphOf = (byType) => ({
  lookupArtifacts: async ({ artifactType }) => byType[artifactType] ?? [],
});

const GATE_SENSOR = Object.freeze({
  sensorId: 'required-sections',
  severity: 'advisory',
  fireOn: 'gate',
});
const WRITE_SENSOR = Object.freeze({
  sensorId: 'upstream-coverage',
  severity: 'advisory',
  fireOn: 'write',
});

describe('fire_on planes — partitioning', () => {
  const runnerFor = (byType) =>
    createSensorRunner({
      graph: graphOf(byType),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });

  it('runs only the gate sensors on the gate plane, and only the rest on the write plane', async () => {
    const runner = runnerFor({
      design: [{ id: 'd1', content: '## A\n## B\n mentions requirements' }],
    });
    const args = {
      sensors: [GATE_SENSOR, WRITE_SENSOR],
      outputArtifacts: [{ artifact: 'design' }],
      inputArtifacts: [{ artifact: 'requirements' }],
      stageId: 's',
    };

    const gate = await runner.runStageSensors({ ...args, planes: ['gate'] });
    expect(gate.map((v) => v.sensorId)).toEqual(['required-sections']);
    expect(gate[0].plane).toBe('gate');

    const write = await runner.runStageSensors({ ...args, planes: ['write'] });
    expect(write.map((v) => v.sensorId)).toEqual(['upstream-coverage']);
    expect(write[0].plane).toBe('write');
  });

  it('treats a sensor with no fire_on as the write plane, never the gate plane', async () => {
    const runner = runnerFor({ design: [{ id: 'd1', content: '## A\n## B' }] });
    const args = {
      sensors: [{ sensorId: 'required-sections', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'design' }],
      stageId: 's',
    };
    expect(await runner.runStageSensors({ ...args, planes: ['gate'] })).toEqual([]);
    expect((await runner.runStageSensors({ ...args, planes: ['write'] }))[0].sensorId).toBe(
      'required-sections',
    );
  });

  // The 2.3.3 / unpinned path: one pass over every sensor, and a verdict object
  // that does not gain a `plane` key no historical consumer knows about.
  it('planes: null runs every sensor in one pass and states no plane', async () => {
    const runner = runnerFor({
      design: [{ id: 'd1', content: '## A\n## B\n mentions requirements' }],
    });
    const verdicts = await runner.runStageSensors({
      sensors: [GATE_SENSOR, WRITE_SENSOR],
      outputArtifacts: [{ artifact: 'design' }],
      inputArtifacts: [{ artifact: 'requirements' }],
      stageId: 's',
    });
    expect(verdicts.map((v) => v.sensorId)).toEqual(['required-sections', 'upstream-coverage']);
    for (const verdict of verdicts) {
      expect(Object.hasOwn(verdict, 'plane')).toBe(false);
      expect(Object.keys(verdict).toSorted()).toEqual(
        ['detail', 'held', 'kind', 'result', 'sensorId', 'severity'].toSorted(),
      );
    }
  });
});

describe('fire_on gate plane — one run per EXISTING declared deliverable', () => {
  const runner = (byType) =>
    createSensorRunner({
      graph: graphOf(byType),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });

  it('evaluates every existing declared deliverable', async () => {
    const verdicts = await runner({
      design: [{ id: 'd1', content: '## A\n## B' }],
      'security-design': [{ id: 's1', content: '## A\n## B' }],
    }).runStageSensors({
      sensors: [GATE_SENSOR],
      outputArtifacts: [{ artifact: 'design' }, { artifact: 'security-design' }],
      stageId: 's',
      planes: ['gate'],
    });
    expect(verdicts[0].result).toBe('PASS');
    expect(verdicts[0].detail.artifacts.map((a) => a.artifact)).toEqual([
      'design',
      'security-design',
    ]);
  });

  it('runs zero times for a declared-but-absent OPTIONAL deliverable', async () => {
    const verdicts = await runner({
      design: [{ id: 'd1', content: '## A\n## B' }],
    }).runStageSensors({
      sensors: [GATE_SENSOR],
      outputArtifacts: [{ artifact: 'design' }, { artifact: 'notes', optional: true }],
      stageId: 's',
      planes: ['gate'],
    });
    expect(verdicts[0].detail.artifacts.map((a) => a.artifact)).toEqual(['design']);
  });

  it('reports a missing REQUIRED deliverable as a finding, never as not-applicable', async () => {
    const verdicts = await runner({}).runStageSensors({
      sensors: [GATE_SENSOR],
      outputArtifacts: [{ artifact: 'design' }],
      stageId: 's',
      planes: ['gate'],
    });
    expect(verdicts[0].detail.notApplicable).toBeUndefined();
    expect(verdicts[0].detail.artifacts).toEqual([
      { artifact: 'design', reason: 'not found in graph' },
    ]);
    expect(sensorGateFindings({ sensorVerdicts: verdicts })).toHaveLength(1);
  });

  it('records not-applicable ONLY when the stage declares no matching deliverable at all', async () => {
    const verdicts = await runner({
      notes: [{ id: 'n1', content: '## A\n## B' }],
    }).runStageSensors({
      sensors: [GATE_SENSOR],
      outputArtifacts: [{ artifact: 'notes', optional: true }],
      stageId: 's',
      planes: ['gate'],
    });
    expect(verdicts[0].result).toBe('PASS');

    const nothing = await runner({}).runStageSensors({
      sensors: [GATE_SENSOR],
      outputArtifacts: [{ artifact: 'notes', optional: true }],
      stageId: 's',
      planes: ['gate'],
    });
    expect(nothing[0].detail).toMatchObject({ notApplicable: true, fireOn: 'gate' });
    // Nothing to inspect is nothing to decide: it must not reach the human.
    expect(sensorGateFindings({ sensorVerdicts: nothing })).toEqual([]);
  });

  // The final-bytes proof: the SAME sensor on the SAME stage flips once a
  // reviewer repair round fixes the artifact. This is the whole reason the gate
  // plane runs after the reviewer loop.
  it('flips FAIL → PASS once a repair round fixes the artifact', async () => {
    const before = await runner({ design: [{ id: 'd1', content: '## only one' }] }).runStageSensors(
      {
        sensors: [{ ...GATE_SENSOR, severity: 'blocking' }],
        outputArtifacts: [{ artifact: 'design' }],
        stageId: 's',
        planes: ['gate'],
      },
    );
    expect(before[0]).toMatchObject({ result: 'FAIL', held: true });

    const after = await runner({
      design: [{ id: 'd1', content: '## A\n## B' }],
    }).runStageSensors({
      sensors: [{ ...GATE_SENSOR, severity: 'blocking' }],
      outputArtifacts: [{ artifact: 'design' }],
      stageId: 's',
      planes: ['gate'],
    });
    expect(after[0]).toMatchObject({ result: 'PASS', held: false });
  });

  // The artifact bytes change while the gate
  // plane is evaluating. The read that produced the verdict is the one recorded,
  // so the sensor fails CLOSED on the bytes it actually saw rather than reporting
  // a pass it cannot stand behind.
  it('fails closed when the deliverable changes mid-evaluation', async () => {
    let reads = 0;
    const mutating = {
      lookupArtifacts: async () => {
        reads += 1;
        return reads === 1
          ? [{ id: 'd1', content: '## only one' }]
          : [{ id: 'd1', content: '## A\n## B' }];
      },
    };
    const verdicts = await createSensorRunner({
      graph: mutating,
      loadBlockScript: async () => '',
      workspaceDir: null,
    }).runStageSensors({
      sensors: [{ ...GATE_SENSOR, severity: 'blocking' }],
      outputArtifacts: [{ artifact: 'design' }],
      stageId: 's',
      planes: ['gate'],
    });
    expect(verdicts[0]).toMatchObject({ result: 'FAIL', held: true });
    const [gateFinding] = sensorGateFindings({ sensorVerdicts: verdicts });
    expect(gateFinding).toMatchObject({
      code: 'sensor_gate_blocking',
      severity: 'blocking',
      overridable: true,
      receiptKind: 'sensor-override',
    });
  });
});

describe('fire_on gate plane — script sensors sweep the deliverables, not the delta', () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-plane-ws-'));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  const spawnOf =
    (stdout, code = 0, { hang = false } = {}) =>
    () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let killed = false;
      child.kill = () => {
        killed = true;
      };
      if (!hang) {
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from(stdout));
          child.emit('close', code);
        }, 0);
      }
      Object.defineProperty(child, 'killed', { get: () => killed });
      return child;
    };

  const scriptSensor = (overrides) => ({
    sensorId: 'linter',
    severity: 'advisory',
    runtime: 'bun',
    command: 'bun x.ts',
    matches: '**/*.{ts,js}',
    timeoutSeconds: 5,
    ...overrides,
  });

  it('ignores changedFiles on the gate plane and honours it on the write plane', async () => {
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'touched.ts'), 'export const a = 1;');
    await writeFile(path.join(ws, 'src', 'untouched.ts'), 'export const b = 2;');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'BODY',
      workspaceDir: ws,
      spawnFn: spawnOf('{"pass":true}'),
    });

    const gate = await runner.runStageSensors({
      sensors: [scriptSensor({ fireOn: 'gate' })],
      stageId: 'code-generation',
      changedFiles: ['src/touched.ts'],
      planes: ['gate'],
    });
    expect(gate[0].detail.files.map((f) => f.file).toSorted()).toEqual([
      'src/touched.ts',
      'src/untouched.ts',
    ]);

    const write = await runner.runStageSensors({
      sensors: [scriptSensor({ fireOn: 'write' })],
      stageId: 'code-generation',
      changedFiles: ['src/touched.ts'],
      planes: ['write'],
    });
    expect(write[0].detail.files.map((f) => f.file)).toEqual(['src/touched.ts']);
  });

  // The gate sensor's child never exits. The
  // budget kills it, the verdict is not a PASS, and a BLOCKING sensor therefore
  // reaches the human as an overridable blocking finding rather than a hang.
  it('a blocking gate sensor that times out becomes an overridable blocking finding', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    const verdicts = await createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'BODY',
      workspaceDir: ws,
      spawnFn: spawnOf('', 0, { hang: true }),
    }).runStageSensors({
      sensors: [scriptSensor({ severity: 'blocking', fireOn: 'gate', timeoutSeconds: 0.01 })],
      stageId: 'code-generation',
      planes: ['gate'],
    });
    expect(verdicts[0].detail.files[0].timedOut).toBe(true);
    expect(verdicts[0].result).not.toBe('PASS');
    expect(verdicts[0].held).toBe(true);
    const [gateFinding] = sensorGateFindings({ sensorVerdicts: verdicts });
    expect(gateFinding).toMatchObject({
      code: 'sensor_gate_blocking',
      severity: 'blocking',
      overridable: true,
    });
  });
});

describe('sensorGateFindings — suppression and severity', () => {
  const verdict = (overrides) => ({
    sensorId: 'claim-sources',
    result: 'FAIL',
    severity: 'advisory',
    ...overrides,
  });

  it('says nothing about a PASS', () => {
    expect(sensorGateFindings({ sensorVerdicts: [verdict({ result: 'PASS' })] })).toEqual([]);
  });

  it('keeps an advisory verdict advisory and never overridable', () => {
    const [item] = sensorGateFindings({ sensorVerdicts: [verdict()] });
    expect(item).toMatchObject({
      code: 'sensor_gate_advisory',
      severity: 'advisory',
      overridable: false,
    });
  });

  // A human who already took responsibility for a verdict must not be asked
  // again on the next revision of the same attempt.
  it('suppresses a verdict already overridden in THIS attempt, but not a prior one', () => {
    const receipts = [
      { kind: 'sensor-override', attempt: 2, detail: { sensorIds: ['claim-sources'] } },
    ];
    expect(
      sensorGateFindings({
        sensorVerdicts: [verdict({ severity: 'blocking' })],
        receipts,
        attempt: 2,
      }),
    ).toEqual([]);
    // A rewind bumped the attempt: the prior override is out of scope and the
    // verdict is presented again.
    expect(
      sensorGateFindings({
        sensorVerdicts: [verdict({ severity: 'blocking' })],
        receipts,
        attempt: 3,
      }),
    ).toHaveLength(1);
  });
});
