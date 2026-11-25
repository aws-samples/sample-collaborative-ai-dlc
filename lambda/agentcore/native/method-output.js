// Passive display observation, scoped to one installed harness invocation.
// Nothing here changes a tool call, starts a process or admits an answer.
import {
  buildNativePendingInput,
  NATIVE_PENDING_INPUT_LIMITS,
} from '../../shared/native-pending-input.js';
import { issuedQuestionFile } from './question-file.js';
import { nativeGateFromSnapshot } from './turn-interaction.js';
import { isDeepStrictEqual } from 'node:util';

// Decode literal shell words, including the shell -lc envelope printed by Codex.
// Expansion, control operators and redirection have no attributable stdout.
function literalWords(text) {
  const words = [];
  let word = '',
    quote = '',
    started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === quote) {
      quote = '';
      continue;
    }
    if (quote !== "'" && c === '\\') {
      const next = text[++i];
      if (!next || next === '\n') return null;
      word += quote && !['"', '$', '`', '\\'].includes(next) ? '\\' + next : next;
    } else if (!quote && (c === '"' || c === "'")) quote = c;
    else if (!quote && /[ \t]/.test(c)) {
      if (started) words.push(word);
      word = '';
      started = false;
      continue;
    } else {
      if ((!quote && /[;&|<>(){}*?[~#\r\n]/.test(c)) || (quote !== "'" && /[$`]/.test(c)))
        return null;
      word += c;
    }
    started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

function methodCommand(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > NATIVE_PENDING_INPUT_LIMITS.specBytes)
    return 'uncertain';
  if (!/\baidlc\b/.test(text)) return null;
  let words = literalWords(text.trim());
  if (
    words?.length === 3 &&
    /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|zsh|dash|sh)$/.test(words[0]) &&
    /^-(?:lc|cl|c)$/.test(words[1])
  )
    words = literalWords(words[2]);
  if (!words) return 'opaque';
  if (words[0] !== 'aidlc') {
    // An argument named aidlc is commonly the workspace directory (ls aidlc).
    // Only an indirect invocation makes the provenance of its result unclear.
    if (
      words[0]?.endsWith('/aidlc') ||
      (['env', 'exec', 'command'].includes(words[0]) &&
        words.slice(1).some((word) => /(?:^|\/)aidlc$/.test(word)))
    )
      return 'opaque';
    return null;
  }
  const [, group, subject, operation] = words;
  if (group === 'engine' && subject === 'log' && operation === 'decision') {
    const flags = new Map();
    for (let i = 4; i < words.length; i += 2) {
      if (
        ![
          '--stage',
          '--decision',
          '--options',
          '--question-kind',
          '--unit',
          '--checkpoint',
          '--questions-file',
        ].includes(words[i]) ||
        !words[i + 1] ||
        flags.has(words[i])
      )
        return 'uncertain';
      flags.set(words[i], words[i + 1]);
    }
    if (/^[a-z][a-z0-9-]*$/.test(flags.get('--stage') ?? '') && flags.has('--decision'))
      return {
        stage: flags.get('--stage'),
        prompt: flags.get('--decision'),
        options: flags.get('--options'),
        questionKind: flags.get('--question-kind'),
        ...(flags.has('--unit') ? { unit: flags.get('--unit') } : {}),
        ...(flags.has('--checkpoint')
          ? { checkpoint: flags.get('--checkpoint'), path: flags.get('--questions-file') }
          : {}),
      };
  }
  // This particular utility reads the description, even if no intent exists yet.
  if (
    (words.length === 4 &&
      group === 'engine' &&
      subject === 'workspace' &&
      operation === 'project-description') ||
    (words.length === 6 &&
      group === 'engine' &&
      subject === 'log' &&
      operation === 'answers' &&
      words[4] === '--stage' &&
      /^[a-z][a-z0-9-]*$/.test(words[5])) ||
    (words.length === 2 && group === '--version')
  )
    return null;
  return group === 'next' || (group === 'engine' && subject === 'orchestrate')
    ? 'directive'
    : 'uncertain';
}

// The conductor publishes plan targets and their summaries with this ask.
// Answering it stays with the engine's protected Plan Approval command.
function planApprovalForm(ask) {
  const plan = ask.plan_approval;
  if (
    ask.ask_type !== 'plan-approval' ||
    ask.stage !== 'code-generation' ||
    ask.response_route !== 'next' ||
    !plan ||
    typeof plan.editing !== 'boolean' ||
    typeof ask.question !== 'string' ||
    !Array.isArray(plan.targets) ||
    !plan.targets.length ||
    plan.targets.length > 32 ||
    !Array.isArray(plan.choices) ||
    plan.choices.length !== 3 ||
    (ask.choices !== undefined &&
      (!Array.isArray(ask.choices) ||
        ask.choices.length !== plan.choices.length ||
        ask.choices.some((c, i) => c.label !== plan.choices[i]))) ||
    !plan.targets.every(
      (t) =>
        t &&
        (t.unit === null || (typeof t.unit === 'string' && /^[\w][\w.-]*$/.test(t.unit))) &&
        typeof t.plan_path === 'string' &&
        Array.isArray(t.summary) &&
        t.summary.every((l) => typeof l === 'string'),
    )
  )
    return null;
  const prompt = [
    plan.note,
    ask.question,
    ...plan.targets.map((t) => [t.plan_path, ...t.summary.map((l) => `- ${l}`)].join('\n')),
  ]
    .filter(Boolean)
    .join('\n\n');
  const spec = {
    version: 2,
    questions: [{ prompt, options: plan.editing ? [] : plan.choices.map((label) => ({ label })) }],
  };
  return buildNativePendingInput({ spec })
    ? { spec, bytes: Buffer.byteLength(JSON.stringify(spec)), targets: plan.targets }
    : null;
}

const stale = { spec: null, bytes: 0, reason: 'stale_spec' };
const unknown = { uncertain: true };
function methodResult(command, output, ok) {
  if (
    typeof output !== 'string' ||
    Buffer.byteLength(output) > NATIVE_PENDING_INPUT_LIMITS.specBytes
  )
    return unknown;
  try {
    const directive = JSON.parse(output);
    if (
      ok &&
      directive?.emitted === 'DECISION_RECORDED' &&
      typeof directive.stage === 'string' &&
      command === 'opaque'
    )
      return { recordedRequirementsDecision: true, recordedStage: directive.stage };
    if (typeof command === 'object')
      return ok && directive?.emitted === 'DECISION_RECORDED' && directive.stage === command.stage
        ? { decision: command }
        : unknown;
    if (command !== 'directive') return unknown;
    if (
      directive?.kind === 'error' &&
      typeof directive.message === 'string' &&
      directive.message.trim() &&
      directive.message.length <= NATIVE_PENDING_INPUT_LIMITS.promptChars
    )
      return { rejection: directive.message };
    if (!ok || typeof directive?.kind !== 'string') return unknown;
    if (directive.kind === 'ask') {
      const planApproval = planApprovalForm(directive);
      if (planApproval) return { otherAsk: true, planApproval };
      const spec = { version: 3, ask: directive };
      return buildNativePendingInput({ spec })
        ? { spec, bytes: Buffer.byteLength(output) }
        : { otherAsk: true };
    }
    if (
      directive.kind === 'done' &&
      (directive.workflow_continues === undefined || directive.workflow_continues === false) &&
      typeof directive.reason === 'string' &&
      /^Workflow complete\b/i.test(directive.reason)
    )
      return { terminal: 'complete' };
    if (directive.kind === 'run-stage') {
      const file = issuedQuestionFile(directive);
      return {
        advanced: true,
        ...(file ? { stageFile: file } : {}),
        ...(!directive.gate_only &&
        directive.answer_mode?.ask === false &&
        directive.answer_mode.mode === 'guide'
          ? { guidedStage: directive.stage }
          : {}),
      };
    }
    return { advanced: true, ...(directive.kind === 'print' ? { printed: true } : {}) };
  } catch {
    return unknown;
  }
}

export function observeNativeMethodOutput(harness) {
  let latest = null;
  let guidedStage = null;
  let stageFile = null;
  let offerLabels = null;
  const pending = new Map();
  let overflow = false;
  function start(id, command) {
    if (!command || pending.has(id)) return;
    if (typeof id !== 'string' || pending.size >= 32) {
      overflow = true;
      return;
    }
    // Concurrent workflow commands have no observable mutation order.
    if (pending.size) {
      for (const key of pending.keys()) pending.set(key, 'uncertain');
      command = 'uncertain';
    }
    pending.set(id, command);
  }
  function finish(id, command, output, ok) {
    const started = pending.get(id);
    pending.delete(id);
    if (!command && !started) return;
    if (pending.size) for (const key of pending.keys()) pending.set(key, 'uncertain');
    // An indirect shell has no attributable method stdout. Preserve the
    // independent, turn-cleared display transport when there was no earlier
    // observation. It cannot recover a prior ask or synthesize alternatives.
    if (
      (started ?? command) === 'opaque' &&
      !pending.size &&
      (!latest || latest.unattributed || stageFile)
    ) {
      const result = methodResult('opaque', output, ok);
      latest = result.recordedRequirementsDecision
        ? { ...result, ...(stageFile?.stage === result.recordedStage ? { stageFile } : {}) }
        : latest && !latest.unattributed
          ? unknown
          : { unattributed: true };
      if (latest.uncertain) stageFile = null;
      return;
    }
    latest = methodResult(
      pending.size || (started && command && !isDeepStrictEqual(started, command))
        ? 'uncertain'
        : (started ?? command),
      output,
      ok,
    );
    if (
      latest.uncertain ||
      latest.advanced ||
      latest.otherAsk ||
      latest.spec ||
      latest.terminal ||
      latest.rejection
    )
      stageFile = latest.stageFile ?? null;
    if (
      stageFile &&
      (latest.decision?.stage === stageFile.stage || latest.recordedStage === stageFile.stage)
    )
      latest.stageFile = stageFile;
    if (latest.decision && latest.decision.stage === guidedStage) latest.guidedStage = guidedStage;
    guidedStage = latest.guidedStage ?? null;
    if (latest.spec) {
      const ask = latest.spec.ask;
      offerLabels = new Set([
        ...buildNativePendingInput({ spec: latest.spec }).questions[0].options.map(
          ({ label }) => label,
        ),
        ...ask.scope_commands.map(({ scope }) => scope),
      ]);
    } else if (offerLabels && (latest.advanced || latest.otherAsk)) {
      latest = { ...latest, supersededLabels: offerLabels };
    }
  }
  return {
    write(event) {
      if (harness === 'codex' && event.item?.type === 'command_execution') {
        const item = event.item;
        // Some completed shells omit the command. A correlated start supplies
        // it. Without either, stdout cannot describe the method. A separately
        // rendered current form remains usable when no method offer preceded it.
        if (
          event.type === 'item.completed' &&
          item.command === undefined &&
          !pending.has(item.id)
        ) {
          latest = !latest || latest.unattributed ? { unattributed: true } : unknown;
          return;
        }
        const command = item.command === undefined ? null : methodCommand(item.command);
        if (event.type === 'item.started') start(item.id, command);
        if (event.type === 'item.completed')
          finish(
            item.id,
            command,
            item.aggregated_output,
            item.exit_code === 0 && (!item.status || item.status === 'completed'),
          );
      } else if (
        harness === 'opencode' &&
        event.type === 'tool_use' &&
        event.part?.tool === 'bash'
      ) {
        const { state, callID } = event.part;
        const command = methodCommand(state?.input?.command);
        if (state?.status === 'running' || state?.status === 'pending') start(callID, command);
        else
          finish(
            callID,
            command,
            state?.output,
            state?.status === 'completed' &&
              (state.metadata?.exit === undefined || state.metadata.exit === 0),
          );
      } else if (
        harness === 'claude' &&
        !event.parent_tool_use_id &&
        Array.isArray(event.message?.content)
      ) {
        const blocks = event.message.content;
        for (const block of blocks) {
          if (event.type === 'assistant' && block?.type === 'tool_use' && block.name === 'Bash')
            start(block.id, methodCommand(block.input?.command));
          if (
            event.type === 'user' &&
            block?.type === 'tool_result' &&
            pending.has(block.tool_use_id)
          ) {
            const content = block.content;
            const text =
              Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
                ? content[0].text
                : content;
            finish(
              block.tool_use_id,
              null,
              (blocks.length === 1 ? event.tool_use_result?.stdout : null) ?? text,
              block.is_error !== true && event.tool_use_result?.interrupted !== true,
            );
          }
        }
      }
    },
    result: () => (overflow || pending.size ? unknown : latest),
  };
}

// Keep only display fields for the exact next admitted interaction. A free-text
// response to the recommendation cannot authorize a named plan from the picker.
export function offeredPlanAlternatives(method) {
  const ask = method?.spec?.ask;
  if (ask?.ask_type === 'compose-offer') {
    const form = buildNativePendingInput({ spec: method.spec });
    if (!form) return null;
    return {
      named: true,
      prompt: ask.question,
      options: form.questions[0].options,
      commandLabels: [],
    };
  }
  if (ask?.ask_type !== 'scope-confirm') return null;
  const choices = ask.choices.filter((choice) => choice.command === undefined);
  if (choices.length !== 1) return null;
  const options = ask.scope_commands.map(({ scope, stages }) => ({
    label: scope,
    description: stages,
  }));
  if (
    !buildNativePendingInput({
      spec: { version: 2, questions: [{ prompt: 'Choose a plan.', options }] },
    })
  )
    return null;
  return {
    alternativeIndex: ask.choices.indexOf(choices[0]),
    label: choices[0].label,
    commandLabels: ask.choices
      .filter((choice) => choice.command !== undefined)
      .map((choice) => choice.label),
    options,
  };
}

export function observedTurnForm({ method }, rendered, alternatives, reply, snapshot) {
  const space = snapshot.files
    .find((file) => file.path === 'aidlc/active-space')
    ?.content?.toString('utf8')
    .trim();
  const created = snapshot.files.some(({ path }) =>
    space
      ? path === `aidlc/spaces/${space}/intents/active-intent`
      : /^aidlc\/spaces\/[^/]+\/intents\/active-intent$/.test(path),
  );
  if (
    method &&
    created &&
    (method?.spec?.ask?.ask_type === 'scope-confirm' ||
      (!method?.spec && rendered.spec?.ask?.ask_type === 'scope-confirm'))
  )
    return stale;
  if (method?.spec) return method;
  if (method?.planApproval && created) {
    const intents = `aidlc/spaces/${space}/intents`;
    const intent = snapshot.files
      .find((f) => f.path === `${intents}/active-intent`)
      ?.content.toString()
      .trim();
    const marker = snapshot.files.find(
      (f) => f.path === `${intents}/${intent}/.aidlc-engine/active-directive.json`,
    );
    try {
      const cursor = JSON.parse(marker.content);
      const targets = method.planApproval.targets;
      const units = targets.map((t) => t.unit).filter((unit) => unit !== null);
      const root = `${intents}/${intent}/construction`;
      const paths = new Set(snapshot.files.map((file) => file.path));
      if (
        cursor.version === 2 &&
        cursor.kind === 'ask' &&
        cursor.ask_type === 'plan-approval' &&
        cursor.stage === 'code-generation' &&
        isDeepStrictEqual(cursor.units ?? (cursor.unit ? [cursor.unit] : []), units) &&
        targets.every((target) => {
          const dir = [root, target.unit, 'code-generation'].filter(Boolean).join('/');
          return [
            [target.plan_path, 'code-generation-plan.md'],
            [target.instructions_path, 'unit-test-instructions.md'],
            [target.questions_path, 'code-generation-questions.md'],
          ].every(([path, name]) => path === `${dir}/${name}` && paths.has(path));
        })
      )
        return method.planApproval;
    } catch {
      /* no current method binding */
    }
    return stale;
  }
  if (
    method?.decision &&
    !method.decision.questionKind &&
    nativeGateFromSnapshot(snapshot)?.stage === method.decision.stage
  ) {
    const options = method.decision.options?.split(',').map((label) => ({ label: label.trim() }));
    const spec = { version: 2, questions: [{ prompt: method.decision.prompt, options }] };
    if (
      buildNativePendingInput({ spec, gate: { stage: method.decision.stage } })?.kind === 'approval'
    )
      return { spec, bytes: Buffer.byteLength(JSON.stringify(spec)) };
  }
  if (
    method?.rejection ||
    method?.uncertain ||
    method?.terminal ||
    method?.decision ||
    method?.recordedRequirementsDecision
  )
    return stale;
  if (method?.otherAsk || method?.advanced) {
    if (rendered.spec?.version === 3) return stale;
    const potentialGate = buildNativePendingInput({
      gate: { stage: 'unknown' },
      spec: rendered.spec,
    });
    if (potentialGate?.kind === 'approval' && !nativeGateFromSnapshot(snapshot)) return stale;
    const labels = potentialGate?.questions[0]?.options.map((option) => option.label);
    if (
      labels?.length &&
      labels.every(
        (label) =>
          method.supersededLabels?.has(label) ||
          alternatives?.options.some((option) => option.label === label) ||
          alternatives?.commandLabels.includes(label) ||
          label === alternatives?.label,
      )
    )
      return stale;
  }
  if (
    method ||
    !alternatives ||
    typeof reply !== 'string' ||
    !reply.trim() ||
    alternatives.commandLabels.includes(reply) ||
    created
  )
    return rendered;
  const spec = {
    version: 2,
    questions: [{ prompt: 'Choose a plan.', options: alternatives.options }],
  };
  return { spec, bytes: Buffer.byteLength(JSON.stringify(spec)) };
}
