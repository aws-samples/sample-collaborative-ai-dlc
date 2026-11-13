// Only the protected host can invoke this module. No request from the coding
// role may enter this path or select the originating member.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [installation, project] = process.argv.slice(2);
const decision = JSON.parse(await Bun.stdin.text());
if (
  typeof decision.commandId !== 'string' ||
  typeof decision.actorId !== 'string' ||
  typeof decision.sessionId !== 'string' ||
  typeof decision.text !== 'string' ||
  decision.text.length === 0 ||
  decision.text.length > 65_536
)
  throw new Error('NATIVE_ENGINE_MEMBER_INVALID');
const hook = await import(
  pathToFileURL(join(installation, 'hooks/aidlc-record-human-turn.ts')).href
);
const messages = await import(
  pathToFileURL(join(installation, 'tools/aidlc-message-store.ts')).href
);
const before = new Set(messages.listMessages(project).map((message) => message.id));
const code = await hook.run(
  JSON.stringify({
    cwd: project,
    hook_event_name: 'UserPromptSubmit',
    session_id: decision.sessionId,
    prompt: decision.text,
    origin: { kind: 'person' },
  }),
);
const created = messages.listMessages(project).filter((message) => !before.has(message.id));
if (
  code !== 0 ||
  created.length !== 1 ||
  created[0].session !== decision.sessionId ||
  created[0].text !== decision.text ||
  created[0].cut === true
)
  throw new Error('NATIVE_ENGINE_MEMBER_NOT_RECORDED');
console.log(
  JSON.stringify({
    status: 'recorded',
    commandId: decision.commandId,
    actorId: decision.actorId,
    messageId: created[0].id,
    at: created[0].at,
    // The engine command consuming this message must still succeed. Recording
    // the message alone is neither a stage approval nor decision application.
    application: 'pending',
  }),
);
