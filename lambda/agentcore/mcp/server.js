// V2 agent MCP server — THE integration contract between the stage agent and the
// application. A stdio MCP server the headless CLI connects to via --mcp-config.
//
// Design rules (this is core, must stay stable):
//   - Tools are GENERIC over the v2 artifact vocabulary (create/update/link/
//     lookup/search), not a fixed v1 taxonomy — the artifact_type is data.
//   - Business writes go to Neptune ONLY through graph-writer (typed, scope-
//     stamped, edge-allowlisted). Process/collab go through the process bridge
//     (DynamoDB + websocket). An agent can never fabricate graph topology or
//     spoof its own provenance — scope comes from the trusted container ENV.
//   - A REVIEWER run gets a READ-ONLY subset (lookup/get/search/neighbors) — a
//     clean-room judge inspects, it never writes.
//
// Testability: `buildToolHandlers({ writer, bridge })` returns plain async
// functions returning MCP content envelopes, so the suite exercises every tool
// against a real graph-writer (gremlin testcontainer) + a stubbed bridge with NO
// MCP SDK. `startMcpServer()` (only at container entry) wires the real SDK +
// stdio transport over the same handlers.

import { createHash } from 'node:crypto';
import { GraphWriteError } from './graph-writer.js';

export const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
export const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

// Wrap a writer/bridge call into an MCP envelope, turning a GraphWriteError (bad
// edge, missing node, reserved arg) into a clean isError result instead of an
// opaque thrown exception.
const guard = async (fn) => {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof GraphWriteError) return fail(`graph write rejected: ${e.message}`);
    return fail(e.message);
  }
};

// Business writes land in Neptune only — invisible to the intent page's
// realtime channel, which carries PROCESS events. After a successful artifact
// create/update, drop a best-effort stage note through the bridge: it appends
// a timeline EVENT# row AND broadcasts `agent.note`, which the UI refetches
// on — so new artifacts appear live instead of waiting for the 8s poll
// backstop. Never let the note fail the tool call: the artifact IS written,
// and a retried create would collide with it.
const notifyArtifact = async (bridge, { id, title, action }) => {
  try {
    await bridge?.emitStageNote?.({
      summary: `Artifact ${action}: ${title || id}`,
      type: `v2.artifact.${action}`,
    });
  } catch {
    /* best-effort — the poll backstop still covers the UI */
  }
};

// The write stamp that makes output lineage checkable: which artifact was written,
// with what bytes, under which recorded authorization (null when none was held).
// The bridge no-ops without a resolved release policy, so an unpinned run emits
// nothing. Best-effort for the same reason as notifyArtifact — the artifact is
// already written and a retried create would collide with it.
const stampArtifact = async (bridge, { id, artifactType, content }) => {
  try {
    await bridge?.stampArtifact?.({
      artifactId: id,
      artifactType,
      contentHash: createHash('sha256')
        .update(typeof content === 'string' ? content : JSON.stringify(content ?? null))
        .digest('hex'),
    });
  } catch {
    /* the absence of a stamp is itself evidence; never fail the write */
  }
};

const envelopeTextBytes = (env) =>
  (env?.content ?? []).reduce((n, part) => n + Buffer.byteLength(part?.text ?? '', 'utf8'), 0);

const envelopeResultCount = (env) => {
  try {
    const parsed = JSON.parse(env?.content?.[0]?.text ?? 'null');
    return Array.isArray(parsed) ? parsed.length : parsed == null ? 0 : 1;
  } catch {
    return null;
  }
};

const guardRead = async (bridge, tool, args, fn) => {
  const env = await guard(fn);
  if (!env?.isError) {
    Promise.resolve(
      bridge?.recordGraphRead?.({
        tool,
        args,
        bytes: envelopeTextBytes(env),
        resultCount: envelopeResultCount(env),
      }),
    ).catch(() => {});
  }
  return env;
};

// The full author tool surface (a main stage agent). Reviewer runs get the
// READ_TOOLS subset only (see reviewerHandlers).
export const buildToolHandlers = ({ writer, graph, bridge }) => {
  const withWriter = (fn) => (graph ? graph.withWriter(fn) : fn(writer));

  return {
    // ── Business reads ──
    get_artifact: ({ id, mode }) =>
      guardRead(bridge, 'get_artifact', { id, mode: mode ?? 'full' }, () =>
        withWriter((w) => w.getArtifact({ id, mode: mode ?? 'full' })),
      ),
    lookup_artifacts: ({ artifactType }) =>
      guardRead(bridge, 'lookup_artifacts', { artifactType }, () =>
        withWriter((w) => w.lookupArtifacts({ artifactType })),
      ),
    get_intent_graph: () =>
      guardRead(bridge, 'get_intent_graph', {}, () => withWriter((w) => w.getIntentGraph())),
    get_artifact_neighbors: ({ id, edge, direction }) =>
      guardRead(bridge, 'get_artifact_neighbors', { id, edge, direction }, () =>
        withWriter((w) =>
          w.getNeighbors({ id, edge: edge ?? null, direction: direction ?? 'both' }),
        ),
      ),
    get_artifact_toc: ({ id }) =>
      guardRead(bridge, 'get_artifact_toc', { id }, () =>
        withWriter((w) => w.getArtifactToc({ id })),
      ),
    get_section: ({ artifactId, heading, slug }) =>
      guardRead(bridge, 'get_section', { artifactId, heading, slug }, () =>
        withWriter((w) =>
          w.getSection({ artifactId, heading: heading ?? null, slug: slug ?? null }),
        ),
      ),
    get_items: ({ itemType, artifactType, limit }) =>
      guardRead(bridge, 'get_items', { itemType, artifactType, limit }, () =>
        withWriter((w) =>
          w.getItems({
            itemType: itemType ?? null,
            artifactType: artifactType ?? null,
            limit: limit ?? 100,
          }),
        ),
      ),
    search_graph: ({ query, artifactType, limit }) =>
      guardRead(bridge, 'search_graph', { query, artifactType, limit }, () =>
        withWriter((w) =>
          w.searchGraph({ query, artifactType: artifactType ?? null, limit: limit ?? 25 }),
        ),
      ),
    get_coverage: ({ unitSlug }) =>
      guardRead(bridge, 'get_coverage', { unitSlug }, () =>
        withWriter((w) => w.getCoverage({ unitSlug: unitSlug ?? null })),
      ),
    get_team_knowledge: ({ agentRef }) =>
      guard(() => withWriter((w) => w.getTeamKnowledge({ agentRef: agentRef ?? null }))),
    get_learning_rules: () => guard(() => withWriter((w) => w.getLearningRules())),

    // ── Business writes ──
    create_artifact: ({ artifactType, id, title, content, props, links }) =>
      guard(async () => {
        const res = await withWriter((w) =>
          w.createArtifact({
            artifactType,
            id,
            title,
            content,
            props,
            links: links ?? [],
          }),
        );
        await notifyArtifact(bridge, { id: res.id, title, action: 'created' });
        await stampArtifact(bridge, { id: res.id, artifactType: res.artifactType, content });
        return res;
      }),
    update_artifact: ({ id, props }) =>
      guard(async () => {
        const res = await withWriter((w) => w.updateArtifact({ id, props: props ?? {} }));
        await notifyArtifact(bridge, { id: res.id, title: props?.title, action: 'updated' });
        await stampArtifact(bridge, {
          id: res.id,
          artifactType: res.artifactType,
          content: props ?? {},
        });
        return res;
      }),
    link_artifacts: ({ fromId, toId, edge }) =>
      guard(() => withWriter((w) => w.linkArtifacts({ fromId, toId, edge }))),
    record_team_knowledge: ({ id, title, content, agentRef, props }) =>
      guard(() =>
        withWriter((w) =>
          w.recordTeamKnowledge({ id, title, content, agentRef: agentRef ?? 'shared', props }),
        ),
      ),
    record_learning_rule: ({ id, title, content, layer, pairing }) =>
      guard(() =>
        withWriter((w) =>
          w.recordLearningRule({
            id,
            title,
            content,
            layer: layer ?? 'project-learnings',
            pairing: pairing ?? 'feedforward-only',
          }),
        ),
      ),

    // ── Collaboration / process ──
    ask_question: ({ questions }) => guard(() => bridge.askQuestion({ questions })),
    confirm_summary: ({ summary, decisions }) =>
      guard(() => bridge.confirmSummary({ summary, decisions: decisions ?? [] })),
    request_plan_approval: ({ plan, testInstructions }) =>
      guard(() => bridge.requestPlanApproval({ plan, testInstructions })),
    send_output: ({ content, kind }) =>
      guard(() => bridge.sendOutput({ content, kind: kind ?? 'text' })),
    record_project_type: ({ projectType }) =>
      guard(() => bridge.recordProjectType({ projectType })),
    collect_metric: ({ metrics }) => guard(() => bridge.collectMetric({ metrics })),
    emit_stage_note: ({ summary, type }) => guard(() => bridge.emitStageNote({ summary, type })),
    submit_review: ({ reviewer, verdict, findings, round }) =>
      guard(() =>
        bridge.submitReview({ reviewer, verdict, findings: findings ?? '', round: round ?? 0 }),
      ),
  };
};

// Read-only tool names a clean-room reviewer may call. No writes, no questions —
// a reviewer inspects and judges; it never mutates the graph or asks the human.
export const READ_TOOLS = [
  'get_artifact',
  'lookup_artifacts',
  'get_intent_graph',
  'get_artifact_neighbors',
  'get_artifact_toc',
  'get_section',
  'get_items',
  'search_graph',
  'get_coverage',
  'get_team_knowledge',
  'get_learning_rules',
];

// All author tool names.
export const AUTHOR_TOOLS = [
  ...READ_TOOLS,
  'create_artifact',
  'update_artifact',
  'link_artifacts',
  'record_team_knowledge',
  'record_learning_rule',
  'ask_question',
  'send_output',
  'collect_metric',
  'emit_stage_note',
];

export const REVIEWER_TOOLS = [...READ_TOOLS, 'collect_metric', 'submit_review'];
export const WORKSPACE_DETECTION_TOOLS = ['record_project_type'];

// Tools the resolved release policy ADDS or WITHDRAWS,
// §6.1, §7.3). Tool availability — not prompt prose — is the enforcement seam:
//   - a checkpoint tool that does not exist when the policy is off cannot be
//     called by accident, and one the platform owns cannot be faked;
//   - `learnings: off` WITHDRAWS the two learning writers, which is strictly
//     stronger than asking the agent not to call them and is what upstream does
//     (no protocol module ⇒ no commands).
// A null policy (2.3.3 / unpinned) changes nothing, which is what keeps the
// registered tool list byte-identical for those runs.
const LEARNING_TOOLS = ['record_team_knowledge', 'record_learning_rule'];
export const CHECKPOINT_TOOLS = ['confirm_summary', 'request_plan_approval'];

const policyTools = (policy) => {
  if (!policy) return { add: [], remove: [] };
  const add = [];
  if (policy.summaryConfirmation === 'required' || policy.summaryConfirmation === 'if-present') {
    add.push('confirm_summary');
  }
  if (policy.planApproval === 'required') add.push('request_plan_approval');
  return { add, remove: policy.learnings === 'off' ? LEARNING_TOOLS : [] };
};

export const toolsForRole = (role, stageId = null, policy = null) => {
  if (role === 'reader') return READ_TOOLS;
  if (role === 'reviewer') return REVIEWER_TOOLS;
  const base =
    stageId === 'workspace-detection'
      ? [...AUTHOR_TOOLS, ...WORKSPACE_DETECTION_TOOLS]
      : AUTHOR_TOOLS;
  const { add, remove } = policyTools(policy);
  return [...base.filter((name) => !remove.includes(name)), ...add];
};

// The handler subset for a given role. `reader` → read-only; `reviewer` adds
// review verdict/metrics; `author` → all.
export const handlersForRole = (allHandlers, role, stageId = null, policy = null) => {
  const names = toolsForRole(role, stageId, policy);
  return Object.fromEntries(names.map((n) => [n, allHandlers[n]]));
};

// Tool descriptions + zod arg shapes are attached in startMcpServer (where the
// SDK + zod are present). Kept here as a single source so the catalog is
// assertable and registration stays a thin loop.
export const toolSchemas = (z) => ({
  get_artifact: {
    description:
      'Fetch one business artifact by id. Use mode "toc" or "summary" to avoid loading full markdown unless needed.',
    shape: { id: z.string(), mode: z.enum(['full', 'summary', 'toc']).optional() },
  },
  lookup_artifacts: {
    description:
      'List existing artifacts of a given type in this intent as compact metadata (incl. summary_gist/summary_claims when enriched), without full markdown content.',
    shape: { artifactType: z.string() },
  },
  get_intent_graph: {
    description:
      'Snapshot every artifact in this intent (id, type, title, and summary_gist/summary_claims when enriched) to orient before working — often enough context without any full read.',
    shape: {},
  },
  get_artifact_neighbors: {
    description:
      'Artifacts directly linked to a given artifact, optionally by edge + direction. Returns compact metadata, not full markdown.',
    shape: {
      id: z.string(),
      edge: z.enum(['PRODUCES', 'CONSUMES', 'DERIVED_FROM', 'RELATES_TO', 'DEPENDS_ON']).optional(),
      direction: z.enum(['in', 'out', 'both']).optional(),
    },
  },
  get_artifact_toc: {
    description:
      'List derived markdown sections for one artifact as compact metadata (heading, slug, order, content length).',
    shape: { id: z.string() },
  },
  get_section: {
    description: 'Fetch one derived markdown section by artifact id and heading or slug.',
    shape: { artifactId: z.string(), heading: z.string().optional(), slug: z.string().optional() },
  },
  get_items: {
    description:
      'List derived typed items in this intent, optionally filtered by item label (Story, Requirement, Component, etc.) and artifact type.',
    shape: {
      itemType: z.string().optional(),
      artifactType: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  search_graph: {
    description:
      'Substring search across this intent’s artifacts (title/content/type + enrichment summaries), returning compact metadata and snippets.',
    shape: {
      query: z.string(),
      artifactType: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  get_coverage: {
    description:
      'One-call coverage report over the typed graph items: requirements uncovered by stories (incl. must-haves), stories unmapped to units, unknown references. Pass unitSlug for one lane’s stories + contracts.',
    shape: { unitSlug: z.string().optional() },
  },
  get_team_knowledge: {
    description:
      "Read the PROJECT's accrued team knowledge — durable learnings from prior intents in this project (conventions, decisions, gotchas). Shared across all intents. Optionally narrow to one agent (the 'shared' corpus is always included). The relevant entries are also injected into your prompt; use this to re-read or pull another agent's corpus.",
    shape: { agentRef: z.string().optional() },
  },
  get_learning_rules: {
    description:
      "Read the PROJECT's accrued learning rules — guardrails (ALWAYS/NEVER conventions) prior intents recorded. These already steer you: they are merged into your resolved rules at their layer's precedence. Use this to see them explicitly.",
    shape: {},
  },
  create_artifact: {
    description:
      'Record a business artifact this stage produces. artifactType is the v2 artifact name (e.g. "requirements-analysis"). Output NOT written through a tool is discarded.',
    shape: {
      artifactType: z.string(),
      id: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      props: z.record(z.string(), z.string()).optional(),
      links: z
        .array(
          z.object({
            toId: z.string(),
            edge: z.enum(['PRODUCES', 'CONSUMES', 'DERIVED_FROM', 'RELATES_TO', 'DEPENDS_ON']),
          }),
        )
        .optional(),
    },
  },
  update_artifact: {
    description:
      'Update mutable properties on an existing artifact (never its id/type/provenance).',
    shape: { id: z.string(), props: z.record(z.string(), z.string()) },
  },
  link_artifacts: {
    description: 'Create a typed edge between two existing artifacts.',
    shape: {
      fromId: z.string(),
      toId: z.string(),
      edge: z.enum(['PRODUCES', 'CONSUMES', 'DERIVED_FROM', 'RELATES_TO', 'DEPENDS_ON']),
    },
  },
  record_team_knowledge: {
    description:
      "Record a durable learning for the PROJECT — a reusable convention, decision, constraint, or gotcha that should steer FUTURE intents (not a per-intent output; use create_artifact for those). Shared across every intent in this project. Use a stable kebab-case id so a later run updates the same entry instead of duplicating it. agentRef scopes it to one agent's corpus, or 'shared' for cross-cutting knowledge.",
    shape: {
      id: z.string(),
      title: z.string().optional(),
      content: z.string(),
      agentRef: z.string().optional(),
      props: z.record(z.string(), z.string()).optional(),
    },
  },
  record_learning_rule: {
    description:
      "Record a durable GUARDRAIL for the project — a binding ALWAYS/NEVER convention that should constrain FUTURE intents (e.g. 'NEVER store secrets in plaintext config'). Unlike record_team_knowledge (reference prose the agent reads), a learning rule enters the rule-resolution stack at its layer's precedence and overrides broader layers. Use a stable kebab-case id so a later run updates it. layer: 'team-learnings' for a broad convention, 'project-learnings' for a specific binding constraint that should win.",
    shape: {
      id: z.string(),
      title: z.string().optional(),
      content: z.string(),
      layer: z.enum(['team-learnings', 'project-learnings']).optional(),
      pairing: z.string().optional(),
    },
  },
  ask_question: {
    description:
      'Ask the human team one or more structured questions. Use for ambiguous requirements or decisions you cannot make alone. Returns EITHER the answer inline (if the human responds quickly) OR { parked: true } — when parked, STOP IMMEDIATELY: end your turn with no further tool calls (do not send_output or summarize). You will be resumed with the answer and can continue then.',
    shape: {
      questions: z.array(
        z.object({
          text: z.string(),
          type: z.enum(['single', 'multi']),
          options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
        }),
      ),
    },
  },
  confirm_summary: {
    description:
      'Raise the ONE consolidated confirmation checkpoint for this stage. Render every decision ' +
      'you are about to commit as bullets in `summary`. The human answers exactly ' +
      '"Looks correct" or "Request changes". You MUST call this and receive "Looks correct" ' +
      'BEFORE you create or update any stage output artifact. On "Request changes" you receive ' +
      'the requested change, revise, and call this again. Returns EITHER the decision inline OR ' +
      '{ parked: true } — when parked, STOP IMMEDIATELY: end your turn with no further tool ' +
      'calls; you will be resumed with the decision.',
    shape: { summary: z.string(), decisions: z.array(z.string()).optional() },
  },
  request_plan_approval: {
    description:
      'Present your implementation plan and how to test it, and wait for approval BEFORE you ' +
      'write any code. The human answers exactly "Approve plan" or "Request changes". The ' +
      'normal platform completion path checks for the recorded approval before it proceeds; ' +
      'this workflow check does not constrain direct writes made with the container credentials. ' +
      'On "Request ' +
      'changes" you receive the requested change, revise the plan, and call this again. Returns ' +
      'EITHER the decision inline OR { parked: true } — when parked, STOP IMMEDIATELY: end your ' +
      'turn with no further tool calls; you will be resumed with the decision.',
    shape: { plan: z.string(), testInstructions: z.string() },
  },
  send_output: {
    description:
      'Stream a unit of human-facing output (markdown) to the UI. Persisted so it survives a page reload.',
    shape: { content: z.string(), kind: z.enum(['text', 'thought', 'tool']).optional() },
  },
  record_project_type: {
    description:
      'Workspace Detection only: persist the deterministic workspace classification for later stages and native exports.',
    shape: { projectType: z.enum(['greenfield', 'brownfield']) },
  },
  collect_metric: {
    description:
      'Record a numeric metric sample (e.g. tokensInput, tokensOutput, contextWindowPct).',
    shape: { metrics: z.record(z.string(), z.number()) },
  },
  submit_review: {
    description:
      'Reviewer-only: submit your clean-room stage review verdict. Use READY only when the stage artifacts satisfy the stage definition and constraints; use NOT-READY with concrete findings when the builder must revise. Pass your agent name as `reviewer` and start `findings` with the identity marker line `**Reviewer:** <your-agent-name>`.',
    shape: {
      reviewer: z.string().optional(),
      verdict: z.enum(['READY', 'NOT-READY']),
      findings: z.string().optional(),
      round: z.number().optional(),
    },
  },
  emit_stage_note: {
    description: 'Append a short process/progress note to the execution audit trail.',
    shape: { summary: z.string(), type: z.string().optional() },
  },
});

// Wrap a tool handler with a one-line stderr trace. stdout is reserved
// exclusively for the StdioServerTransport JSON-RPC stream. Records the call,
// its arg keys, latency, error flag, and — critically — the RESULT envelope
// size, so an oversized tool_result that wedges the CLI's next model turn is
// visible without guessing. Tracing is on by default; set V2_MCP_TRACE=off to
// silence. Never throws (best-effort).
const traceHandler = (name, fn, { enabled }) => {
  if (!enabled) return fn;
  return async (args) => {
    const startedAt = Date.now();
    try {
      const env = await fn(args);
      const bytes = envelopeTextBytes(env);
      console.error(
        `[mcp-trace] ${name} ok=${!env?.isError} bytes=${bytes} ms=${Date.now() - startedAt} args=${Object.keys(args ?? {}).join(',')}`,
      );
      return env;
    } catch (e) {
      console.error(`[mcp-trace] ${name} threw ms=${Date.now() - startedAt} err=${e?.message}`);
      throw e;
    }
  };
};

// Register the role-appropriate tools on an McpServer. Pure of transport so it
// is unit-testable with a fake server that records registrations. Each handler
// is wrapped in a stderr trace (see traceHandler) unless env disables it.
export const registerTools = ({
  server,
  handlers,
  role,
  stageId = null,
  policy = null,
  z,
  env = process.env,
}) => {
  const schemas = toolSchemas(z);
  const names = toolsForRole(role, stageId, policy);
  const enabled = env.V2_MCP_TRACE !== 'off';
  for (const name of names) {
    const { description, shape } = schemas[name];
    const handler = traceHandler(name, (args) => handlers[name](args ?? {}), { enabled });
    server.tool(name, description, shape, (args) => handler(args ?? {}));
  }
  return names;
};
