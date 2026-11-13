import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import {
  NATIVE_ENGINE_PROFILE,
  encodeNativeEngineFiles,
  nativeEngineFileDigest,
} from '../../shared/native-workflow-protocol.js';
import { nativeEngineCompletionEvidence } from '../workflow-engine/evidence.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const ARTIFACT = 'aidlc/spaces/default/intents/work/inception/requirements.md';
const CONTENTS = {
  [ARTIFACT]: '# Requirements\n',
  'src/game.js': 'export const score = 0;\n',
  'src/hud.js': 'export const hud = "score";\n',
  'test/game.test.js': 'import "../src/game.js";\n',
};
const encode = (contents) =>
  encodeNativeEngineFiles(
    Object.entries(contents).map(([path, text]) => ({ path, content: Buffer.from(text) })),
  ).map(({ content: _content, ...file }) => file);
const under = (files, path) =>
  files.filter((file) => file.path === path || file.path.startsWith(`${path}/`));
const authored = (files) => files.filter((file) => !file.path.startsWith('aidlc/'));
const published = (files) =>
  files.map((file, index) => ({
    id: `file-${index}`,
    role: 'code',
    mediaType: 'text/plain',
    ...file,
  }));
const stage = (id, phase, action, state) => ({
  id,
  phase,
  action,
  state,
  review: { role: null, class: 'none' },
  sensors: [],
});

// One consistent finished workflow as the protected engine would have recorded
// it: directives, audit receipts, isolated invocations, applied decisions, the
// amended plan and a terminal result bound to the published bytes. Each case
// removes or changes exactly the fact it is about.
const scenario = () => {
  const files = encode(CONTENTS);
  const identity = {
    projectId: 'project-one',
    executionId: uuid(1),
    bindingId: uuid(2),
    attemptId: uuid(3),
    epoch: 2,
    writerGeneration: 1,
    sequence: 6,
    configurationSha256: sha('configuration'),
  };
  const row = {
    configuration: {
      packageId: NATIVE_ENGINE_PROFILE.packageId,
      harness: 'codex',
      inputs: { bucket: 'native-inputs', revision: 1, files: [{ path: 'brief.md' }] },
      repository: { commit: 'c'.repeat(40) },
      workflowEngine: {
        profileId: NATIVE_ENGINE_PROFILE.id,
        producerSha256: sha('producer image'),
        functionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-workflow',
        version: '7',
      },
    },
  };
  const state = {
    requirements: [],
    observations: [],
    decisions: [],
    terminalResult: null,
    sourceSettings: null,
  };
  const audit = [];
  const reviews = [];
  let counter = 0;
  const record = (event, fields = {}) => {
    const item = {
      event,
      sha256: sha(`audit ${audit.length} ${event}`),
      stage: null,
      unit: null,
      sensor: null,
      fireId: null,
      outputPath: null,
      note: null,
      reviewer: null,
      verdict: null,
      requestId: null,
      ...fields,
    };
    audit.push(item);
    return item;
  };
  const directive = (stageId, unit, { gate = false, reviewer = null, reviewClass, sensors }) => {
    const requirement = {
      stage: stageId,
      unit,
      gate,
      reviewer,
      reviewClass: reviewClass ?? 'none',
      sensors: sensors ?? [],
      directiveSha256: sha(`directive ${stageId} ${unit} ${state.requirements.length}`),
      filesSha256: nativeEngineFileDigest(files),
    };
    state.requirements.push(requirement);
    return requirement;
  };
  const check = (stageId, unit, sensor, checkedPath, event = 'SENSOR_PASSED') => {
    const fireId = sha(`fire ${++counter}`).slice(0, 8);
    const receipt = record(event, {
      stage: stageId,
      unit,
      sensor,
      fireId,
      outputPath: checkedPath,
    });
    const observation = {
      kind: 'check',
      invocation: 'protected-engine',
      stage: stageId,
      unit,
      sensor,
      fireId,
      outputPath: checkedPath,
      checkedPath,
      checkedSha256: nativeEngineFileDigest(under(files, checkedPath)),
      sourceSha256: ['linter', 'type-check'].includes(sensor)
        ? nativeEngineFileDigest(authored(files))
        : null,
      filesSha256: nativeEngineFileDigest(files),
      auditSha256: receipt.sha256,
    };
    state.observations.push(observation);
    return { receipt, observation };
  };
  const review = (stageId, unit, reviewer, verdict = 'READY') => {
    const requestId = uuid(100 + ++counter);
    const receipt = record('REVIEW_COMPLETED', {
      stage: stageId,
      unit,
      reviewer,
      verdict,
      requestId,
    });
    const observation = {
      kind: 'review',
      invocation: 'isolated-reviewer',
      buildId: `native-review:${requestId}`,
      filesSha256: nativeEngineFileDigest(files),
      requestId,
      stage: stageId,
      unit,
      reviewer,
      verdict,
      reviewSha256: sha(`review ${requestId}`),
      auditSha256: receipt.sha256,
    };
    state.observations.push(observation);
    let freshness = reviews.find((item) => item.stage === stageId);
    if (!freshness) {
      freshness = {
        stage: stageId,
        verdict: unit ? null : verdict,
        stale: false,
        units: [],
        pending: false,
        invalid: false,
        acceptedChanges: [],
      };
      reviews.push(freshness);
    }
    if (unit) freshness.units.push({ unit, verdict, stale: false });
    return { receipt, observation, freshness };
  };
  const approve = (stageId, unit) => {
    const receipt = record('GATE_APPROVED', { stage: stageId, unit });
    const n = ++counter;
    const decision = {
      commandId: uuid(200 + n),
      interactionId: sha(`interaction ${n}`),
      contentSha256: sha(`content ${n}`),
      // The member's words stay with the RESPONSE owner, not the evidence.
      text: 'Approve',
      textSha256: sha('Approve'),
      actorId: 'member-one',
      sequence: n,
      writerGeneration: 1,
      stage: stageId,
      unit,
      presentationSha256: sha(`presentation ${n}`),
      selectedCommand: ['engine', 'orchestrate', 'next'],
      application: 'applied',
      effect: 'GATE_APPROVED',
      auditSha256: receipt.sha256,
    };
    state.decisions.push(decision);
    return { receipt, decision };
  };
  const requirementsAnalysis = {
    requirement: directive('requirements-analysis', null, {
      gate: true,
      reviewer: 'product-reviewer',
      reviewClass: 'advisory',
      sensors: ['required-sections'],
    }),
    sections: check('requirements-analysis', null, 'required-sections', ARTIFACT),
    review: review('requirements-analysis', null, 'product-reviewer'),
    gate: approve('requirements-analysis', null),
  };
  const codeGeneration = {
    requirement: directive('code-generation', 'game', {
      gate: true,
      reviewer: 'code-reviewer',
      reviewClass: 'adversarial',
      sensors: ['linter', 'type-check'],
    }),
    linter: check('code-generation', 'game', 'linter', 'src'),
    typeCheck: check('code-generation', 'game', 'type-check', 'src'),
    review: review('code-generation', 'game', 'code-reviewer'),
    gate: approve('code-generation', 'game'),
  };
  const buildAndTest = {
    requirement: directive('build-and-test', null, { sensors: ['unit-tests'] }),
    tests: check('build-and-test', null, 'unit-tests', 'test'),
  };
  const observed = {
    status: 'recorded',
    workflow: {
      status: 'Completed',
      currentStage: 'build-and-test',
      stateSha256: sha('workflow state'),
    },
    effectivePlan: {
      scope: 'feature',
      name: 'standard',
      stages: [
        stage('workspace-detection', 'initialization', 'EXECUTE', 'completed'),
        stage('requirements-analysis', 'inception', 'EXECUTE', 'completed'),
        stage('user-stories', 'inception', 'SKIP', 'pending'),
        stage('code-generation', 'construction', 'EXECUTE', 'completed'),
        stage('build-and-test', 'construction', 'EXECUTE', 'completed'),
      ],
      ceremony: 'standard',
    },
    audit,
    reviews,
  };
  const terminal = record('WORKFLOW_COMPLETED');
  state.terminalResult = {
    auditSha256: terminal.sha256,
    stateSha256: observed.workflow.stateSha256,
    filesSha256: nativeEngineFileDigest(files),
  };
  const s = {
    identity,
    row,
    state,
    observed,
    audit,
    files,
    terminal,
    publication: {
      id: sha('publication'),
      sequence: identity.sequence,
      manifest: { versionId: 'immutable-1', sha256: sha('manifest'), bytes: 512 },
    },
    manifest: {
      sequence: identity.sequence,
      packageId: row.configuration.packageId,
      files: published(files),
    },
    requirementsAnalysis,
    codeGeneration,
    buildAndTest,
    directive,
    check,
    review,
    approve,
    record,
    remove: (event) => audit.splice(audit.indexOf(event), 1),
    forget: (observation) => state.observations.splice(state.observations.indexOf(observation), 1),
    // The workflow failed at its terminal guard instead of completing.
    fail: () => {
      terminal.event = 'WORKFLOW_FAILED';
      observed.workflow.status = 'Failed';
    },
    // The turn stopped before the engine reached a terminal outcome.
    stop: () => {
      s.remove(terminal);
      state.terminalResult = null;
      observed.workflow.status = 'In Progress';
    },
    evidence: () =>
      nativeEngineCompletionEvidence({
        identity: s.identity,
        row: s.row,
        publication: s.publication,
        manifest: s.manifest,
        workspace: { state: s.state, files: s.files },
        observed: s.observed,
      }),
  };
  return s;
};
const projected = (mutate = () => {}) => {
  const s = scenario();
  mutate(s);
  return s.evidence();
};
const INCOMPLETE = { workflowCompletion: 'not_verified', reason: 'required_evidence_incomplete' };
const CHANGED = { workflowCompletion: 'not_verified', reason: 'result_files_changed' };
const check = (evidence, stageId, sensor, unit = null) =>
  evidence.checks.find(
    (item) => item.stage === stageId && item.sensor === sensor && item.unit === unit,
  );
const entry = (items, stageId, unit = null) =>
  items.find((item) => item.stage === stageId && item.unit === unit);

describe('a terminal outcome is reported only from protected engine evidence', () => {
  it('reports complete when the plan, checks, reviews, gates and terminal result all bind the published files', () => {
    const s = scenario();
    const evidence = s.evidence();
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      workflowCompletion: 'complete',
      reason: 'protected_engine_completed',
      requiredChecks: 'passed',
      finalReview: 'ready',
      humanApproval: 'applied',
      policy: 'pinned_workflow',
      policyStatus: 'protected_engine',
      requirementsStatus: 'captured',
      terminalOutcome: {
        event: 'WORKFLOW_COMPLETED',
        auditSha256: s.terminal.sha256,
        status: 'Completed',
        stateSha256: s.observed.workflow.stateSha256,
      },
    });
    expect(
      evidence.checks.map((item) => [item.stage, item.unit, item.sensor, item.status]),
    ).toEqual([
      ['requirements-analysis', null, 'required-sections', 'passed'],
      ['code-generation', 'game', 'linter', 'passed'],
      ['code-generation', 'game', 'type-check', 'passed'],
      ['build-and-test', null, 'unit-tests', 'passed'],
    ]);
    expect(check(evidence, 'code-generation', 'linter', 'game')).toEqual({
      stage: 'code-generation',
      unit: 'game',
      sensor: 'linter',
      status: 'passed',
      fireId: s.codeGeneration.linter.receipt.fireId,
      auditSha256: s.codeGeneration.linter.receipt.sha256,
      inspectedFilesSha256: nativeEngineFileDigest(s.files),
      checkedPath: 'src',
      checkedSha256: nativeEngineFileDigest(under(s.files, 'src')),
      sourceSha256: nativeEngineFileDigest(authored(s.files)),
      buildId: null,
      note: null,
    });
    expect(evidence.reviews).toEqual([
      {
        stage: 'requirements-analysis',
        unit: null,
        reviewer: 'product-reviewer',
        class: 'advisory',
        status: 'ready',
        verdict: 'READY',
        requestId: s.requirementsAnalysis.review.receipt.requestId,
        auditSha256: s.requirementsAnalysis.review.receipt.sha256,
        buildId: s.requirementsAnalysis.review.observation.buildId,
        inspectedFilesSha256: nativeEngineFileDigest(s.files),
        reviewSha256: s.requirementsAnalysis.review.observation.reviewSha256,
        acceptedChanges: [],
      },
      expect.objectContaining({
        stage: 'code-generation',
        unit: 'game',
        reviewer: 'code-reviewer',
        class: 'adversarial',
        status: 'ready',
      }),
    ]);
    expect(evidence.gates).toEqual([
      {
        stage: 'requirements-analysis',
        unit: null,
        status: 'applied',
        commandId: s.requirementsAnalysis.gate.decision.commandId,
        auditSha256: s.requirementsAnalysis.gate.receipt.sha256,
      },
      {
        stage: 'code-generation',
        unit: 'game',
        status: 'applied',
        commandId: s.codeGeneration.gate.decision.commandId,
        auditSha256: s.codeGeneration.gate.receipt.sha256,
      },
    ]);
  });

  it('binds the evidence to its execution, publication, configuration, inputs, source and producer', () => {
    const s = scenario();
    const evidence = s.evidence();
    expect(evidence).toMatchObject({
      identity: s.identity,
      publicationId: s.publication.id,
      publicationSequence: 6,
      publicationManifestSha256: s.publication.manifest.sha256,
      filesSha256: nativeEngineFileDigest(s.manifest.files),
      configurationSha256: s.identity.configurationSha256,
      packageId: NATIVE_ENGINE_PROFILE.packageId,
      harness: 'codex',
      sourceCommit: 'c'.repeat(40),
      inputsSha256: sha(canonicalJson(s.row.configuration.inputs)),
      producer: {
        profileId: NATIVE_ENGINE_PROFILE.id,
        imageSha256: s.row.configuration.workflowEngine.producerSha256,
        functionVersion: '7',
      },
    });
    expect(evidence.producer).toEqual({
      profileId: 'aidlc-2.11.1-native-1',
      imageSha256: sha('producer image'),
      functionVersion: '7',
    });
    expect(evidence.effectivePlan).toEqual({
      ...s.observed.effectivePlan,
      sha256: sha(canonicalJson(s.observed.effectivePlan)),
    });
    // A different input snapshot is different evidence for the same files.
    s.row.configuration.inputs.revision = 2;
    expect(s.evidence().inputsSha256).not.toBe(evidence.inputsSha256);
  });

  it('records the applied engine decisions without the member text or the selected command', () => {
    const s = scenario();
    const evidence = s.evidence();
    const { decision, receipt } = s.requirementsAnalysis.gate;
    expect(evidence.engineApplication).toHaveLength(2);
    expect(evidence.engineApplication[0]).toEqual({
      commandId: decision.commandId,
      interactionId: decision.interactionId,
      contentSha256: decision.contentSha256,
      textSha256: decision.textSha256,
      actorId: 'member-one',
      sequence: decision.sequence,
      stage: 'requirements-analysis',
      unit: null,
      presentationSha256: decision.presentationSha256,
      application: 'applied',
      effect: 'GATE_APPROVED',
      auditSha256: receipt.sha256,
    });
  });

  it('reports failed from the engine terminal failure bound to the published files', () => {
    const s = scenario();
    s.fail();
    expect(s.evidence()).toMatchObject({
      workflowCompletion: 'failed',
      reason: 'protected_engine_failed',
      terminalOutcome: {
        event: 'WORKFLOW_FAILED',
        auditSha256: s.terminal.sha256,
        status: 'Failed',
      },
    });
  });

  it('reports a bound terminal failure part-way through the plan, where later evidence cannot exist', () => {
    const evidence = projected((s) => {
      s.fail();
      s.observed.effectivePlan.stages.at(-1).state = 'in-progress';
      s.remove(s.buildAndTest.tests.receipt);
      s.forget(s.buildAndTest.tests.observation);
    });
    expect(evidence).toMatchObject({
      workflowCompletion: 'failed',
      reason: 'protected_engine_failed',
      requiredChecks: 'incomplete',
    });
  });

  it.each([
    ['the terminal audit event says failed but the engine state does not', 'Completed'],
    ['the terminal audit event says failed while the workflow is still active', 'In Progress'],
  ])('does not report failed when %s', (_name, status) => {
    const evidence = projected((s) => {
      s.fail();
      s.observed.workflow.status = status;
    });
    expect(evidence).toMatchObject({
      workflowCompletion: 'not_verified',
      reason: 'workflow_not_terminal',
    });
  });
});

describe('a stopped turn or an accepted selection is not a workflow outcome', () => {
  it('stays not verified without a terminal event even when every check, review and gate so far is applied', () => {
    const evidence = projected((s) => s.stop());
    expect(evidence).toMatchObject({
      workflowCompletion: 'not_verified',
      reason: 'workflow_not_terminal',
      requiredChecks: 'passed',
      finalReview: 'ready',
      humanApproval: 'applied',
      terminalOutcome: null,
    });
    expect(evidence.gates.map((gate) => gate.status)).toEqual(['applied', 'applied']);
  });

  it('stays not verified for a turn that stopped while a planned stage is still open', () => {
    const evidence = projected((s) => {
      s.stop();
      s.observed.effectivePlan.stages.at(-1).state = 'in-progress';
    });
    // Missing evidence is named before the missing terminal event.
    expect(evidence).toMatchObject({ ...INCOMPLETE, terminalOutcome: null });
  });

  it.each([
    [
      'the state file says Completed but no terminal audit event exists',
      (s) => {
        s.stop();
        s.observed.workflow.status = 'Completed';
      },
    ],
    [
      'a completion audit event exists but the engine state is still active',
      (s) => {
        s.observed.workflow.status = 'In Progress';
      },
    ],
  ])('does not report complete when %s', (_name, mutate) => {
    expect(projected(mutate)).toMatchObject({
      workflowCompletion: 'not_verified',
      reason: 'workflow_not_terminal',
    });
  });

  it('keeps an accepted member selection pending until the engine applies it', () => {
    const s = scenario();
    s.stop();
    // The member answered the presented gate; the engine has not run since.
    s.remove(s.codeGeneration.gate.receipt);
    const { decision } = s.codeGeneration.gate;
    Object.assign(decision, { application: 'pending' });
    delete decision.effect;
    delete decision.auditSha256;
    const evidence = s.evidence();
    expect(evidence).toMatchObject({ ...INCOMPLETE, humanApproval: 'incomplete' });
    expect(entry(evidence.gates, 'code-generation', 'game')).toEqual({
      stage: 'code-generation',
      unit: 'game',
      status: 'not_recorded',
      commandId: null,
      auditSha256: null,
    });
    expect(evidence.engineApplication.at(-1)).toMatchObject({
      commandId: decision.commandId,
      application: 'pending',
      effect: null,
      auditSha256: null,
    });
  });

  it('never completes on a pending selection, even beside a gate event and a completion event', () => {
    const s = scenario();
    Object.assign(s.codeGeneration.gate.decision, { application: 'pending' });
    const evidence = s.evidence();
    expect(evidence).toMatchObject({ ...INCOMPLETE, humanApproval: 'incomplete' });
    expect(entry(evidence.gates, 'code-generation', 'game').status).toBe('not_recorded');
  });
});

describe('a terminal outcome never carries over to changed result bytes', () => {
  const changes = [
    [
      'the publication carries different bytes than the engine inspected',
      (s) => {
        s.manifest.files = published(encode({ ...CONTENTS, 'src/game.js': 'tampered();\n' }));
      },
    ],
    [
      'the publication carries an additional file',
      (s) => {
        s.manifest.files = published(encode({ ...CONTENTS, 'src/extra.js': 'extra();\n' }));
      },
    ],
    [
      'the publication omits a file',
      (s) => {
        s.manifest.files = s.manifest.files.slice(1);
      },
    ],
    [
      'the workspace and its publication both changed after the terminal result',
      (s) => {
        s.files = encode({ ...CONTENTS, 'src/game.js': 'export const score = 1;\n' });
        s.manifest.files = published(s.files);
      },
    ],
    [
      'the terminal result names another audit event',
      (s) => {
        s.state.terminalResult.auditSha256 = sha('another terminal event');
      },
    ],
    [
      'the engine state changed after the terminal result',
      (s) => {
        s.observed.workflow.stateSha256 = sha('edited workflow state');
      },
    ],
    [
      'no terminal result was recorded for the terminal event',
      (s) => {
        s.state.terminalResult = null;
      },
    ],
  ];
  it.each(changes)('does not report complete when %s', (_name, mutate) => {
    expect(projected(mutate)).toMatchObject(CHANGED);
  });
  it.each(changes)('does not report failed when %s', (_name, mutate) => {
    const evidence = projected((s) => {
      s.fail();
      mutate(s);
    });
    expect(evidence).toMatchObject(CHANGED);
  });

  it('does not inherit complete in a later publication of changed files', () => {
    const s = scenario();
    expect(s.evidence().workflowCompletion).toBe('complete');
    // The next turn publishes an edit; the engine state and audit are unchanged.
    s.files = encode({ ...CONTENTS, 'src/hud.js': 'export const hud = "lives";\n' });
    s.manifest = { ...s.manifest, sequence: 7, files: published(s.files) };
    s.publication = { ...s.publication, id: sha('later publication'), sequence: 7 };
    s.identity = { ...s.identity, sequence: 7 };
    const later = s.evidence();
    expect(later).toMatchObject({ ...CHANGED, publicationId: sha('later publication') });
    expect(later.filesSha256).toBe(nativeEngineFileDigest(s.files));
    expect(check(later, 'code-generation', 'linter', 'game').status).toBe('stale');
  });

  it('names changed publication bytes even before a terminal event exists', () => {
    const evidence = projected((s) => {
      s.stop();
      s.manifest.files = published(encode({ ...CONTENTS, 'src/game.js': 'tampered();\n' }));
    });
    expect(evidence).toMatchObject({ ...CHANGED, terminalOutcome: null });
  });
});

describe('required checks keep their distinct recorded outcomes', () => {
  const blocking = [
    [
      'not_recorded',
      'no audit event was written for the sensor',
      (s) => s.remove(s.codeGeneration.linter.receipt),
    ],
    [
      'not_recorded',
      'the audit event has no observed isolated invocation',
      (s) => s.forget(s.codeGeneration.linter.observation),
    ],
    [
      'not_recorded',
      'the observed invocation belongs to another fire',
      (s) => {
        s.codeGeneration.linter.observation.fireId = 'ffffffff';
      },
    ],
    [
      'not_recorded',
      'the observed invocation names another audit event',
      (s) => {
        s.codeGeneration.linter.observation.auditSha256 = sha('another event');
      },
    ],
    [
      'not_recorded',
      'the observed invocation ran for another unit',
      (s) => {
        s.codeGeneration.linter.observation.unit = 'hud';
      },
    ],
    [
      'not_recorded',
      'a later pass was written to the audit without an invocation, after an observed failure',
      (s) => {
        s.codeGeneration.linter.receipt.event = 'SENSOR_FAILED';
        s.record('SENSOR_PASSED', {
          stage: 'code-generation',
          unit: 'game',
          sensor: 'linter',
          fireId: 'abcdef01',
          outputPath: 'src',
        });
      },
    ],
    [
      'unavailable',
      'the sensor passed with a note that it could not run',
      (s) => {
        s.codeGeneration.linter.receipt.note = 'linter is not installed';
      },
    ],
    [
      'budget_exceeded',
      'the sensor budget was overridden',
      (s) => {
        s.codeGeneration.linter.receipt.event = 'SENSOR_BUDGET_OVERRIDE';
      },
    ],
    [
      'stale',
      'the inspected output no longer matches the current files',
      (s) => {
        s.codeGeneration.linter.observation.checkedSha256 = nativeEngineFileDigest(
          under(encode({ ...CONTENTS, 'src/game.js': 'export const score = -1;\n' }), 'src'),
        );
      },
    ],
    [
      'stale',
      'the inspected source no longer matches the current authored files',
      (s) => {
        s.codeGeneration.linter.observation.sourceSha256 = nativeEngineFileDigest(
          authored(encode({ ...CONTENTS, 'test/game.test.js': 'earlier();\n' })),
        );
      },
    ],
    [
      'stale',
      'a failed check inspected files that have since changed',
      (s) => {
        s.codeGeneration.linter.receipt.event = 'SENSOR_FAILED';
        s.codeGeneration.linter.observation.checkedSha256 = sha('earlier output');
      },
    ],
  ];
  it.each(blocking)('reports %s and never complete when %s', (status, _name, mutate) => {
    const evidence = projected(mutate);
    expect(check(evidence, 'code-generation', 'linter', 'game').status).toBe(status);
    expect(evidence).toMatchObject({ ...INCOMPLETE, requiredChecks: 'incomplete' });
    // The neighbouring check of the same stage keeps its own outcome.
    expect(check(evidence, 'code-generation', 'type-check', 'game').status).toBe('passed');
  });

  it('keeps the note of an unavailable sensor and the receipt of a failed one', () => {
    const s = scenario();
    s.codeGeneration.linter.receipt.note = 'linter is not installed';
    s.codeGeneration.typeCheck.receipt.event = 'SENSOR_FAILED';
    const evidence = s.evidence();
    expect(check(evidence, 'code-generation', 'linter', 'game')).toMatchObject({
      status: 'unavailable',
      note: 'linter is not installed',
    });
    expect(check(evidence, 'code-generation', 'type-check', 'game')).toMatchObject({
      status: 'failed',
      fireId: s.codeGeneration.typeCheck.receipt.fireId,
      auditSha256: s.codeGeneration.typeCheck.receipt.sha256,
    });
    // A failure is reported ahead of the other incomplete check.
    expect(evidence).toMatchObject({ ...INCOMPLETE, requiredChecks: 'failed' });
  });

  it('reports a failed check as failed required checks', () => {
    const evidence = projected((s) => {
      s.codeGeneration.linter.receipt.event = 'SENSOR_FAILED';
    });
    expect(check(evidence, 'code-generation', 'linter', 'game').status).toBe('failed');
    expect(evidence.requiredChecks).toBe('failed');
    // CURRENT BEHAVIOUR, recorded for an explicit decision: a fresh, observed
    // SENSOR_FAILED is not treated as missing evidence. When the engine's own
    // terminal guard still emitted WORKFLOW_COMPLETED, the projection defers to
    // it and reports the workflow complete beside `requiredChecks: 'failed'`.
    expect(evidence).toMatchObject({
      workflowCompletion: 'complete',
      reason: 'protected_engine_completed',
    });
  });

  it('uses the latest recorded fire of a sensor', () => {
    const s = scenario();
    s.codeGeneration.linter.receipt.event = 'SENSOR_FAILED';
    const rerun = s.check('code-generation', 'game', 'linter', 'src');
    const evidence = s.evidence();
    expect(check(evidence, 'code-generation', 'linter', 'game')).toMatchObject({
      status: 'passed',
      fireId: rerun.receipt.fireId,
    });
    expect(evidence.requiredChecks).toBe('passed');
  });

  it('requires no checks when no directive named a sensor', () => {
    const evidence = projected((s) => {
      for (const requirement of s.state.requirements) requirement.sensors = [];
    });
    expect(evidence).toMatchObject({
      workflowCompletion: 'complete',
      requiredChecks: 'not_required',
      checks: [],
    });
  });
});

describe('required reviews come from an observed isolated reviewer', () => {
  it.each([
    [
      'not_recorded',
      'the verdict was written to the audit without an isolated invocation',
      (s) => s.forget(s.codeGeneration.review.observation),
    ],
    [
      'not_recorded',
      'the isolated invocation answered another request',
      (s) => {
        s.codeGeneration.review.observation.requestId = uuid(999);
      },
    ],
    [
      'not_recorded',
      'the isolated invocation names another audit event',
      (s) => {
        s.codeGeneration.review.observation.auditSha256 = sha('another verdict');
      },
    ],
    ['not_recorded', 'no verdict was recorded', (s) => s.remove(s.codeGeneration.review.receipt)],
    [
      'not_recorded',
      'a later READY was written to the audit without an invocation, after an observed NOT-READY',
      (s) => {
        s.codeGeneration.review.receipt.verdict = 'NOT-READY';
        s.record('REVIEW_COMPLETED', {
          stage: 'code-generation',
          unit: 'game',
          reviewer: 'code-reviewer',
          verdict: 'READY',
          requestId: uuid(998),
        });
      },
    ],
    [
      'not_recorded',
      'the verdict was recorded by another reviewer',
      (s) => {
        s.codeGeneration.review.receipt.reviewer = 'product-reviewer';
      },
    ],
    [
      'stale',
      'the reviewed stage changed afterwards',
      (s) => {
        s.codeGeneration.review.freshness.stale = true;
      },
    ],
    [
      'stale',
      'a newer review is still pending',
      (s) => {
        s.codeGeneration.review.freshness.pending = true;
      },
    ],
    [
      'stale',
      'the recorded verdict is invalid',
      (s) => {
        s.codeGeneration.review.freshness.invalid = true;
      },
    ],
    [
      'stale',
      'the reviewed unit changed afterwards',
      (s) => {
        s.codeGeneration.review.freshness.units[0].stale = true;
      },
    ],
    [
      'stale',
      'the pinned reader reports no receipt for the unit',
      (s) => {
        s.codeGeneration.review.freshness.units = [];
      },
    ],
    [
      'stale',
      'the pinned reader reports no freshness for the stage',
      (s) =>
        s.observed.reviews.splice(s.observed.reviews.indexOf(s.codeGeneration.review.freshness), 1),
    ],
  ])('reports %s and never complete when %s', (status, _name, mutate) => {
    const evidence = projected(mutate);
    expect(entry(evidence.reviews, 'code-generation', 'game').status).toBe(status);
    expect(evidence).toMatchObject({ ...INCOMPLETE, finalReview: 'incomplete' });
    expect(entry(evidence.reviews, 'requirements-analysis').status).toBe('ready');
  });

  it('reports a fresh observed NOT-READY verdict as concerns', () => {
    const evidence = projected((s) => {
      s.codeGeneration.review.receipt.verdict = 'NOT-READY';
    });
    expect(entry(evidence.reviews, 'code-generation', 'game')).toMatchObject({
      status: 'concerns',
      verdict: 'NOT-READY',
    });
    expect(evidence.finalReview).toBe('concerns');
    // CURRENT BEHAVIOUR, recorded for an explicit decision: reviewer concerns
    // are not treated as missing evidence. When the engine's own terminal guard
    // still emitted WORKFLOW_COMPLETED, the projection defers to it and reports
    // the workflow complete beside `finalReview: 'concerns'`.
    expect(evidence).toMatchObject({
      workflowCompletion: 'complete',
      reason: 'protected_engine_completed',
    });
  });

  it('reports incomplete ahead of concerns when another review is missing', () => {
    const evidence = projected((s) => {
      s.codeGeneration.review.receipt.verdict = 'NOT-READY';
      s.forget(s.requirementsAnalysis.review.observation);
    });
    expect(evidence).toMatchObject({ ...INCOMPLETE, finalReview: 'incomplete' });
  });

  it.each([
    [
      'its review class is none',
      (s) => {
        s.codeGeneration.requirement.reviewClass = 'none';
      },
    ],
    [
      'it names no reviewer',
      (s) => {
        s.codeGeneration.requirement.reviewer = null;
      },
    ],
  ])('needs no review for a directive when %s', (_name, mutate) => {
    const evidence = projected((s) => {
      mutate(s);
      s.remove(s.codeGeneration.review.receipt);
      s.forget(s.codeGeneration.review.observation);
      s.observed.reviews.pop();
    });
    expect(evidence.reviews.map((review) => review.stage)).toEqual(['requirements-analysis']);
    expect(evidence).toMatchObject({ workflowCompletion: 'complete', finalReview: 'ready' });
  });

  it('requires no review when no directive named a reviewer', () => {
    const evidence = projected((s) => {
      for (const requirement of s.state.requirements) requirement.reviewer = null;
    });
    expect(evidence).toMatchObject({
      workflowCompletion: 'complete',
      finalReview: 'not_required',
      reviews: [],
    });
  });
});

describe('a required human gate needs the engine event and its applied decision', () => {
  it.each([
    [
      'the engine recorded no gate approval',
      (s) => s.remove(s.codeGeneration.gate.receipt),
      { commandId: null, auditSha256: null },
    ],
    [
      'no member decision was applied for the approval event',
      (s) => s.state.decisions.splice(s.state.decisions.indexOf(s.codeGeneration.gate.decision), 1),
      { commandId: null },
    ],
    [
      'the applied decision names another audit event',
      (s) => {
        s.codeGeneration.gate.decision.auditSha256 = s.requirementsAnalysis.gate.receipt.sha256;
      },
      { commandId: null },
    ],
    [
      'the applied decision had another effect',
      (s) => {
        s.codeGeneration.gate.decision.effect = 'QUESTION_ANSWERED';
      },
      { commandId: null },
    ],
    [
      'the gate was rejected',
      (s) => {
        s.codeGeneration.gate.receipt.event = 'GATE_REJECTED';
        s.codeGeneration.gate.decision.effect = 'GATE_REJECTED';
      },
      { commandId: null, auditSha256: null },
    ],
    [
      'the approval was recorded for another unit',
      (s) => {
        s.codeGeneration.gate.receipt.unit = 'hud';
      },
      { commandId: null, auditSha256: null },
    ],
    [
      'the approval was recorded for another stage',
      (s) => {
        s.codeGeneration.gate.receipt.stage = 'build-and-test';
      },
      { commandId: null, auditSha256: null },
    ],
  ])('reports not recorded and never complete when %s', (_name, mutate, expected) => {
    const s = scenario();
    mutate(s);
    const evidence = s.evidence();
    expect(entry(evidence.gates, 'code-generation', 'game')).toMatchObject({
      status: 'not_recorded',
      ...expected,
    });
    expect(evidence).toMatchObject({ ...INCOMPLETE, humanApproval: 'incomplete' });
    expect(entry(evidence.gates, 'requirements-analysis').status).toBe('applied');
  });

  it('does not reuse one applied approval for a second gate', () => {
    const s = scenario();
    s.state.decisions.splice(s.state.decisions.indexOf(s.codeGeneration.gate.decision), 1);
    const evidence = s.evidence();
    expect(evidence.gates.map((gate) => [gate.stage, gate.status, gate.commandId])).toEqual([
      ['requirements-analysis', 'applied', s.requirementsAnalysis.gate.decision.commandId],
      ['code-generation', 'not_recorded', null],
    ]);
    expect(evidence.workflowCompletion).toBe('not_verified');
  });

  it('adds no approval when the workflow required no gate', () => {
    const evidence = projected((s) => {
      for (const requirement of s.state.requirements) requirement.gate = false;
    });
    expect(evidence).toMatchObject({
      workflowCompletion: 'complete',
      humanApproval: 'not_required',
      gates: [],
    });
  });
});

describe('applicability follows the effective plan and the issued directives', () => {
  it('does not complete while an executed stage has no recorded directive', () => {
    const evidence = projected((s) => {
      s.observed.effectivePlan.stages.push(
        stage('deployment-execution', 'operation', 'EXECUTE', 'completed'),
      );
    });
    // Nothing recorded is failing; the stage's requirements are simply unknown.
    expect(evidence).toMatchObject({
      ...INCOMPLETE,
      requiredChecks: 'passed',
      finalReview: 'ready',
      humanApproval: 'applied',
    });
  });

  it.each([
    ['an initialization stage', stage('state-init', 'initialization', 'EXECUTE', 'completed')],
    [
      'a stage the engine skipped',
      stage('deployment-execution', 'operation', 'EXECUTE', 'skipped'),
    ],
    ['a stage the plan skips', stage('deployment-execution', 'operation', 'SKIP', 'pending')],
  ])('needs no directive for %s', (_name, added) => {
    const evidence = projected((s) => s.observed.effectivePlan.stages.push(added));
    expect(evidence).toMatchObject({
      workflowCompletion: 'complete',
      reason: 'protected_engine_completed',
    });
  });

  it.each(['pending', 'in-progress'])(
    'does not complete while an executed stage is %s',
    (state) => {
      const evidence = projected((s) => {
        s.observed.effectivePlan.stages.at(-1).state = state;
      });
      expect(evidence).toMatchObject(INCOMPLETE);
    },
  );

  it('does not complete without a captured effective plan', () => {
    const evidence = projected((s) => {
      s.observed.effectivePlan = null;
    });
    expect(evidence).toMatchObject({
      ...INCOMPLETE,
      requirementsStatus: 'unknown',
      effectivePlan: null,
    });
  });

  it('does not complete on a plan without stages', () => {
    const evidence = projected((s) => {
      s.observed.effectivePlan.stages = [];
    });
    expect(evidence).toMatchObject({ ...INCOMPLETE, requirementsStatus: 'captured' });
  });

  it('matches unit-scoped requirements by unit', () => {
    const s = scenario();
    s.directive('code-generation', 'hud', {
      gate: true,
      reviewer: 'code-reviewer',
      reviewClass: 'adversarial',
      sensors: ['linter'],
    });
    const missing = s.evidence();
    // The other unit's and the stage-level records do not satisfy this unit.
    expect(check(missing, 'code-generation', 'linter', 'game').status).toBe('passed');
    expect(check(missing, 'code-generation', 'linter', 'hud').status).toBe('not_recorded');
    expect(entry(missing.reviews, 'code-generation', 'hud').status).toBe('not_recorded');
    expect(entry(missing.gates, 'code-generation', 'hud').status).toBe('not_recorded');
    expect(missing).toMatchObject({
      ...INCOMPLETE,
      requiredChecks: 'incomplete',
      finalReview: 'incomplete',
      humanApproval: 'incomplete',
    });

    s.check('code-generation', null, 'linter', 'src');
    s.approve('code-generation', null);
    expect(check(s.evidence(), 'code-generation', 'linter', 'hud').status).toBe('not_recorded');
    expect(entry(s.evidence().gates, 'code-generation', 'hud').status).toBe('not_recorded');

    const linter = s.check('code-generation', 'hud', 'linter', 'src');
    s.review('code-generation', 'hud', 'code-reviewer');
    const gate = s.approve('code-generation', 'hud');
    const recorded = s.evidence();
    expect(check(recorded, 'code-generation', 'linter', 'hud')).toMatchObject({
      status: 'passed',
      auditSha256: linter.receipt.sha256,
    });
    expect(entry(recorded.reviews, 'code-generation', 'hud').status).toBe('ready');
    expect(entry(recorded.gates, 'code-generation', 'hud')).toMatchObject({
      status: 'applied',
      commandId: gate.decision.commandId,
    });
    expect(recorded).toMatchObject({
      workflowCompletion: 'complete',
      requiredChecks: 'passed',
      finalReview: 'ready',
      humanApproval: 'applied',
    });
  });

  it('applies the latest directive issued for the same stage and unit', () => {
    const s = scenario();
    const reissued = s.directive('build-and-test', null, {
      gate: true,
      sensors: ['unit-tests', 'build'],
    });
    const evidence = s.evidence();
    expect(evidence.requirements).toHaveLength(3);
    expect(entry(evidence.requirements, 'build-and-test')).toEqual(reissued);
    expect(check(evidence, 'build-and-test', 'unit-tests').status).toBe('passed');
    expect(check(evidence, 'build-and-test', 'build').status).toBe('not_recorded');
    expect(entry(evidence.gates, 'build-and-test').status).toBe('not_recorded');
    expect(evidence).toMatchObject(INCOMPLETE);
  });
});
