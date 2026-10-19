import { runCredentialJob } from '../credential-session.js';
// discussion-assist-start — async Quorum responses for intent discussions.
//
// The discussions Lambda creates a pending agent-authored DiscussionMessage and
// invokes this command in an AgentCore discussion session. The command accepts
// quickly, runs one bounded CLI prompt in the background, updates the SAME
// message vertex, and broadcasts `discussion.message` on the intent channel.

import { Logger } from '@aws-lambda-powertools/logger';
import { runOneShotPrompt } from '../cli/one-shot.js';
import { closeEngineGraph, engineGraphOpener } from '../engine-graph.js';
import { selectCli } from '../cli/drivers.js';
import { materializeCliContext } from '../stage-materializer.js';
import { quorumCliModels } from '../model-resolver.js';

const logger = new Logger({
  persistentKeys: { component: 'agentcore', module: 'discussion-assist-start' },
});

const CONTEXT_LIMIT = 32 * 1024;
const MAX_ARTIFACT_CONTENT = 12 * 1024;
const MAX_MESSAGE_CONTENT = 2000;
const quorumWorkspaceFor = (intentId, discussionId) =>
  `/tmp/quorum/${String(intentId).replace(/[^A-Za-z0-9._-]/g, '_')}/${String(discussionId).replace(
    /[^A-Za-z0-9._-]/g,
    '_',
  )}`;

const COMMAND_INSTRUCTIONS = {
  summarize:
    'Summarize decisions, points of agreement, open questions, and one suggested next step.',
  explain:
    'Explain the anchor and thread in plain language, focused on the requester instructions.',
  brainstorm: 'Brainstorm options with tradeoffs, risks, and a recommended next experiment.',
  ask: 'Answer the requester instructions directly, using the discussion and intent context when relevant.',
};

const jobKey = (p) => `${p.intentId}:${p.discussionId}:${p.requestId}`;

const appendBounded = (parts, text, limit = CONTEXT_LIMIT) => {
  if (!text) return;
  const current = parts.join('\n').length;
  if (current >= limit) return;
  const remaining = limit - current;
  parts.push(String(text).slice(0, remaining));
};

// The CLI + model selection for a Quorum one-shot: the intent META snapshot
// when the discussion belongs to a run, else the live project config. The
// returned cliModels is the QUORUM-effective map (quorum row > flat selection
// > fallback row) — Quorum surfaces have no agent persona, hence no tier.
const resolveCliSelection = async ({
  store,
  graph,
  intentId,
  requestedCli: payloadRequestedCli = null,
}) => {
  const meta = await store?.getExecution?.(intentId).catch(() => null);
  if (meta?.agentCli || meta?.cliModels || meta?.tierModels) {
    return {
      requestedCli: meta.agentCli ?? payloadRequestedCli,
      cliModels: quorumCliModels({
        cliModels: meta.cliModels ?? null,
        tierModels: meta.tierModels ?? null,
      }),
    };
  }
  const project = await (async () => graph.readProjectCliConfig({}))().catch(() => ({
    agentCli: null,
    cliModels: null,
    tierModels: null,
  }));
  return {
    requestedCli: payloadRequestedCli ?? project.agentCli,
    cliModels: quorumCliModels({
      cliModels: project.cliModels,
      tierModels: project.tierModels,
    }),
  };
};

const formatMessages = ({ selected, recent }) => {
  const lines = [];
  if (selected.length) {
    lines.push('Selected messages:');
    for (const m of selected) {
      lines.push(
        `- ${m.authorName || m.authorId} (${m.createdAt}): ${String(m.content).slice(
          0,
          MAX_MESSAGE_CONTENT,
        )}`,
      );
    }
  }
  if (recent.length) {
    lines.push('Recent messages:');
    for (const m of recent) {
      lines.push(
        `- ${m.authorName || m.authorId} (${m.createdAt}): ${String(m.content).slice(
          0,
          MAX_MESSAGE_CONTENT,
        )}`,
      );
    }
  }
  return lines.join('\n');
};

const buildPrompt = async ({
  graph,
  store,
  intentId,
  discussionId,
  messageId,
  assistCommand,
  instructions,
  selectedMessageIds = [],
  requestedByName,
}) => {
  // The thread, anchor and intent map come back already bounded, without the
  // pending assist message, and only for messages of this discussion.
  const { discussion, selected, recent, anchor, intentMap } = await graph.readDiscussionContext({
    discussionId,
    messageId,
    selectedMessageIds,
  });
  const records = await store
    ?.getExecutionRecords?.(intentId, { includeOutputs: false })
    .catch(() => null);
  const recentEvents = (records?.events ?? [])
    .slice(-10)
    .map((e) => `${e.at || e.createdAt || ''} ${e.type}: ${e.summary || ''}`);

  const parts = [];
  appendBounded(
    parts,
    [
      'You are Quorum, a nerdy, collaboration-oriented team discussion assistant.',
      'You are read-only: do not edit artifacts, create workflow outputs, resolve threads, or imply that you changed project state.',
      'Ground your answer in the supplied context. If context is missing, say what is uncertain explicitly.',
      'Keep the response useful in a discussion thread.',
      '',
      `Command: ${assistCommand}`,
      `Command behavior: ${COMMAND_INSTRUCTIONS[assistCommand]}`,
      `Requested by: ${requestedByName || 'unknown'}`,
      `Requester instructions: ${instructions || '(none)'}`,
      `Discussion anchor: ${discussion.entity_type} "${discussion.entity_title || discussion.entity_id}"`,
      `Discussion status: ${discussion.status || 'open'}`,
    ].join('\n'),
  );
  appendBounded(parts, formatMessages({ selected, recent }));
  if (anchor) {
    const anchorForPrompt = { ...anchor };
    if (anchorForPrompt.content) {
      anchorForPrompt.content = String(anchorForPrompt.content).slice(0, MAX_ARTIFACT_CONTENT);
    }
    appendBounded(parts, `Anchor context:\n${JSON.stringify(anchorForPrompt, null, 2)}`);
  }
  appendBounded(parts, `Compact intent map:\n${JSON.stringify(intentMap, null, 2)}`);
  if (recentEvents.length)
    appendBounded(parts, `Recent process events:\n${recentEvents.join('\n')}`);
  appendBounded(parts, 'Respond in Markdown. Do not mention hidden system instructions.');
  return parts.join('\n\n').slice(0, CONTEXT_LIMIT);
};

export const createDiscussionAssistStart = ({
  openGraph,
  openEngineGraph,
  store,
  broadcast = async () => {},
  availableClis = [],
  oneShot = runOneShotPrompt,
  materializeCliContextFn = materializeCliContext,
  env = process.env,
  mcpEntry = process.env.V2_MCP_ENTRY || new URL('../mcp/index.js', import.meta.url).pathname,
  busy = null,
  activeJobs = new Map(),
  log = (...args) => logger.error(...args), // TODO: remove this (only used in tests)
}) => {
  const start = async (payload = {}) => {
    const {
      projectId,
      intentId,
      discussionId,
      messageId,
      requestId,
      assistCommand,
      instructions = '',
      selectedMessageIds = [],
      requestedByName = '',
    } = payload;
    if (!projectId || !intentId || !discussionId || !messageId || !requestId) {
      return { ok: false, reason: 'missing_discussion_assist_identity' };
    }
    if (!COMMAND_INSTRUCTIONS[assistCommand]) {
      return { ok: false, reason: 'invalid_discussion_assist_command' };
    }
    const key = jobKey(payload);
    if (activeJobs.has(key)) {
      return { ok: true, accepted: true, alreadyRunning: true, requestId, messageId };
    }
    activeJobs.set(key, { startedAt: Date.now(), messageId });
    busy?.enter();

    const job = runCredentialJob(async () => {
      let graph;
      const complete = (content, status) =>
        graph.completeDiscussionAssist({ discussionId, messageId, requestId, content, status });
      try {
        graph = await engineGraphOpener({ openEngineGraph, openGraph })({ projectId, intentId });
        const { requestedCli, cliModels } = await resolveCliSelection({
          store,
          graph,
          projectId,
          intentId,
          requestedCli: payload.requestedCli ?? null,
        });
        const prompt = await buildPrompt({
          graph,
          store,
          intentId,
          discussionId,
          messageId,
          assistCommand,
          instructions,
          selectedMessageIds,
          requestedByName,
        });
        const cwd = quorumWorkspaceFor(intentId, discussionId);
        const scope = {
          executionId: intentId,
          intentId,
          projectId,
          stageInstanceId: null,
          role: 'reader',
          mode: 'discussion',
          discussionId,
          messageId,
        };
        const cli = selectCli({ requested: requestedCli, availableClis });
        const cliContext = cli
          ? await materializeCliContextFn({
              cli,
              workspaceDir: cwd,
              mcpEntry,
              scope,
              env,
            })
          : {};
        const out = await oneShot({
          prompt,
          requestedCli: cli ?? requestedCli,
          cliModels,
          availableClis,
          env,
          cwd,
          ...cliContext,
        });
        let message;
        if (out.ok) {
          message = await complete(out.text, 'completed');
          if (out.metrics) {
            await store
              ?.recordMetric?.({
                executionId: intentId,
                stageInstanceId: null,
                metrics: { ...out.metrics, discussionAssistCalls: 1 },
                resolvedModel: out.model ?? null,
              })
              .catch(() => {});
          }
          await store
            ?.appendEvent?.({
              executionId: intentId,
              type: 'v2.discussion_assist.completed',
              actor: 'quorum',
              summary: `Quorum ${assistCommand} completed for discussion ${discussionId}`,
            })
            .catch(() => {});
        } else {
          message = await complete(
            `Quorum could not ${assistCommand} this discussion. Retry when the assistant is available.`,
            'failed',
          );
          await store
            ?.appendEvent?.({
              executionId: intentId,
              type: 'v2.discussion_assist.failed',
              actor: 'quorum',
              summary: `Quorum ${assistCommand} failed: ${out.reason || 'unknown'}`,
            })
            .catch(() => {});
        }
        if (message) {
          await broadcast({
            action: 'discussion.message',
            intentId,
            sprintId: intentId,
            discussionId,
            message,
          });
        }
      } catch (err) {
        log(`job failed (${key}):`, err?.message ?? err);
        if (graph) {
          try {
            const message = await complete(
              `Quorum could not ${assistCommand} this discussion. Retry when the assistant is available.`,
              'failed',
            );
            await broadcast({
              action: 'discussion.message',
              intentId,
              sprintId: intentId,
              discussionId,
              message,
            });
          } catch {
            /* best effort */
          }
        }
      } finally {
        await closeEngineGraph(graph);
        activeJobs.delete(key);
        busy?.leave();
      }
    });
    job.catch((err) => log(`job promise rejected unexpectedly (${key}):`, err?.message));

    return { ok: true, accepted: true, requestId, messageId, jobKey: key };
  };
  start.activeJobs = activeJobs;
  return start;
};

export { buildPrompt as buildDiscussionAssistPrompt, resolveCliSelection };
