import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createNativeExecutor } from '../../agentcore/native/executor.js';
import { createNativeExecutionPorts } from '../../agentcore/native/execution-prepare.js';
import { runNativeCommand } from '../../agentcore/native/command-runner.js';
import { createNativePublications } from '../../shared/native-publication.js';
import { createNativeInteractions } from '../../shared/native-interaction.js';
import { createNativeRecoveryCheckpoints } from '../../shared/native-recovery-checkpoint.js';
import { createNativeExecutionFence } from '../../shared/native-execution-fence.js';
import { nativeAnswerText } from '../../shared/native-pending-input.js';
import { createNativeExecutionSupervisor } from '../execution-worker.js';
import { createNativeExecutionDiagnostics } from '../execution-diagnostics.js';
import { createNativeExecutionApi, nativeExecutionView } from '../execution-api.js';
import { executionIdentity } from '../execution-runtime.js';
import { executionFixture } from './execution-fixtures.js';
import { ACTOR } from './fixtures.js';
import { memoryNativeObjects } from './memory-objects.js';

// Real subprocesses, filesystem capture and production runtime/controller/
// authority/publication/checkpoint validators. Only AWS, package initialization
// and model output are inert ports. No CLI or provider is invoked.
it.each([
  { kind: 'complete', turns: 3 },
  { kind: 'form', turns: 3 },
  { kind: 'scope', turns: 3 },
  { kind: 'scope-query-loop', turns: 3 },
  { kind: 'scope-output-silent', turns: 3 },
  { kind: 'scope-output-markup', turns: 3 },
  { kind: 'scope-output-mismatch', turns: 2, code: 'native_execution_output_result' },
  { kind: 'scope-credential', turns: 2, code: 'native_execution_output_credential' },
  { kind: 'scope-cross-credential', turns: 2, code: 'native_execution_output_credential' },
  { kind: 'scope-capture-cwd', turns: 2, code: 'native_recovery_session_cwd_invalid' },
  { kind: 'scope-capture-id', turns: 2, code: 'native_recovery_session_id_mismatch' },
  { kind: 'form-invalid', turns: 3 },
  { kind: 'form-invalid-match', turns: 3 },
  { kind: 'form-absent', turns: 3, degraded: 'absent' },
  { kind: 'form-oversized', turns: 3, degraded: 'too_large' },
  { kind: 'form-schema', turns: 3, degraded: 'invalid_schema' },
  { kind: 'form-unsupported', turns: 3, degraded: 'unsupported_ask' },
  { kind: 'upload-publication', turns: 2, code: 'native_execution_failed' },
  { kind: 'upload-interaction', turns: 2, code: 'native_execution_failed' },
  { kind: 'upload-checkpoint', turns: 2, code: 'native_execution_failed' },
  { kind: 'admission-ack', turns: 3 },
  { kind: 'form-capture', turns: 2, code: 'native_recovery_home_path_invalid' },
  { kind: 'capture', turns: 2, code: 'native_recovery_home_path_invalid' },
  { kind: 'snapshot', turns: 3, code: 'native_snapshot_link' },
  { kind: 'cancel', turns: 2 },
  { kind: 'capture', turns: 2, code: 'native_recovery_home_path_invalid', unconfirmed: true },
])('Claude checkpoint journey: %j', async (scenario) => {
  const f = executionFixture({ harness: 'claude', model: 'fixture-sonnet' });
  await f.start();
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-checkpoint-journey-')));
  const root = join(base, 'mount');
  const homeRoot = join(base, 'homes');
  await fs.mkdir(root, { mode: 0o700 });
  const nativeSessionId = randomUUID();
  const script = join(base, 'inert-claude.mjs');
  await fs.writeFile(
    script,
    `
    import * as fs from 'node:fs/promises';
    import {join,dirname} from 'node:path';
    const id=process.argv[2],turn=Number(process.argv[3]),kind=process.argv[4];
    const scope=kind.startsWith('scope');
    const form=kind.startsWith('form') || scope;
    let prompt=''; for await(const bytes of process.stdin) prompt+=bytes.toString();
    const file=join(process.env.HOME,'.claude','projects','project-key',id+'.jsonl');
    if(turn===1) {
      await fs.mkdir(dirname(file),{recursive:true,mode:0o700});
      await fs.writeFile(file,JSON.stringify({type:'user',sessionId:id,cwd:process.cwd()})+'\\n',{mode:0o600});
    } else {
      const rows=(await fs.readFile(file,'utf8')).trim().split('\\n').map(JSON.parse);
      if(rows[0].sessionId!==id || rows[0].cwd!==process.cwd() ||
         rows.filter(x=>x.type==='fixture_turn').length!==turn-1) throw Error('session history changed');
      const expected=form
        ? turn===2 ? scope ? 'classic' : '1. Q1: Small\\n2. Q2: Small, Large\\n3. Q3: Small\\n4. Q4: Small\\n5. Q5: Small\\n6. Constraints: Must work offline.' : ['form-invalid','form-absent','form-oversized','form-schema','form-unsupported'].includes(kind) ? 'answer-2' : 'Looks correct'
        : 'answer-'+(turn-1);
      if(prompt!==expected) throw Error('answer changed or replayed');
      // Layout and shape observed in pinned Claude 2.1.257 persistAgentMetadata.
      const agent=join(file.slice(0,-6),'subagents','agent-child');
      await fs.mkdir(dirname(agent),{recursive:true,mode:0o700});
      await fs.writeFile(agent+'.jsonl',JSON.stringify({type:'assistant',agentId:'child'})+'\\n',{mode:0o600});
      await fs.writeFile(agent+'.meta.json',JSON.stringify({agentType:'Explore',toolUseId:'fixture-tool'}),{mode:0o600});
    }
    if(scope && turn===2) {
      await fs.mkdir('nested',{mode:0o700});
      await fs.appendFile(file,JSON.stringify({type:'user',sessionId:kind==='scope-capture-id'?'foreign-session':id,
        cwd:kind==='scope-capture-cwd'?process.cwd()+'-other':join(process.cwd(),'nested')})+'\\n');
    }
    await fs.appendFile(file,JSON.stringify({type:'fixture_turn',turn})+'\\n');
    await fs.writeFile('work.txt','saved turn '+turn+'\\n',{mode:0o600});
    if(kind.includes('capture') && !scope && turn===2)
      await fs.writeFile(join(file.slice(0,-6),'unknown.sqlite'),'unsupported session layout',{mode:0o600});
    if(kind==='snapshot' && turn===3) await fs.symlink('work.txt','unsafe-link');
    let result='Question '+turn+'?';
    if(form) {
      if(turn===1 && (!prompt.includes('together in one form') ||
        !prompt.includes('--on-instruction where supported'))) throw Error('native question mode missing');
      const dir='aidlc/spaces/default/intents/fixture';
      await fs.mkdir(dir,{recursive:true});
      await fs.writeFile('aidlc/active-space','default\\n');
      await fs.writeFile('aidlc/spaces/default/intents/active-intent','fixture\\n');
      await fs.writeFile(dir+'/aidlc-state.md','- **Current Stage**: requirements-analysis\\n- ['+(turn===3?'?':'-')+'] requirements-analysis — EXECUTE\\n');
      const plans=['compose','bugfix','classic','enterprise','express','feature','infra','mvp','poc','refactor','security-patch','workshop'];
      const questions=turn===1 && scope ? [{prompt:'Choose the plan for this task.',header:'Plan',options:plans.map(label=>({label}))}] : turn===1 ? [
        ...Array.from({length:5},(_,i)=>({prompt:'Current question '+(i+1)+'?',header:'Q'+(i+1),
          multiSelect:i===1,options:[{label:'Small'},{label:'Large'}]})),
        {prompt:'What constraints apply?',header:'Constraints',options:[]},
      ] : turn===2 ? [{
        prompt:'All six answers recorded. Confirm the summary before generation?',header:'Confirm',
        options:[{label:'Looks correct'},{label:'Request changes'}],
      }] : [{
        prompt:'Requirements complete. Proceed?',header:'Approval',
        options:[{label:'Approve'},{label:'Request Changes'}],
      }];
      // The inert protocol fixture exposes every currently available definition,
      // never a future stage or an auto-answered summary/approval.
      result=turn===1 && scope ? '**Plan**\\n\\n'+plans.map(label=>'- **'+label+'**').join('\\n') : questions.map(q=>q.prompt+'\\n'+q.options.map(o=>o.label).join(' / ')).join('\\n');
      await fs.writeFile(dir+'/questions.md',result+'\\n');
      if(kind==='scope-credential' && turn===2) {
        result='**Confirm**\\nLooks correct / Request changes';
        questions[0].prompt='Plan recorded: '+process.env.AWS_BEARER_TOKEN_BEDROCK;
      }
      if(kind==='scope-cross-credential' && turn===2) {
        result='fixture-model-'; questions[0].header='token';
      }
      if(kind==='form-invalid-match' && turn===2) questions[0].options.push({label:'Unpublished choice'});
      const spec = scope && turn===1
        ? {version:3,ask:{kind:'ask',ask_type:'compose-offer',response_route:'next',question:'Choose the plan for this task.',
          compose_command:'aidlc engine orchestrate next compose --request fixture',
          scope_commands:plans.slice(1).map(scope=>({scope,command:'aidlc engine orchestrate next --scope '+scope+' --request fixture'}))}}
        : {version:2,questions};
      if (kind!=='form-absent' || turn!==2)
        await fs.writeFile('.native-control/pending-question.json', turn!==2 ? JSON.stringify(spec) :
          kind==='form-invalid' ? '{broken' : kind==='form-oversized' ? 'x'.repeat(70000) :
          kind==='form-schema' ? JSON.stringify({version:2,questions:[]}) :
          kind==='form-unsupported' ? JSON.stringify({version:3,ask:{kind:'ask',ask_type:'fork'}}) : JSON.stringify(spec));
    }
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
    if(kind==='scope-query-loop' && turn===2) {
      console.log(JSON.stringify({type:'system',subtype:'task_notification',session_id:id}));
      console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:id,result:'Subagent work finished.',stop_reason:'end_turn',terminal_reason:'completed'}));
      console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
    }
    if(kind==='scope-output-markup' && turn===2)
      console.log(JSON.stringify({type:'assistant',session_id:id,parent_tool_use_id:null,
        message:{role:'assistant',content:[{type:'text',text:'<cc-memory filenames="fixture.md">'+result+'</cc-memory>'}]}}));
    if(kind==='scope-output-mismatch' && turn===2)
      console.log(JSON.stringify({type:'assistant',session_id:id,parent_tool_use_id:null,
        message:{role:'assistant',content:[{type:'text',text:'Different current question'}]}}));
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:id,
      result,stop_reason:'end_turn',terminal_reason:'completed'}));
    if(kind==='scope-output-silent' && turn===2) {
      console.log(JSON.stringify({type:'system',subtype:'task_notification',session_id:id}));
      console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
      console.log(JSON.stringify({type:'assistant',session_id:id,parent_tool_use_id:null,
        message:{role:'assistant',content:[{type:'text',text:'No response requested.'}]}}));
      console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:id,
        result:'',stop_reason:'end_turn',terminal_reason:'completed'}));
    }
  `,
  );
  const { s3, objects, writes } = memoryNativeObjects({
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
    before: async (command) => {
      const p = command.input;
      const fault = scenario.kind.slice('upload-'.length);
      if (
        command.constructor.name === 'PutObjectCommand' &&
        turns === 2 &&
        scenario.kind.startsWith('upload-') &&
        ((fault === 'publication' &&
          p.Key.includes('/manifests/') &&
          !p.Key.startsWith('native-recovery/')) ||
          (fault === 'interaction' && p.Key.includes('/interactions/')) ||
          (fault === 'checkpoint' && p.Key.startsWith('native-recovery/')))
      )
        throw new Error('injected upload failure');
    },
  });
  const storage = {
    s3,
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
  };
  const publications = createNativePublications(storage);
  const interactions = createNativeInteractions(storage);
  const checkpoints = createNativeRecoveryCheckpoints(storage);
  const fence = createNativeExecutionFence(storage);
  const row = f.row();
  const env = {
    NATIVE_RUNTIME_MODE: 'isolated',
    NATIVE_EXECUTION_ENABLED: 'true',
    NATIVE_RUNTIME_PROJECT_ID: row.scope.projectId,
    NATIVE_RUNTIME_EXECUTION_ID: row.scope.executionId,
    NATIVE_RUNTIME_BINDING_ID: row.bindingId,
    NATIVE_EXECUTION_ATTEMPT_ID: row.attemptId,
    NATIVE_EXECUTION_RUNTIME_SESSION_ID: row.runtimeSessionId,
    NATIVE_EXECUTION_EPOCH: '1',
    NATIVE_EXECUTION_IMAGE_DIGEST: f.configuration.image.digest,
    NATIVE_PUBLICATION_BUCKET: storage.bucket,
    NATIVE_RUNTIME_ACCOUNT_ID: storage.accountId,
  };
  let turns = 0;
  const publish = f.store.publish;
  let lostAdmissionAck = false;
  const observedStore = { ...f.store };
  if (scenario.kind === 'admission-ack')
    observedStore.publish = async (input) => {
      const result = await publish(input);
      if (turns === 2 && !lostAdmissionAck) {
        lostAdmissionAck = true;
        throw new Error('admission acknowledgement lost');
      }
      return result;
    };
  const clean = {
    exitCode: 0,
    signal: null,
    spawnError: null,
    timedOut: false,
    outputLimitExceeded: false,
    cleanupComplete: true,
    stdout: '',
    stderr: '',
  };
  const commands = [];
  let setupCommands = 0;
  const runtime = createNativeExecutor({
    env,
    root,
    homeRoot,
    ...createNativeExecutionPorts({ env, s3 }),
    inspectMount: async () => ({}),
    inspectInitialization: async () => ({ ok: true }),
    commandRunner: async (input) => {
      if (input.timeoutMs !== null) {
        setupCommands++;
        return clean;
      }
      if (++turns > 1) {
        expect(input.args).toContain('--resume');
        expect(input.args).toContain(nativeSessionId);
      }
      const result = await runNativeCommand({
        ...input,
        command: process.execPath,
        args: [script, nativeSessionId, String(turns), scenario.kind],
      });
      commands.push(result);
      return result;
    },
    prepare: async ({ project }) => {
      const directory = join(root, 'packages', 'fixture');
      const binaryPath = join(directory, 'aidlc');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(binaryPath, 'inert package');
      await fs.writeFile(join(project, 'work.txt'), 'initial\n', { mode: 0o600 });
      await fs.mkdir(join(project, '.claude'), { mode: 0o700 });
      await fs.writeFile(
        join(project, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            SessionEnd: [
              { hooks: [{ type: 'command', command: 'aidlc engine hook session-end' }] },
            ],
          },
        }),
        { mode: 0o600 },
      );
      return {
        package: { directory, binaryPath, version: '2.9.0', packageId: f.configuration.packageId },
        repositoryCommit: 'c'.repeat(40),
        authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'fixture-model-token' },
      };
    },
  });
  const stop = vi.fn(async ({ execution }) => {
    expect((await fence.read(executionIdentity(execution))).state).toBe('CANCELLED');
    // The external stop targets the admitted session. Authority cancellation
    // increments its fence epoch; it does not give the old runtime a new epoch.
    await runtime.cancel(executionIdentity(row));
    await runtime.settle();
    return { confirmed: !scenario.unconfirmed, runtimeSessionId: execution.runtimeSessionId };
  });
  const invocations = [];
  let loseAck = scenario.kind === 'form';
  const diagnostics = [];
  const supervisor = createNativeExecutionSupervisor({
    store: observedStore,
    preparationStore: f.preparationStore,
    now: f.now,
    upgrade: async ({ execution }) => ({ ready: true, target: f.target(execution) }),
    authorize: async () => {},
    credentials: async (execution) => ({
      ok: true,
      ...executionIdentity(execution),
      model: { provider: 'bedrock', value: 'fixture-model-token' },
      git: { username: 'fixture', password: 'fixture-git-token' },
      source: { branch: 'main', commit: 'c'.repeat(40) },
    }),
    invoke: async ({ payload }) => {
      invocations.push(payload);
      const method = {
        'native-start': 'start',
        'native-continue': 'continue',
        'native-status': 'status',
      }[payload.command];
      const report = await runtime[method](payload);
      if (payload.command === 'native-continue' && loseAck) {
        loseAck = false;
        throw new Error('Acknowledgement lost after acceptance');
      }
      return report;
    },
    diagnostics: createNativeExecutionDiagnostics({
      scope: f.identity,
      logger: { info: (line) => diagnostics.push(JSON.parse(line)) },
    }),
    stop,
    publications,
    interactions,
    checkpoints,
    fence,
    project: async () => {},
  });
  const api = createNativeExecutionApi({
    enabled: true,
    store: f.store,
    publications,
    interactions,
    configure: async () => f.configuration,
    enqueue: async () => {},
    authorizeSource: async () => {},
  });
  const recheck = async () => {};
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      try {
        await supervisor(f.identity);
      } catch (error) {
        if (scenario.kind !== 'admission-ack' || error.message !== 'admission acknowledgement lost')
          throw error;
        expect(f.row().status).toBe('AWAITING_USER');
        f.tick();
      }
      await runtime.settle();
      if (['AWAITING_USER', 'FAILED', 'CANCELLED'].includes(f.row().status)) {
        await supervisor(f.identity); // Finish projection; duplicate pointer is harmless.
        return;
      }
    }
    throw new Error(`Journey did not settle: ${f.row().status}`);
  };
  try {
    await settle();
    expect(f.row().status).toBe('AWAITING_USER');
    const first = f.row();
    expect(first.recoveryCheckpoint.sequence).toBe(1);
    expect(setupCommands).toBe(3);
    const progress = await runtime.activity({ ...executionIdentity(row), after: 0 });
    expect(
      progress.events
        .filter((event) => event.kind === 'lifecycle')
        .map((event) => event.display.title),
    ).toEqual(
      expect.arrayContaining([
        'Installing verified workflow package',
        'Saving workflow files',
        'Saving recovery checkpoint',
        'Checkpoint uploaded; awaiting publication verification',
      ]),
    );
    let previous = first;
    let latestAnswer;
    let persistedFailure;
    for (let turn = 2; turn <= scenario.turns; turn++) {
      const question = await api.interaction(f.prepared, recheck);
      const scope = scenario.kind.startsWith('scope');
      const form = question.pendingInput !== null;
      if (!scenario.kind.startsWith('form') && !scope)
        expect(question.messages).toEqual([{ type: 'text', text: `Question ${turn - 1}?` }]);
      if ((scenario.kind === 'form-invalid' || scenario.degraded) && turn === 3) {
        expect(question.presentation).toEqual({
          status: 'degraded',
          reason: scenario.degraded ?? 'invalid_json',
        });
        expect(question.pendingInput).toBeNull();
        expect(f.row().recoveryCheckpoint.sequence).toBe(2);
      }
      const selection = form
        ? {
            answers:
              turn === 2 && scope
                ? [{ selectedOptions: [2] }]
                : turn === 2
                  ? [
                      { selectedOptions: [0] },
                      { selectedOptions: [0, 1] },
                      { selectedOptions: [0] },
                      { selectedOptions: [0] },
                      { selectedOptions: [0] },
                      { selectedOptions: [], freeText: 'Must work offline.' },
                    ]
                  : [{ selectedOptions: [0] }],
          }
        : null;
      if (form) {
        expect(question.pendingInput.questions).toHaveLength(turn === 2 && !scope ? 6 : 1);
        expect(question.pendingInput.schemaVersion).toBe(2);
        expect(question.messages[0].text).not.toContain('How would you like to answer');
      }
      latestAnswer = {
        requestId: randomUUID(),
        interactionId: question.id,
        contentSha256: question.contentSha256,
        text: form ? nativeAnswerText(question.pendingInput, selection) : `answer-${turn - 1}`,
        ...(form ? { selection } : {}),
      };
      if (form) {
        await expect(
          api.respond(
            f.prepared,
            ACTOR,
            {
              ...latestAnswer,
              selection: { answers: selection.answers.slice(1) },
            },
            recheck,
          ),
        ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_INVALID' });
        expect(turns).toBe(turn - 1);
      }
      const answer = await api.respond(f.prepared, ACTOR, latestAnswer, recheck);
      expect(answer.response.deliveryStatus).toBe('pending');
      if (form) {
        expect((await api.respond(f.prepared, ACTOR, latestAnswer, recheck)).response.id).toBe(
          answer.response.id,
        );
        await expect(
          api.respond(
            f.prepared,
            'other-member',
            {
              ...latestAnswer,
              requestId: randomUUID(),
            },
            recheck,
          ),
        ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
      }
      if (loseAck) {
        await expect(supervisor(f.identity)).rejects.toThrow('Acknowledgement lost');
        f.tick();
        await supervisor(f.identity);
      } else await supervisor(f.identity);
      const completed = await runtime.settle();
      expect(setupCommands).toBe(3); // Progress reporting never repeats installation or a model turn.
      expect(completed.timings.packageInstallationStarted).toBeUndefined();
      expect(completed.timings.workspaceBaselineCompleted).toBeTypeOf('number');
      if (completed.status === 'publication_ready') {
        for (const [before, after] of [
          ['workspaceSnapshotStarted', 'workspaceSnapshotCompleted'],
          ['publicationStarted', 'publicationCompleted'],
          ['checkpointCaptureStarted', 'checkpointCaptureCompleted'],
          ['checkpointUploadStarted', 'checkpointUploadCompleted'],
        ])
          expect(completed.timings[after]).toBeGreaterThanOrEqual(completed.timings[before]);
      }
      expect(commands.at(-1)).toMatchObject({ exitCode: 0, cleanupComplete: true });
      if (completed.status === 'failed') {
        persistedFailure = JSON.parse(
          await fs.readFile(join(root, '.native-control', 'first-turn', 'status.json'), 'utf8'),
        );
      }
      if (scenario.kind === 'cancel') await api.cancel(f.prepared, recheck);
      await settle();
      expect(
        invocations.filter((p) => p.command === 'native-continue' && p.sequence === turn),
      ).toHaveLength(1);
      if (scenario.code && turn === scenario.turns) {
        expect(f.row().status).toBe('FAILED');
        expect(f.row().failureCode).toBe(scenario.code);
        expect(nativeExecutionView(f.row()).failureCode).toBe(scenario.code);
        expect([...f.rows.values()].filter((record) => record.type === 'native.failed')).toEqual([
          expect.objectContaining({ summary: expect.stringContaining(scenario.code) }),
        ]);
        expect(persistedFailure).toMatchObject({
          code: scenario.code,
          sequence: turn,
          status: 'failed',
        });
        expect(diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'RUNTIME_TERMINAL', runtimeCode: scenario.code }),
          ]),
        );
        if (['scope-credential', 'scope-cross-credential'].includes(scenario.kind)) {
          expect(persistedFailure.timings.publicationStarted).toBeUndefined();
          expect(JSON.stringify(persistedFailure)).not.toContain('fixture-model-token');
          expect(
            [...objects.values()].some((object) => object.bytes.includes('fixture-model-token')),
          ).toBe(false);
        }
        if (scenario.kind.includes('capture')) {
          expect(persistedFailure.timings.interactionUploadCompleted).toBeTypeOf('number');
          expect(persistedFailure.timings.checkpointCaptureStarted).toBeTypeOf('number');
          expect(persistedFailure.timings.checkpointCaptureCompleted).toBeUndefined();
          expect(persistedFailure.timings.checkpointUploadStarted).toBeUndefined();
          expect(writes.some((key) => key.includes('/interactions/'))).toBe(true);
        }
        if (scenario.kind === 'scope-output-mismatch') {
          expect(persistedFailure.outputDiagnostic).toMatchObject({
            reason: 'result_mismatch',
            recordType: 'result',
          });
          expect(persistedFailure.timings.outputRejected).toBeTypeOf('number');
          expect(persistedFailure.timings.publicationStarted).toBeUndefined();
          expect(persistedFailure.timings.checkpointCaptureStarted).toBeUndefined();
          expect(diagnostics).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                outputDiagnostic: expect.objectContaining({ reason: 'result_mismatch' }),
              }),
            ]),
          );
        }
        if (scenario.kind === 'snapshot') {
          expect(persistedFailure.snapshotDiagnostic).toMatchObject({
            phase: 'final',
            reason: 'symbolic_link',
            pathClass: 'other',
            pathDepth: 1,
          });
          expect(persistedFailure.timings.workspaceBaselineCompleted).toBeTypeOf('number');
          expect(persistedFailure.timings.workspaceSnapshotStarted).toBeTypeOf('number');
          expect(persistedFailure.timings.snapshotRejected).toBeTypeOf('number');
          expect(persistedFailure.timings.publicationStarted).toBeUndefined();
          expect(persistedFailure.timings.checkpointCaptureStarted).toBeUndefined();
          expect(diagnostics).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                snapshotDiagnostic: expect.objectContaining({
                  phase: 'final',
                  reason: 'symbolic_link',
                }),
              }),
            ]),
          );
          expect(JSON.stringify(diagnostics)).not.toContain('unsafe-link');
        }
      } else if (scenario.kind !== 'cancel') {
        expect(f.row().status).toBe('AWAITING_USER');
        expect(f.row().recoveryCheckpoint.sequence).toBe(turn);
        expect(f.row().publication.nativeSessionId).toBe(nativeSessionId);
        previous = f.row();
      }
    }
    const final = f.row();
    expect(turns).toBe(scenario.turns);
    expect(final.attemptId).toBe(first.attemptId);
    expect(final.runtimeSessionId).toBe(first.runtimeSessionId);
    expect(final.writerGeneration).toBe(1);
    if (scenario.code || scenario.kind === 'cancel') {
      expect(final.status).toBe(scenario.kind === 'cancel' ? 'CANCELLED' : 'FAILED');
      expect(final.publication).toEqual(previous.publication);
      expect(final.recoveryCheckpoint).toEqual(previous.recoveryCheckpoint);
      expect(final.interaction).toEqual(previous.interaction);
      expect(final.recovery).toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(1);
      if (scenario.unconfirmed) expect(final.stopConfirmation).toBeUndefined();
      else expect(final.stopConfirmation.runtimeSessionId).toBe(first.runtimeSessionId);
      await expect(
        api.recover(f.prepared, { requestId: randomUUID(), recoveryId: randomUUID() }, recheck),
      ).rejects.toMatchObject({
        code:
          scenario.kind === 'cancel' ? 'NATIVE_EXECUTION_CANCELLED' : 'NATIVE_EXECUTION_CONFLICT',
      });
    }
    // Only admitted bytes remain visible; checkpoint one remains independently readable.
    const firstCheckpoint = await checkpoints.read(
      executionIdentity(first),
      first.recoveryCheckpoint,
      { verifyFiles: true },
    );
    expect(firstCheckpoint.sequence).toBe(1);
    const visible = await api.publication(f.prepared, recheck);
    expect(visible.id).toBe(final.publication.id);
    const saved = visible.files.find((file) => file.path === 'work.txt');
    expect(await api.file(f.prepared, saved.id, recheck)).toMatchObject({
      encoding: 'utf8',
      content: `saved turn ${final.publication.sequence}\n`,
    });
    if (scenario.kind === 'cancel')
      await expect(api.respond(f.prepared, ACTOR, latestAnswer, recheck)).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_CANCELLED',
      });
    else await api.respond(f.prepared, ACTOR, latestAnswer, recheck);
    await supervisor(f.identity);
    expect(turns).toBe(scenario.turns); // Neither duplicate answer nor queue pointer replays work.
    expect(final.publication.sequence).toBe(
      scenario.code || scenario.kind === 'cancel' ? scenario.turns - 1 : scenario.turns,
    );
    if (scenario.kind === 'admission-ack') expect(lostAdmissionAck).toBe(true);
    if (scenario.kind.startsWith('form') && !scenario.code) {
      const finalQuestion = await api.interaction(f.prepared, recheck);
      expect(finalQuestion.pendingInput.kind).toBe('approval');
      expect(finalQuestion.pendingInput.stage).toBe('requirements-analysis');
      expect(finalQuestion.response).toBeNull(); // The human gate remains unanswered.
    }
  } finally {
    if (runtime.isBusy()) await runtime.cancel(executionIdentity(row));
    await runtime.settle();
    await fs.rm(base, { recursive: true, force: true });
  }
});
