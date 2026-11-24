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
  nativeEngineCommandWords,
  nativeEngineDirectiveSha,
  nativeEngineSelectedCommand,
  normalizeNativeEngineCommand,
} from './commands.js';
import { assertNativeEnginePresentedQuestion, openNativePlanPicker } from './presentation.js';
import { bindNativeEngineReply, noteNativeEngineOpenGate } from './reply-binding.js';
import { observedEngineGitDelta } from './git-evidence.js';
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
const nextCommand = ['engine', 'orchestrate', 'next'];
const holdsInitialIntake = (state, before) =>
  before.status === 'not_started' &&
  !state.decisions.length &&
  state.directive?.kind === 'print' &&
  /--propose <plan> --request [a-f0-9]{8}\b/.test(state.directive.message);

// The installed conductor calls `next $ARGUMENTS`. Recognize only a literal
// echo of the admitted draft, whether the shell passed one string or words.
// Supply the engine with the stored original, preserving whitespace and flags.
const echoesStart = (args, text) => {
  if (args.length <= 3 || !same(args.slice(0, 3), nextCommand)) return false;
  const words = args.slice(args[3] === '--' ? 4 : 3);
  if (!words.length || (args[3] !== '--' && words[0].startsWith('-'))) return false;
  return words.join(' ') === text || same(words, text.trim().split(/\s+/u));
};
const selectCommand = async (context, before) => {
  const { state, row, draft, identity, runner, sessionId, request, workspace } = context;
  const workspaceResume =
    nativeConfirmedWorkspaceResume(row) ||
    (row.response === undefined && nativeRunningWorkspaceResume(row));
  if (workspaceResume && (!state.initialMessage || before.status !== 'recorded'))
    throw engineFailure('NATIVE_ENGINE_STATE_UNAVAILABLE');
  const project = workspace.project;
  let args = normalizeNativeEngineCommand(request.args ?? [], project);
  if (
    (!state.initialMessage || (!row.response && holdsInitialIntake(state, before))) &&
    echoesStart(args, nativeDraftPrompt(draft).text)
  )
    args = nextCommand;
  const isNext = same(args, nextCommand);
  const validate = (effective, member = null) =>
    nativeEngineCommand({
      args: effective,
      state,
      project,
      workspaceResume,
      memberCommand: member?.selectedCommand,
      member,
    });
  if (!state.initialMessage) {
    // Lifecycle hooks and reads may arrive before the conductor. Only its
    // ordinary scheduling command may deliver the authenticated draft.
    if (!isNext) return { selected: validate(args), member: null };
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
    return { selected: { args: [...args, '--', text], member: true }, member: null };
  }
  // Only the answer to a recorded question reaches the pinned engine as a
  // person's words. Any other accepted reply leaves this command without a
  // member: it is applied if it needs none and refused if it needs one.
  const bound = await bindNativeEngineReply(context);
  const selectedCommand = bound && nativeEngineSelectedCommand(bound.presented, bound.response);
  openNativePlanPicker(state, before, bound, selectedCommand);
  if (row.response && state.planPickerReplyId === row.response.commandId) {
    const menu = state.directive;
    if (menu?.kind === 'ask' && menu.ask_type === 'compose-offer') {
      const offered = [menu.compose_command, ...menu.scope_commands.map((entry) => entry.command)];
      // A conductor can try the named scope before the member has picked it.
      // Return the held question without executing that command or recording a decision.
      if (
        isNext ||
        offered.some((command) =>
          same(args, normalizeNativeEngineCommand(nativeEngineCommandWords(command), project)),
        )
      )
        return { selected: { args }, member: null, heldQuestion: menu };
      if (same(args.slice(0, 3), nextCommand)) throw engineFailure('NATIVE_ENGINE_COMMAND_DENIED');
      return { selected: validate(args), member: null };
    }
  }
  if (bound) {
    const { response, presented } = bound;
    const exactSelection =
      selectedCommand && same(args, normalizeNativeEngineCommand(selectedCommand, project));
    const isAnswer = same(args.slice(0, 3), ['engine', 'log', 'answer']);
    if (!isNext && !exactSelection && !isAnswer) return { selected: validate(args), member: null };
    assertNativeEnginePresentedQuestion(state, before, presented);
    const pending = {
      ...response,
      writerGeneration: identity.writerGeneration,
      presentationSha256: presented.sha256,
      stage: presented.directive.stage ?? null,
      unit: presented.directive.unit ?? null,
      selectedCommand,
      application: 'pending',
    };
    // The member hook itself can consume an open challenge. Validate the
    // requested operation before recording any words, even on a refused call.
    const effective = isNext && selectedCommand ? selectedCommand : args;
    const selected = validate(effective, pending);
    const recorded = decode(
      await runner.member({
        commandId: response.commandId,
        actorId: response.actorId,
        sessionId,
        text: response.text,
      }),
    );
    const member = { ...recorded, ...pending };
    state.decisions.push(member);
    // log answer needs the protected hook's newly issued message ID.
    return { selected: isAnswer ? validate(effective, member) : selected, member };
  }
  const member = state.decisions.findLast(
    (item) =>
      item.sequence === identity.sequence &&
      item.writerGeneration === identity.writerGeneration &&
      row.response?.commandId === item.commandId &&
      item.application === 'pending',
  );
  return {
    selected: validate(isNext && member?.selectedCommand ? member.selectedCommand : args, member),
    member,
  };
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
  const { selected, member, heldQuestion } = await selectCommand(context, before);
  // Before intent creation, bare next has no active workflow to schedule.
  // Re-present the pinned intake already held in the journal, including an
  // intake previously delivered to a startup hook. Never issue another one.
  const heldIntake = same(selected.args, nextCommand) && holdsInitialIntake(state, before);
  let result =
    heldQuestion || heldIntake
      ? {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify(heldQuestion ?? state.directive) + '\n'),
          stderr: Buffer.alloc(0),
        }
      : selected.creation
        ? await runner.tool('aidlc-utility.ts', ['intent-create', ...selected.args.slice(3)])
        : await runner.tool(
            selected.tool ?? `aidlc-${selected.args[1]}.ts`,
            selected.args.slice(2),
          );
  if (selected.review)
    result = await completeNativeEngineReview({
      requested: result,
      gitInput: context.gitInput,
      publications: context.publications,
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
    const files = await workspace.publicFiles();
    const delta = observedEngineGitDelta(context.gitInput, files);
    state.terminalResult = {
      ...(delta ? { gitDelta: delta } : {}),
      auditSha256: terminal.sha256,
      stateSha256: observed.workflow.stateSha256,
      filesSha256: nativeEngineFileDigest(files),
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
