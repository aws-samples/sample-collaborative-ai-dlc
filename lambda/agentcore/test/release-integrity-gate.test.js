// The fail-closed release-integrity rule, from the component that PRODUCES the
// verdict (the sensor runner) through the shape the stage result carries
// (`gateSensorVerdicts`) into the shared evaluator both the runner and the
// orchestrator consume.
//
// A pinned sensor script that is missing or fails its digest check was never
// executed, so the stage must not be approvable over it — whatever the sensor's
// authored severity says. The gate-option half of this path is covered by
// v2-orchestrator/test/gate-findings.test.js, which drives the real gate.

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSensorRunner } from '../sensor-runner.js';
import { evaluateGatePreconditions, overridableFindings } from '../../shared/gate-preconditions.js';

const STAGE = Object.freeze({
  stageId: 'application-design',
  stageInstanceId: 'si-1',
  outputArtifacts: [{ artifact: 'application-design' }],
});

const POLICY = Object.freeze({
  sensorsEnabled: true,
  reviewClass: 'adversarial',
  reviewArtifact: null,
  summaryConfirmation: 'none',
  changeControl: null,
  learnings: 'on',
  skeleton: null,
});

// The authored sensor is ADVISORY and fires on the gate plane: its ordinary
// findings never block, which is how an unverifiable pinned check used to reach
// the human as a plain `approve`.
const ADVISORY_GATE_SENSOR = Object.freeze({
  sensorId: 'linter',
  severity: 'advisory',
  fireOn: 'gate',
  runtime: 'bun',
  command: 'bun x.ts',
  matches: '**/*.ts',
  timeoutSeconds: 5,
  scriptRef: { s3Key: 'blocks/scripts/sha256/abc123' },
});

// The real runner on a real workspace, with the block loader rejecting exactly as
// it does for a pinned script whose release closure no longer matches.
const gateVerdicts = async (workspaceDir) => {
  const runner = createSensorRunner({
    graph: null,
    loadBlockScript: async () => {
      throw Object.assign(new Error('release script digest mismatch'), {
        name: 'ReleaseResolverError',
        code: 'release_closure_mismatch',
      });
    },
    workspaceDir,
    spawnFn: () => {
      throw new Error('a sensor that failed its digest check must never be spawned');
    },
  });
  return runner.runStageSensors({
    sensors: [ADVISORY_GATE_SENSOR],
    outputArtifacts: STAGE.outputArtifacts,
    inputArtifacts: [],
    stageId: STAGE.stageId,
    planes: ['gate'],
  });
};

const withWorkspace = async (body) => {
  const ws = await mkdtemp(path.join(tmpdir(), 'release-integrity-'));
  try {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    return await body(ws);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
};

describe('release integrity: sensor runner → stage result → gate findings', () => {
  it('produces a held verdict the evaluator turns into a non-overridable block', async () => {
    await withWorkspace(async (ws) => {
      const verdicts = await gateVerdicts(ws);
      expect(verdicts[0]).toMatchObject({
        sensorId: 'linter',
        severity: 'advisory',
        result: 'BLOCKED',
        held: true,
        plane: 'gate',
        detail: { releaseIntegrityFailure: true, code: 'release_closure_mismatch' },
      });

      const { ok, findings } = evaluateGatePreconditions({
        stage: STAGE,
        policy: POLICY,
        sensorVerdicts: verdicts,
        producedArtifacts: ['application-design'],
      });

      expect(ok).toBe(false);
      expect(findings.map((item) => item.code)).toEqual(['sensor_gate_blocking']);
      expect(findings[0]).toMatchObject({
        severity: 'blocking',
        overridable: false,
        receiptKind: null,
        detail: { sensorId: 'linter', releaseIntegrityFailure: true },
      });
      expect(overridableFindings(findings)).toEqual([]);
    });
  });

  it('keeps the same verdict inert for an unpinned run', async () => {
    await withWorkspace(async (ws) => {
      const verdicts = await gateVerdicts(ws);
      expect(
        evaluateGatePreconditions({ stage: STAGE, policy: null, sensorVerdicts: verdicts }),
      ).toEqual({ ok: true, findings: [] });
    });
  });
});
