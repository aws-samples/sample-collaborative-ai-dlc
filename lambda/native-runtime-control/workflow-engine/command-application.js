import { isDeepStrictEqual as same } from 'node:util';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import {
  engineDigest,
  engineFailure,
  nativeEngineFileDigest,
} from '../../shared/native-workflow-protocol.js';
import { nativeDraftPrompt } from '../draft-prompt.js';
import {
  nativeConfirmedWorkspaceResume,
  nativeRunningWorkspaceResume,
} from '../execution-store.js';
import {
  nativeEngineCommand,
  nativeEngineDirectiveSha,
  nativeEngineSelectedCommand,
} from './commands.js';
import { assertNativeEnginePresentedQuestion } from './presentation.js';
import { bindNativeEngineReply, noteNativeEngineOpenGate } from './reply-binding.js';
import { completeNativeEngineReview } from './review.js';

const decode = (result) => {
  if (result.exitCode !== 0) throw engineFailure('NATIVE_ENGINE_OBSERVATION_UNAVAILABLE');
  try {
    return JSON.parse(result.stdout.toString('utf8'));
  } catch {
    throw engineFailure('NATIVE_ENGINE_OBSERVATION_UNAVAILABLE');
  }
};
const directiveValue = (result) => {
  try {
    const body = JSON.parse(result.stdout.toString('utf8'));
    return result.exitCode === 0 && typeof body.kind === 'string' ? body : null;
  } catch {
    return null;
  }
};
const recordDirective = (state, directive, filesSha256) => {
  if (!directive || directive.kind === 'error') return;
  state.directive = directive;
  if (directive.kind === 'run-stage') {
    state.requirements.push({
      stage: directive.stage,
      unit: directive.unit ?? null,
      gate: directive.gate,
      reviewer: directive.reviewer ?? null,
      reviewClass: directive.review_class ?? 'none',
      sensors: directive.sensors_applicable ?? [],
      directiveSha256: nativeEngineDirectiveSha(directive),
      filesSha256,
    });
  }
};
const selectCommand = async (context, before) => {
  const { state, row, draft, identity, runner, sessionId, request, workspace } = context;
  const workspaceResume =
    nativeConfirmedWorkspaceResume(row) ||
    (row.response === undefined && nativeRunningWorkspaceResume(row));
  if (workspaceResume && (!state.initialMessage || before.status !== 'recorded'))
    throw engineFailure('NATIVE_ENGINE_STATE_UNAVAILABLE');
  let selected;
  let member = null;
  if (!state.initialMessage) {
    const text = nativeDraftPrompt(draft).text;
    state.initialMessage = decode(
      await runner.member({
        commandId: row.requestId,
        actorId: row.startedBy,
        sessionId,
        text,
      }),
    );
    // Literal initial intent. Plan selections and policy flags come
    // later from a command attached to the engine's protected proposal.
    selected = { args: ['engine', 'orchestrate', 'next', '--', text], member: true };
  } else {
    // Only the answer to a recorded question reaches the pinned engine as a
    // person's words. Any other accepted reply leaves this command without a
    // member: it is applied if it needs none and refused if it needs one.
    const bound = await bindNativeEngineReply(context);
    if (bound) {
      const { response, presented } = bound;
      assertNativeEnginePresentedQuestion(state, before, presented);
      const selectedCommand = nativeEngineSelectedCommand(presented, response);
      const recorded = decode(
        await runner.member({
          commandId: response.commandId,
          actorId: response.actorId,
          sessionId,
          text: response.text,
        }),
      );
      member = {
        ...recorded,
        ...response,
        writerGeneration: identity.writerGeneration,
        presentationSha256: presented.sha256,
        stage: presented.directive.stage ?? null,
        unit: presented.directive.unit ?? null,
        selectedCommand,
        application: 'pending',
      };
      state.decisions.push(member);
    } else
      member = state.decisions.findLast(
        (item) =>
          item.sequence === identity.sequence &&
          item.writerGeneration === identity.writerGeneration &&
          row.response?.commandId === item.commandId &&
          item.application === 'pending',
      );
    const args = request.args ?? [];
    const isNext =
      !args.length || same(args, ['next']) || same(args, ['engine', 'orchestrate', 'next']);
    const effective = member?.selectedCommand && isNext ? member.selectedCommand : args;
    selected = nativeEngineCommand({
      args: effective,
      state,
      project: workspace.project,
      workspaceResume,
      memberCommand: member?.selectedCommand,
      member,
    });
  }
  return { selected, member };
};
const recordApplication = ({ member, result, directive, added, selected }) => {
  if (member && result.exitCode === 0 && directive?.kind !== 'error') {
    const effect = added.findLast(
      (event) =>
        [
          'GATE_APPROVED',
          'GATE_REJECTED',
          'QUESTION_ANSWERED',
          'SUMMARY_CONFIRMATION_RECORDED',
          'PLAN_APPROVAL_RECORDED',
          'VERIFICATION_COMMAND_RECORDED',
          'CONSTRUCTION_POLICY_RECORDED',
          'WORKFLOW_STARTED',
          'PLAN_SELECTED',
        ].includes(event.event) &&
        (member.stage === null || event.stage === member.stage) &&
        (selected.member ||
          (selected.creation && event.event === 'WORKFLOW_STARTED') ||
          event.messageId === member.messageId ||
          event.userInputSha256 === member.textSha256),
    );
    const selectedProposal =
      selected.member &&
      member.stage === null &&
      directive &&
      ['ask', 'load-steering', 'run-stage'].includes(directive.kind);
    if (effect || selectedProposal)
      Object.assign(member, {
        application: 'applied',
        effect: effect?.event ?? 'PLAN_PROPOSAL_APPLIED',
        auditSha256: effect?.sha256 ?? nativeEngineDirectiveSha(directive),
      });
  }
};
const recordChecks = (state, runner, added) => {
  for (const item of runner.observations) {
    const check = item.observation;
    if (check?.kind !== 'check' || !check.sensor) continue;
    const sensors = added.filter(
      (event) =>
        ['SENSOR_PASSED', 'SENSOR_FAILED', 'SENSOR_BUDGET_OVERRIDE'].includes(event.event) &&
        event.sensor === check.sensor &&
        event.fireId === check.fireId &&
        event.stage === check.stage &&
        (event.unit ?? null) === check.unit &&
        event.outputPath === check.outputPath,
    );
    if (sensors.length !== 1) throw engineFailure('NATIVE_ENGINE_CHECK_RECEIPT_INVALID');
    state.observations.push({
      ...check,
      auditSha256: sensors[0].sha256,
    });
  }
};
export const applyNativeEngineCommand = async (context) => {
  const { state, request, workspace, runner, jobs, sessionId, authorize, inputSha256 } = context;
  // The real human hook can consume a protected engine challenge.
  // Include that application in the before/after observation.
  const before = decode(await runner.observe());
  noteNativeEngineOpenGate(state, before);
  const { selected, member } = await selectCommand(context, before);
  let result;
  result = selected.creation
    ? await runner.tool('aidlc-utility.ts', ['intent-create', ...selected.args.slice(3)])
    : await runner.tool(`aidlc-${selected.args[1]}.ts`, selected.args.slice(2));
  if (selected.review)
    result = await completeNativeEngineReview({
      requested: result,
      workspace,
      runner,
      jobs,
      sessionId,
      authorize,
    });
  const observed = decode(await runner.observe());
  noteNativeEngineOpenGate(state, observed);
  const previous = new Set((before.audit ?? []).map((event) => event.sha256));
  const added = (observed.audit ?? []).filter((event) => !previous.has(event.sha256));
  const directive = directiveValue(result);
  recordDirective(state, directive, inputSha256);
  recordApplication({ member, result, directive, added, selected });
  recordChecks(state, runner, added);
  const terminal = added.findLast((event) =>
    ['WORKFLOW_COMPLETED', 'WORKFLOW_FAILED'].includes(event.event),
  );
  if (terminal) {
    state.terminalResult = {
      auditSha256: terminal.sha256,
      stateSha256: observed.workflow.stateSha256,
      filesSha256: nativeEngineFileDigest(await workspace.publicFiles()),
    };
  }
  state.operations.push({
    requestId: request.requestId,
    inputSha256,
    argsSha256: engineDigest(canonicalJson(selected.args)),
    exitCode: result.exitCode,
    stdoutSha256: engineDigest(result.stdout),
    observationSha256: engineDigest(canonicalJson(observed)),
  });
  return result;
};
