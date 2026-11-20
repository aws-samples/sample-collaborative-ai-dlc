import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NATIVE_ENGINE_PROFILE, engineFailure } from '../../shared/native-workflow-protocol.js';
import { buildNativePendingInput, nativeAnswerText } from '../../shared/native-pending-input.js';
import {
  capturedPlanAsk,
  capturedPlanFormSpec,
} from '../../shared/test/fixtures/native-plan-ask.js';
import { setupNativeWorkflowEngine as setup } from './workflow-engine-service-fixture.js';

const gate = () =>
  buildNativePendingInput({
    gate: { stage: 'build' },
    spec: {
      version: 2,
      questions: [
        {
          prompt: 'build complete. How would you like to proceed?',
          options: [{ label: 'Approve' }, { label: 'Request Changes' }],
        },
      ],
    },
  });
const toGate = async (t) => {
  expect(JSON.parse((await t.command([])).result.stdout)).toMatchObject({ kind: 'run-stage' });
  t.project.set('src/app.js', Buffer.from('export const answer = 42;\n'));
  expect((await t.command(['engine', 'sensor', 'fire', '--stage', 'build'])).result.exitCode).toBe(
    0,
  );
  const reported = await t.command([
    'engine',
    'orchestrate',
    'report',
    '--stage',
    'build',
    '--result',
    'awaiting-approval',
  ]);
  expect(reported.result.exitCode).toBe(0);
  return t.publish(gate());
};
const approve = async (t, opened) => {
  await t.admit(opened);
  const selection = { answers: [{ selectedOptions: [0] }] };
  await t.execution.respond({
    ...t.f.bindingIdentity,
    actorId: 'responding-member',
    request: {
      requestId: randomUUID(),
      interactionId: opened.interactionReceipt.id,
      contentSha256: opened.body.contentSha256,
      text: nativeAnswerText(gate(), selection),
      selection,
    },
  });
  const claim = await t.execution.claim(t.f.bindingIdentity);
  await t.execution.release({ row: await t.execution.dispatched({ row: claim.row }) });
};

const stopForWorkspaceRecovery = async (t) => {
  const claimed = await t.execution.claim(t.f.bindingIdentity);
  return t.execution.recoveryRequired({
    row: claimed.row,
    reason: 'DELIVERY_UNCERTAIN',
    workflowResumeState: 'created',
    stoppedSessionId: claimed.row.runtimeSessionId,
  });
};
const confirmWorkspaceRecovery = async (t, stopped) => {
  await t.execution.recover({
    ...t.f.bindingIdentity,
    request: {
      requestId: randomUUID(),
      recoveryId: stopped.recovery.id,
      confirmWorkspaceResume: true,
    },
  });
  return t.execution.claim(t.f.bindingIdentity);
};
describe('protected workflow engine service', () => {
  it('resumes the open stage only for the confirmed writer and turn, without replaying its lost approval', async () => {
    const t = await setup();
    const opened = await toGate(t);
    // The member submitted an approval, but its delivery became uncertain.
    await approve(t, opened);
    const previous = await t.request('execute', { args: ['next', '--resume'] });
    const stopped = await stopForWorkspaceRecovery(t);
    await expect(t.send(previous)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_WRITER_CHANGED' });
    const replacement = await confirmWorkspaceRecovery(t, stopped);
    await expect(t.request('execute', { args: ['next', '--resume'] })).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_WRITER_CHANGED',
    });
    const restoring = await t.execution.recoveryStopped({ row: replacement.row });
    await expect(t.send(previous)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
    const memberMessages = t.memberMessages();
    const resumed = await t.command(['engine', 'orchestrate', 'next', '--resume']);
    expect(resumed.result.exitCode).toBe(0);
    expect(JSON.parse(resumed.result.stdout)).toMatchObject({ stage: 'build', gate: true });
    expect(t.calls.at(-1)).toEqual(['aidlc-orchestrate.ts', 'next', '--resume']);

    await t.execution.release({ row: await t.execution.recovered({ row: restoring }) });
    expect((await t.command(['next', '--resume'])).result.exitCode).toBe(0);
    expect(t.calls.at(-1)).toEqual(['aidlc-orchestrate.ts', 'next', '--resume']);
    expect(t.memberMessages()).toBe(memberMessages);
    const held = await t.publish(gate());
    expect(await t.proof(held)).toMatchObject({
      humanApproval: 'incomplete',
      workflowCompletion: 'not_verified',
      engineApplication: [],
    });

    await approve(t, held);
    expect((await t.command(['next', '--resume'])).result.failure).toBe(
      'NATIVE_ENGINE_COMMAND_DENIED',
    );
    expect((await t.command(['next'])).result.exitCode).toBe(0);
    expect(await t.proof(await t.publish())).toMatchObject({ humanApproval: 'applied' });
  });
  it.each(['no snapshot', 'intake only'])(
    'cannot restart intake on recovery with %s',
    async (scenario) => {
      const t = await setup();
      if (scenario === 'intake only') {
        t.hooks.orchestrate = () => ({ kind: 'print', message: 'Choose a plan.' });
        await t.command([]);
      }
      const replacement = await confirmWorkspaceRecovery(t, await stopForWorkspaceRecovery(t));
      await t.execution.recoveryStopped({ row: replacement.row });
      const priorCalls = t.calls.length;
      expect((await t.command(['next', '--resume'])).result.failure).toBe(
        'NATIVE_ENGINE_STATE_UNAVAILABLE',
      );
      expect(t.calls).toHaveLength(priorCalls);
      expect(t.memberMessages()).toBe(scenario === 'no snapshot' ? 0 : 1);
    },
  );
  it('reports completion only from applied gates, observed checks and the exact published files', async () => {
    const t = await setup();
    try {
      const opened = await toGate(t);
      // A stopped turn waiting at its own gate is published, never complete.
      const waiting = await t.proof(opened);
      expect(waiting).toMatchObject({
        workflowCompletion: 'not_verified',
        reason: 'required_evidence_incomplete',
        requiredChecks: 'passed',
        humanApproval: 'incomplete',
        terminalOutcome: null,
      });
      expect(waiting.checks).toMatchObject([
        { stage: 'build', sensor: 'unit-tests', status: 'passed', buildId: expect.any(String) },
      ]);
      // The coding process cannot approve its own gate or finish the workflow.
      const forged = await t.command([
        'engine',
        'orchestrate',
        'report',
        '--stage',
        'build',
        '--result',
        'approved',
      ]);
      expect(forged.result).toMatchObject({ exitCode: 1, failure: 'NATIVE_ENGINE_COMMAND_DENIED' });
      // The operation is answered as recorded; what raised it is reported once, beside it.
      expect(t.failures).toEqual([
        { thrown: 'NATIVE_ENGINE_COMMAND_DENIED', code: 'NATIVE_ENGINE_COMMAND_DENIED' },
      ]);

      await approve(t, opened);
      // An accepted selection alone changes nothing until the engine applies it.
      expect((await t.proof(opened)).workflowCompletion).toBe('not_verified');
      const applied = await t.request('execute', { args: ['next'] });
      const before = t.calls.length;
      const first = await t.send(applied);
      expect(JSON.parse(first.result.stdout)).toEqual({ kind: 'done' });
      expect(t.calls.at(-1)).toEqual([
        'aidlc-orchestrate.ts',
        'report',
        '--stage',
        'build',
        '--result',
        'approved',
        '--user-input',
        'Approve',
      ]);
      // A lost acknowledgement is answered from the journal, not by rerunning.
      const ran = t.calls.length;
      expect(ran).toBe(before + 1);
      const replayed = await t.send(applied);
      expect(replayed.response).toEqual(first.response);
      expect(t.calls).toHaveLength(ran);
      await expect(t.send({ ...applied, args: ['engine', 'state', 'get'] })).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
      });

      const completed = await t.publish();
      const evidence = await t.proof(completed);
      expect(evidence).toMatchObject({
        workflowCompletion: 'complete',
        reason: 'protected_engine_completed',
        requiredChecks: 'passed',
        finalReview: 'not_required',
        humanApproval: 'applied',
        publicationId: completed.receipt.id,
        terminalOutcome: { event: 'WORKFLOW_COMPLETED', status: 'Completed' },
      });
      expect(evidence.engineApplication).toMatchObject([
        { actorId: 'responding-member', application: 'applied', effect: 'GATE_APPROVED' },
      ]);
      expect(evidence.gates).toMatchObject([{ stage: 'build', status: 'applied' }]);
      // The earlier revision keeps its own outcome.
      expect((await t.proof(opened)).workflowCompletion).toBe('not_verified');

      // Bytes changed after the terminal outcome never inherit verification.
      t.project.set('src/app.js', Buffer.from('export const answer = 43;\n'));
      const changed = await t.publish();
      expect(await t.proof(changed)).toMatchObject({
        workflowCompletion: 'not_verified',
        reason: 'result_files_changed',
      });
      expect((await t.proof(completed)).workflowCompletion).toBe('complete');

      // Members read the same outcomes through the revision API.
      await t.admit(completed);
      expect(await t.view(completed)).toMatchObject({
        workflowCompletion: 'complete',
        reason: 'protected_engine_completed',
        policy: 'pinned_workflow',
        policyStatus: 'protected_engine',
        requirementsStatus: 'captured',
        requiredChecks: 'passed',
        humanApproval: 'applied',
        effectivePlan: { scope: 'express', stages: [{ id: 'build', state: 'completed' }] },
        engineApplication: [{ application: 'applied', effect: 'GATE_APPROVED' }],
        terminalOutcome: { event: 'WORKFLOW_COMPLETED', status: 'Completed' },
        producer: { profileId: NATIVE_ENGINE_PROFILE.id, functionVersion: t.pin.version },
        filesSha256: evidence.filesSha256,
        checks: [{ sensor: 'unit-tests', status: 'passed' }],
        gates: [{ stage: 'build', status: 'applied' }],
      });
      expect((await t.view(completed, false)).verification).toMatchObject({
        workflowCompletion: 'complete',
        publicationId: completed.receipt.id,
      });
      expect(await t.view(opened)).toMatchObject({
        workflowCompletion: 'not_verified',
        policyStatus: 'protected_engine',
        humanApproval: 'incomplete',
        terminalOutcome: 'not_recorded',
      });
      // Access is still checked for every read.
      t.f.authorization.member = false;
      await expect(t.view(completed)).rejects.toMatchObject({
        code: 'NATIVE_PREPARATION_FORBIDDEN',
      });
    } finally {
      await t.close();
    }
  });

  it('applies a gate only from the answer to a recorded question, never from an approval typed as a written reply', async () => {
    const t = await setup();
    try {
      expect(JSON.parse((await t.command([])).result.stdout)).toMatchObject({ kind: 'run-stage' });
      t.project.set('src/app.js', Buffer.from('export const answer = 42;\n'));
      expect(
        (await t.command(['engine', 'sensor', 'fire', '--stage', 'build'])).result.exitCode,
      ).toBe(0);
      const report = (result, ...rest) => [
        'engine',
        'orchestrate',
        'report',
        '--stage',
        'build',
        '--result',
        result,
        ...rest,
      ];
      expect((await t.command(report('awaiting-approval'))).result.exitCode).toBe(0);
      // The agent ends its turn at the gate in prose: no question was recorded.
      const prose = await t.publish();
      expect(prose.body.pendingInput).toBeUndefined();
      expect((await t.proof(prose)).workflowCompletion).toBe('not_verified');
      await t.admit(prose);
      // The application still accepts a written reply to that turn.
      const accepted = await t.f.api.respond(
        t.f.prepared,
        'responding-member',
        {
          requestId: randomUUID(),
          interactionId: prose.interactionReceipt.id,
          contentSha256: prose.body.contentSha256,
          text: 'Approve',
        },
        t.f.recheck,
      );
      expect(accepted.response).toMatchObject({ kind: 'user_reply', text: 'Approve' });
      const deliver = async () => {
        const claim = await t.execution.claim(t.f.bindingIdentity);
        await t.execution.release({ row: await t.execution.dispatched({ row: claim.row }) });
      };
      await deliver();
      // It names no question the engine recorded, so it approves nothing.
      const typed = await t.command(report('approved', '--user-input', 'Approve'));
      expect(typed.result.exitCode).toBe(1);
      expect(typed.result.failure).toMatch(/^NATIVE_ENGINE_(DECISION_MISMATCH|COMMAND_DENIED)$/);
      expect(t.calls.some((call) => call.includes('approved'))).toBe(false);
      // The refusal is a finished operation: nothing is left pending.
      const status = await t.handler(
        { schemaVersion: 1, identity: await t.identity(), action: 'status' },
        await t.context(),
      );
      expect(status.pending).toBeNull();
      const refused = await t.publish();
      expect(await t.proof(refused)).toMatchObject({
        workflowCompletion: 'not_verified',
        humanApproval: 'incomplete',
        engineApplication: [],
      });

      // Presented again as a question, the same gate is applied from its answer.
      await t.admit(refused);
      await t.execution.respond({
        ...t.f.bindingIdentity,
        actorId: 'responding-member',
        request: {
          requestId: randomUUID(),
          interactionId: refused.interactionReceipt.id,
          contentSha256: refused.body.contentSha256,
          text: 'Show the approval as a question.',
        },
      });
      await deliver();
      const opened = await t.publish(gate());
      expect(opened.finalized.result.exitCode).toBe(0);
      await approve(t, opened);
      expect(JSON.parse((await t.command(['next'])).result.stdout)).toEqual({ kind: 'done' });
      const evidence = await t.proof(await t.publish());
      expect(evidence).toMatchObject({
        workflowCompletion: 'complete',
        humanApproval: 'applied',
        gates: [{ stage: 'build', status: 'applied' }],
      });
      // Only the answer to the recorded question is a member decision.
      expect(evidence.engineApplication).toMatchObject([
        { actorId: 'responding-member', application: 'applied', effect: 'GATE_APPROVED' },
      ]);
    } finally {
      await t.close();
    }
  });

  // NE-24. A reply that names no question the engine recorded carries no
  // member authority. It no longer makes the engine refuse the turn.
  const NOT_APPLIED = 'NATIVE_ENGINE_REPLY_NOT_APPLIED';
  const reply = async (t, produced, text, selection) => {
    const accepted = await t.f.api.respond(
      t.f.prepared,
      'responding-member',
      {
        requestId: randomUUID(),
        interactionId: produced.interactionReceipt.id,
        contentSha256: produced.body.contentSha256,
        text,
        ...(selection ? { selection } : {}),
      },
      t.f.recheck,
    );
    const claim = await t.execution.claim(t.f.bindingIdentity);
    await t.execution.release({ row: await t.execution.dispatched({ row: claim.row }) });
    // The accepted reply as the application shows it, with the command the row names.
    return { ...accepted.response, commandId: (await t.row()).response.commandId };
  };
  const report = (result, ...rest) => [
    'engine',
    'orchestrate',
    'report',
    '--stage',
    'build',
    '--result',
    result,
    ...rest,
  ];

  it('applies the commands that need no member after a reply to a turn without a question, tells the agent why nothing was decided, and completes verified in the same attempt', async () => {
    const t = await setup();
    try {
      expect(JSON.parse((await t.command([])).result.stdout)).toMatchObject({ kind: 'run-stage' });
      t.project.set('src/app.js', Buffer.from('export const answer = 42;\n'));
      // The agent ends its turn with a question in prose: no question file, no form.
      const prose = await t.publish();
      expect(prose.body.pendingInput).toBeUndefined();
      await t.admit(prose);
      const attempt = (await t.row()).attemptId;
      const written = await reply(t, prose, 'Yes, go ahead and approve the build.');
      expect(written).toMatchObject({ kind: 'user_reply', deliveryStatus: 'pending' });
      const spoken = t.memberMessages();
      const before = t.calls.length;

      // Asking for the directive again, running a check and reporting the stage
      // as waiting need no member. They reach the pinned engine and succeed.
      const again = await t.command(['next']);
      expect(again.response.status).toBe('completed');
      expect(again.result.exitCode).toBe(0);
      expect(JSON.parse(again.result.stdout)).toMatchObject({ kind: 'run-stage', stage: 'build' });
      // The agent is told why no decision was taken and what to do instead.
      expect(again.result.stderr.split('\n')[0]).toBe(NOT_APPLIED);
      expect(again.result.stderr).toContain('was not applied as a workflow decision');
      expect(again.result.stderr).toContain('.native-control/pending-question.json');
      expect(again.result.stderr).toContain('run aidlc next to read the current directive again');
      // Nothing of the member's words is repeated to the agent by the engine.
      expect(again.result.stderr).not.toContain('go ahead');
      let applied;
      for (const args of [
        ['engine', 'sensor', 'fire', '--stage', 'build'],
        report('awaiting-approval'),
      ]) {
        applied = await t.command(args);
        expect(applied.response.status).toBe('completed');
        expect(applied.result.exitCode).toBe(0);
        expect(applied.result.stderr.split('\n')[0]).toBe(NOT_APPLIED);
      }
      // Once the stage waits at its gate, the engine names the approval it holds.
      expect(applied.result.stderr).toContain('The engine holds an open approval for stage build.');
      expect(t.calls.length).toBe(before + 3);
      // The reply never reached the pinned engine as a person's words.
      expect(t.memberMessages()).toBe(spoken);
      expect(t.failures).toEqual([]);

      // The revision in between is not verified, decides nothing, and says so.
      const between = await t.publish(gate());
      expect(between.finalized.result.exitCode).toBe(0);
      const unapplied = [
        {
          commandId: written.commandId,
          interactionId: prose.interactionReceipt.id,
          actorId: 'responding-member',
          sequence: 2,
          reason: 'no_recorded_question',
        },
      ];
      expect(await t.proof(between)).toMatchObject({
        workflowCompletion: 'not_verified',
        humanApproval: 'incomplete',
        engineApplication: [],
        unappliedReplies: unapplied,
      });
      // The open question was presented again as a form the engine recorded.
      // Its answer is a decision, and the run completes in the same attempt.
      await approve(t, between);
      // The member reads in that revision's completion report that the written
      // reply was not applied as a decision.
      expect(await t.view(between)).toMatchObject({
        workflowCompletion: 'not_verified',
        engineApplication: [],
        unappliedReplies: unapplied,
      });
      const done = await t.command(['next']);
      expect(JSON.parse(done.result.stdout)).toEqual({ kind: 'done' });
      // A turn that starts with an answer to a recorded question carries no notice.
      expect(done.result.stderr).toBe('');
      const evidence = await t.proof(await t.publish());
      expect(evidence).toMatchObject({
        workflowCompletion: 'complete',
        humanApproval: 'applied',
        gates: [{ stage: 'build', status: 'applied' }],
        unappliedReplies: unapplied,
      });
      expect(evidence.engineApplication).toMatchObject([
        { actorId: 'responding-member', application: 'applied', effect: 'GATE_APPROVED' },
      ]);
      expect((await t.row()).attemptId).toBe(attempt);
    } finally {
      await t.close();
    }
  });

  it('still refuses an answer, an approval and a plan selection after such a reply, with the reason, and implies none of them', async () => {
    const t = await setup();
    try {
      await toGate(t);
      const prose = await t.publish();
      await t.admit(prose);
      await reply(t, prose, 'Approve');
      const spoken = t.memberMessages();
      const before = t.calls.length;
      for (const args of [
        report('approved', '--user-input', 'Approve'),
        report('approved'),
        ['engine', 'log', 'answer', '--stage', 'build', '--details', 'Approve'],
        [
          'engine',
          'intent',
          'create',
          '--scope',
          'express',
          '--request',
          'abcd1234',
          '--label',
          'x',
        ],
      ]) {
        const refused = await t.command(args);
        expect(refused.response.status).toBe('failed');
        expect(refused.result).toMatchObject({
          exitCode: 1,
          stdout: '',
          failure: 'NATIVE_ENGINE_COMMAND_DENIED',
          patches: [],
        });
        // The refusal names its code first, then why the reply decided nothing
        // and which approval the engine holds open.
        expect(refused.result.stderr.split('\n').slice(0, 2)).toEqual([
          'NATIVE_ENGINE_COMMAND_DENIED',
          NOT_APPLIED,
        ]);
        expect(refused.result.stderr).toContain(
          'The engine holds an open approval for stage build.',
        );
      }
      // The pinned engine saw neither a command nor a person's words.
      expect(t.calls.length).toBe(before);
      expect(t.memberMessages()).toBe(spoken);
      const status = await t.handler(
        { schemaVersion: 1, identity: await t.identity(), action: 'status' },
        await t.context(),
      );
      expect(status.pending).toBeNull();
      expect(await t.proof(await t.publish())).toMatchObject({
        workflowCompletion: 'not_verified',
        humanApproval: 'incomplete',
        gates: [{ stage: 'build', status: 'not_recorded' }],
        engineApplication: [],
        unappliedReplies: [{ actorId: 'responding-member', reason: 'no_recorded_question' }],
      });
    } finally {
      await t.close();
    }
  });

  it('records such a reply when the turn runs no workflow command at all', async () => {
    const t = await setup();
    try {
      await toGate(t);
      const prose = await t.publish();
      await t.admit(prose);
      const written = await reply(t, prose, 'Show the approval as a question.');
      // The agent only presents the gate as a form and ends its turn.
      const opened = await t.publish(gate());
      expect(opened.finalized.result.exitCode).toBe(0);
      expect(await t.proof(opened)).toMatchObject({
        workflowCompletion: 'not_verified',
        engineApplication: [],
        unappliedReplies: [{ commandId: written.commandId, sequence: 2 }],
      });
      // The same reply is recorded once, however often the turn is observed.
      await approve(t, opened);
      expect(JSON.parse((await t.command(['next'])).result.stdout)).toEqual({ kind: 'done' });
      const evidence = await t.proof(await t.publish());
      expect(evidence.unappliedReplies).toHaveLength(1);
      expect(evidence.workflowCompletion).toBe('complete');
    } finally {
      await t.close();
    }
  });

  it('treats an answer to a form that was not the engine’s question the same way and hands the agent the question it holds', async () => {
    const t = await setup();
    try {
      // The pinned engine offers a plan before any workflow state exists and
      // repeats that offer whenever it is asked again.
      const offer = capturedPlanAsk;
      t.hooks.orchestrate = (args) =>
        args.includes('--scope') ? null : args[0] === 'next' ? offer : null;
      expect(JSON.parse((await t.command([])).result.stdout)).toEqual(offer);
      // The agent paraphrases the offer. The engine does not record that form.
      const paraphrased = buildNativePendingInput({ spec: capturedPlanFormSpec });
      const shown = await t.publish(paraphrased);
      expect(shown.finalized.result.failure).toBe('NATIVE_ENGINE_PRESENTATION_MISMATCH');
      await t.admit(shown);
      const selection = { answers: [{ selectedOptions: [0] }] };
      const picked = await reply(t, shown, nativeAnswerText(paraphrased, selection), selection);
      const spoken = t.memberMessages();

      // The offer can be read again from the engine.
      const again = await t.command(['next']);
      expect(again.result.exitCode).toBe(0);
      expect(JSON.parse(again.result.stdout)).toEqual(offer);
      expect(again.result.stderr.split('\n')[0]).toBe(NOT_APPLIED);
      // Choosing the plan on the member's behalf stays refused, and the refusal
      // carries the question the engine holds, to be presented unchanged.
      const forged = await t.command([
        'engine',
        'orchestrate',
        'next',
        '--scope',
        'poc',
        '--request',
        '6b26fb88',
      ]);
      expect(forged.result).toMatchObject({ exitCode: 1, failure: 'NATIVE_ENGINE_COMMAND_DENIED' });
      expect(forged.result.stderr).toContain(NOT_APPLIED);
      const lines = forged.result.stderr.split('\n');
      const held = lines.findIndex((line) => line.includes('{"version":3,"ask":<this object>}'));
      expect(JSON.parse(lines[held + 1])).toEqual(offer);
      expect(t.memberMessages()).toBe(spoken);

      // Presented unchanged, the offer is a question the engine records, and
      // the member's selection of it is applied.
      const asked = await t.publish(undefined, { spec: null, reason: 'absent' });
      const form = asked.body.pendingInput;
      expect(form.questions[0].prompt).toBe(offer.question);
      expect(asked.finalized.result.exitCode).toBe(0);
      expect(await t.proof(asked)).toMatchObject({
        workflowCompletion: 'not_verified',
        engineApplication: [],
        unappliedReplies: [{ commandId: picked.commandId, reason: 'no_recorded_question' }],
      });
      await t.admit(asked);
      await reply(t, asked, nativeAnswerText(form, selection), selection);
      const chosen = await t.command(['next']);
      expect(chosen.result.exitCode).toBe(0);
      expect(chosen.result.stderr).toBe('');
      expect(t.calls.at(-1)).toEqual([
        'aidlc-orchestrate.ts',
        'next',
        '--scope',
        'poc',
        '--request',
        '6b26fb88',
      ]);
      expect(t.memberMessages()).toBe(spoken + 1);
      expect((await t.proof(await t.publish())).engineApplication).toMatchObject([
        { application: 'applied', effect: 'PLAN_PROPOSAL_APPLIED' },
      ]);
    } finally {
      await t.close();
    }
  });

  it('keeps refusing a reply whose record does not match the turn it is delivered to', async () => {
    const t = await setup();
    try {
      await toGate(t);
      const prose = await t.publish();
      await t.admit(prose);
      await reply(t, prose, 'Approve');
      // The stored reply no longer has the words the member's digest names.
      t.hooks.response = (value) => ({ ...value, text: 'Approve everything' });
      const refused = await t.command(['next']);
      expect(refused.result).toMatchObject({
        exitCode: 1,
        failure: 'NATIVE_ENGINE_DECISION_MISMATCH',
        stderr: 'NATIVE_ENGINE_DECISION_MISMATCH\n',
      });
      // Nor is it recorded as a reply that merely decided nothing.
      expect((await t.proof(await t.publish())).unappliedReplies).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('refuses an altered plan selection before recording the member or running a command', async () => {
    const t = await setup();
    t.hooks.orchestrate = () => capturedPlanAsk;
    await t.command([]);
    const shown = await t.publish(undefined, { spec: capturedPlanFormSpec });
    await t.admit(shown);
    const selection = { answers: [{ selectedOptions: [0] }] };
    await reply(t, shown, nativeAnswerText(shown.body.pendingInput, selection), selection);
    t.hooks.response = (value) => ({
      ...value,
      selection: { answers: [{ selectedOptions: [2] }] },
    });
    const messages = t.memberMessages();
    const commands = t.calls.length;
    const refused = await t.command(['next']);
    expect(refused.result.failure).toBe('NATIVE_ENGINE_COMMAND_DENIED');
    expect(t.memberMessages()).toBe(messages);
    expect(t.calls).toHaveLength(commands);
  });

  it('does not register the picker in the partial snapshot when saving its evidence fails', async () => {
    const t = await setup();
    t.hooks.orchestrate = () => capturedPlanAsk;
    await t.command([]);
    const write = t.objects.write;
    const store = vi.spyOn(t.objects, 'write').mockImplementation((...args) => {
      if (args[2] === 'evidence') throw engineFailure('NATIVE_ENGINE_UNAVAILABLE');
      return write(...args);
    });
    const shown = await t.publish(undefined, { spec: capturedPlanFormSpec });
    store.mockRestore();
    expect(shown.finalized.result.exitCode).toBe(1);
    // Even if an older runtime admitted the rejected candidate, its answer
    // cannot be consumed as a member decision.
    await t.admit(shown);
    const selection = { answers: [{ selectedOptions: [0] }] };
    await reply(t, shown, nativeAnswerText(shown.body.pendingInput, selection), selection);
    const before = t.memberMessages();
    expect((await t.command(['next'])).result.stderr).toContain(NOT_APPLIED);
    expect(t.memberMessages()).toBe(before);
  });

  it('refuses callers outside the current binding, writer and membership before any journal write', async () => {
    const t = await setup();
    try {
      const body = await t.request('execute', { args: [] });
      const denied = async (work) =>
        expect(work).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      await denied(t.handler(body, await t.context({ invokedFunctionArn: t.pin.functionArn })));
      await denied(
        t.handler(
          body,
          await t.context({ invokedFunctionArn: `${t.pin.functionArn}:native_${'0'.repeat(32)}` }),
        ),
      );
      await denied(t.handler(body, await t.context({ functionVersion: '8' })));
      for (const key of ['writerGeneration', 'sequence', 'epoch'])
        await denied(
          t.handler(
            { ...body, identity: { ...body.identity, [key]: body.identity[key] + 1 } },
            await t.context(),
          ),
        );
      await denied(
        t.handler(
          { ...body, identity: { ...body.identity, bindingId: randomUUID() } },
          await t.context(),
        ),
      );
      t.access.allowed = false;
      await denied(t.handler(body, await t.context()));
      t.access.allowed = true;
      expect(t.calls).toHaveLength(0);
      expect(
        await t.journal.get({
          ...body.identity,
          configurationSha256: (await t.row()).configurationSha256,
        }),
      ).toBeNull();
      // Membership lost during the operation leaves it unfinished and unproven.
      t.hooks.tool = () => {
        t.access.allowed = false;
      };
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      t.access.allowed = true;
      t.hooks.tool = null;
      expect(
        await t.handler(
          { schemaVersion: 1, identity: body.identity, action: 'status' },
          await t.context(),
        ),
      ).toEqual({ ok: true, version: 0, pending: body.requestId });
    } finally {
      await t.close();
    }
  });

  it('never lets a stale writer or an uncertain job record a verified outcome', async () => {
    const t = await setup();
    try {
      const opened = await toGate(t);
      await approve(t, opened);
      // The previous turn's identity is no longer admitted after the reply.
      const previous = { ...(await t.identity()), sequence: 1 };
      await expect(
        t.handler({ schemaVersion: 1, identity: previous, action: 'status' }, await t.context()),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      // An isolated job with an unknown outcome is never retried or passed.
      t.jobs.check = async () => {
        throw engineFailure('NATIVE_ENGINE_JOB_UNCERTAIN');
      };
      const uncertain = await t.request('execute', {
        args: ['engine', 'sensor', 'fire', '--stage', 'build'],
      });
      await expect(t.send(uncertain)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_JOB_UNCERTAIN',
      });
      expect(await t.send(uncertain)).toMatchObject({
        response: { ok: true, status: 'pending', requestId: uncertain.requestId },
      });
      await expect(t.request('execute', { args: ['next'] })).resolves.toMatchObject({
        expectedVersion: expect.any(Number),
      });
      await expect(t.send(await t.request('execute', { args: ['next'] }))).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_BUSY',
      });
      // A publication made while the journal is unfinished has no proof.
      const produced = await t.f.turn(2, {
        files: [...t.project].map(([path, content]) => ({ path, content, role: 'code' })),
      });
      await expect(
        t.send(
          await t.request('finalize', {
            publication: produced.receipt,
            interaction: produced.interactionReceipt,
          }),
        ),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_BUSY' });
      expect(await t.proof(produced)).toBeNull();
    } finally {
      await t.close();
    }
  });

  it('drops an operation whose execution is cancelled before its commit', async () => {
    const t = await setup();
    try {
      const opened = await toGate(t);
      await approve(t, opened);
      const turn = await t.row();
      t.hooks.tool = async () => {
        await t.execution.cancel(t.f.bindingIdentity);
      };
      const body = await t.request('execute', { args: ['next'] });
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_WRITER_CHANGED' });
      t.hooks.tool = null;
      // The scripted engine reached its terminal event, yet nothing was committed.
      await expect(
        t.handler(
          { schemaVersion: 1, identity: body.identity, action: 'status' },
          await t.context(),
        ),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      const journalRows = [...t.f.rows.values()].filter((item) => item.sk.startsWith('ENGINE#'));
      expect(journalRows.find((item) => item.requestId === body.requestId)).toMatchObject({
        status: 'running',
      });
      expect(journalRows.filter((item) => item.sk.includes('#PUBLICATION#'))).toHaveLength(1);
      // The gate publication admitted before cancellation keeps its own proof.
      expect(await t.proof(opened, turn)).toMatchObject({ workflowCompletion: 'not_verified' });
    } finally {
      await t.close();
    }
  });
});
