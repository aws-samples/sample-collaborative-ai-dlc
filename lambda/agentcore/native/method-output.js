// Passive observation of the installed harness's top-level shell results. The
// active turn owns this instance. Nothing here invokes a command or admits a reply.
import {
  buildNativePendingInput,
  NATIVE_PENDING_INPUT_LIMITS,
} from '../../shared/native-pending-input.js';

const directCommand = (text) =>
  typeof text === 'string' &&
  !/[;&|<>`$\r\n]/.test(text) &&
  /^(?:(?:\S*\/)?(?:ba|z|da)?sh -[lc]+ ['"]?)?aidlc(?:\s|$)/.test(text);

export function observeNativeMethodOutput(harness) {
  let latest = null;
  let bashId = null;
  const capture = (text) => {
    latest = { observed: true };
    if (typeof text !== 'string' || Buffer.byteLength(text) > NATIVE_PENDING_INPUT_LIMITS.specBytes)
      return;
    try {
      const directive = JSON.parse(text.trim());
      if (directive.kind === 'ask') {
        const spec = { version: 3, ask: directive };
        if (buildNativePendingInput({ spec })) latest = { spec, bytes: Buffer.byteLength(text) };
      } else if (
        directive.kind === 'done' &&
        (directive.workflow_continues === undefined || directive.workflow_continues === false) &&
        /^Workflow complete\b/i.test(directive.reason)
      ) {
        latest = { terminal: 'complete' };
      }
    } catch {
      /* Non-directive shell output carries no workflow observation. */
    }
  };
  return {
    write(event) {
      if (
        harness === 'codex' &&
        event.type === 'item.completed' &&
        event.item?.type === 'command_execution' &&
        directCommand(event.item.command)
      ) {
        capture(event.item.exit_code === 0 ? event.item.aggregated_output : null);
      } else if (
        harness === 'opencode' &&
        event.type === 'tool_use' &&
        event.part?.tool === 'bash' &&
        directCommand(event.part.state?.input?.command)
      ) {
        capture(event.part.state.status === 'completed' ? event.part.state.output : null);
      } else if (
        harness === 'claude' &&
        !event.parent_tool_use_id &&
        Array.isArray(event.message?.content)
      ) {
        for (const block of event.message.content) {
          if (
            event.type === 'assistant' &&
            block?.type === 'tool_use' &&
            block.name === 'Bash' &&
            directCommand(block.input?.command)
          ) {
            latest = null;
            bashId = block.id;
          } else if (
            event.type === 'user' &&
            block?.type === 'tool_result' &&
            bashId &&
            block.tool_use_id === bashId
          ) {
            bashId = null;
            capture(block.is_error ? null : (event.tool_use_result?.stdout ?? block.content));
          }
        }
      }
    },
    result: () => latest,
  };
}

// 2.11.1 emits the named plans with the recommendation, before there is an
// active intent. The commandless alternative is presented by the conductor.
// Carry display fields only across the exact admitted continuation.
export function offeredPlanAlternatives(method) {
  const ask = method?.spec?.ask;
  if (ask?.ask_type !== 'scope-confirm') return null;
  const choices = ask.choices.filter((choice) => choice.command === undefined);
  if (choices.length !== 1) return null;
  return {
    label: choices[0].label,
    options: ask.scope_commands.map(({ scope, stages }) => ({ label: scope, description: stages })),
  };
}

export function observedTurnForm(completed, rendered, alternatives, reply, snapshot) {
  if (completed.method?.spec) return completed.method;
  if (
    completed.method ||
    rendered.reason !== 'absent' ||
    !alternatives ||
    reply !== alternatives.label
  )
    return rendered;
  if (
    snapshot.files.some((file) => /^aidlc\/spaces\/[^/]+\/intents\/active-intent$/.test(file.path))
  )
    return rendered;
  const replyText = completed.messages.map((message) => message.text).join('\n');
  if (!alternatives.options.every(({ label }) => replyText.includes(label))) return rendered;
  const spec = {
    version: 2,
    questions: [{ prompt: 'Choose a plan.', options: alternatives.options }],
  };
  return { spec, bytes: Buffer.byteLength(JSON.stringify(spec)) };
}
