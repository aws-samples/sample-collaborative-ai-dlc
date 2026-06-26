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

// The full author tool surface (a main stage agent). Reviewer runs get the
// READ_TOOLS subset only (see reviewerHandlers).
export const buildToolHandlers = ({ writer, bridge }) => ({
  // ── Business reads ──
  get_artifact: ({ id }) => guard(() => writer.getArtifact({ id })),
  lookup_artifacts: ({ artifactType }) => guard(() => writer.lookupArtifacts({ artifactType })),
  get_intent_graph: () => guard(() => writer.getIntentGraph()),
  get_artifact_neighbors: ({ id, edge, direction }) =>
    guard(() => writer.getNeighbors({ id, edge: edge ?? null, direction: direction ?? 'both' })),
  search_graph: ({ query, artifactType, limit }) =>
    guard(() =>
      writer.searchGraph({ query, artifactType: artifactType ?? null, limit: limit ?? 25 }),
    ),
  get_team_knowledge: ({ agentRef }) =>
    guard(() => writer.getTeamKnowledge({ agentRef: agentRef ?? null })),

  // ── Business writes ──
  create_artifact: ({ artifactType, id, title, content, props, links }) =>
    guard(() =>
      writer.createArtifact({ artifactType, id, title, content, props, links: links ?? [] }),
    ),
  update_artifact: ({ id, props }) =>
    guard(() => writer.updateArtifact({ id, props: props ?? {} })),
  link_artifacts: ({ fromId, toId, edge }) =>
    guard(() => writer.linkArtifacts({ fromId, toId, edge })),
  record_team_knowledge: ({ id, title, content, agentRef, props }) =>
    guard(() =>
      writer.recordTeamKnowledge({ id, title, content, agentRef: agentRef ?? 'shared', props }),
    ),

  // ── Collaboration / process ──
  ask_question: ({ questions }) => guard(() => bridge.askQuestion({ questions })),
  send_output: ({ content, kind }) =>
    guard(() => bridge.sendOutput({ content, kind: kind ?? 'text' })),
  collect_metric: ({ metrics }) => guard(() => bridge.collectMetric({ metrics })),
  emit_stage_note: ({ summary, type }) => guard(() => bridge.emitStageNote({ summary, type })),
});

// Read-only tool names a clean-room reviewer may call. No writes, no questions —
// a reviewer inspects and judges; it never mutates the graph or asks the human.
export const READ_TOOLS = [
  'get_artifact',
  'lookup_artifacts',
  'get_intent_graph',
  'get_artifact_neighbors',
  'search_graph',
  'get_team_knowledge',
];

// All author tool names.
export const AUTHOR_TOOLS = [
  ...READ_TOOLS,
  'create_artifact',
  'update_artifact',
  'link_artifacts',
  'record_team_knowledge',
  'ask_question',
  'send_output',
  'collect_metric',
  'emit_stage_note',
];

// The handler subset for a given role. `reviewer` → read-only; `author` → all.
export const handlersForRole = (allHandlers, role) => {
  const names = role === 'reviewer' ? READ_TOOLS : AUTHOR_TOOLS;
  return Object.fromEntries(names.map((n) => [n, allHandlers[n]]));
};

// Tool descriptions + zod arg shapes are attached in startMcpServer (where the
// SDK + zod are present). Kept here as a single source so the catalog is
// assertable and registration stays a thin loop.
export const toolSchemas = (z) => ({
  get_artifact: {
    description: 'Fetch one business artifact by id (its full properties).',
    shape: { id: z.string() },
  },
  lookup_artifacts: {
    description:
      'List existing artifacts of a given type in this intent (e.g. all "requirements-analysis").',
    shape: { artifactType: z.string() },
  },
  get_intent_graph: {
    description:
      'Snapshot every artifact in this intent (id, type, title) to orient before working.',
    shape: {},
  },
  get_artifact_neighbors: {
    description: 'Artifacts directly linked to a given artifact, optionally by edge + direction.',
    shape: {
      id: z.string(),
      edge: z.enum(['PRODUCES', 'CONSUMES', 'DERIVED_FROM', 'RELATES_TO', 'DEPENDS_ON']).optional(),
      direction: z.enum(['in', 'out', 'both']).optional(),
    },
  },
  search_graph: {
    description:
      'Substring search across this intent’s artifacts (title/content/type), optionally one type.',
    shape: {
      query: z.string(),
      artifactType: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  get_team_knowledge: {
    description:
      "Read the PROJECT's accrued team knowledge — durable learnings from prior intents in this project (conventions, decisions, gotchas). Shared across all intents. Optionally narrow to one agent (the 'shared' corpus is always included). The relevant entries are also injected into your prompt; use this to re-read or pull another agent's corpus.",
    shape: { agentRef: z.string().optional() },
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
  ask_question: {
    description:
      'Ask the human team one or more structured questions. BLOCKS until answered. Use for ambiguous requirements or decisions you cannot make alone.',
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
  send_output: {
    description:
      'Stream a unit of human-facing output (markdown) to the UI. Persisted so it survives a page reload.',
    shape: { content: z.string(), kind: z.enum(['text', 'thought', 'tool']).optional() },
  },
  collect_metric: {
    description:
      'Record a numeric metric sample (e.g. tokensInput, tokensOutput, contextWindowPct).',
    shape: { metrics: z.record(z.string(), z.number()) },
  },
  emit_stage_note: {
    description: 'Append a short process/progress note to the execution audit trail.',
    shape: { summary: z.string(), type: z.string().optional() },
  },
});

// Register the role-appropriate tools on an McpServer. Pure of transport so it
// is unit-testable with a fake server that records registrations.
export const registerTools = ({ server, handlers, role, z }) => {
  const schemas = toolSchemas(z);
  const names = role === 'reviewer' ? READ_TOOLS : AUTHOR_TOOLS;
  for (const name of names) {
    const { description, shape } = schemas[name];
    server.tool(name, description, shape, (args) => handlers[name](args ?? {}));
  }
  return names;
};
