// ensemble-runner — run a stage's authored persona topology as REAL separate
// sessions, with each persona receiving a separately constructed brief.
//
// The invariant is not concurrency, it is **who sees whose work**. One session
// cannot have that invariant at all: a
// single agent playing every persona sees everything it has already written. So
// each persona gets its own CLI session through `dispatchPersona`
// (persona-dispatch.js) with its OWN brief — and a support's brief is where the
// blindness lives, because it is the only stage context that session receives.
//
// Three topologies, all sequential. When parallel dispatch is unavailable,
// supports run serially with unchanged briefs; blindness is preserved:
//
//   subagent + N supports   lead draft (already ran) → N blind supports → lead
//                           integration. N + 2 sessions.
//   mob + N supports        the same, plus dissent triage on maintained OBJECT
//                           positions, hard-capped at MAX_DISSENT_ROUNDS.
//   pipeline (N supports)   N + 1 ordered links; link k sees every upstream
//                           link's work and edits the evolving artifacts
//                           directly; stage-output changes are its evidence.
//
// A support's contribution is a `contribution` artifact written through the
// generic `create_artifact`
// tool plus a `persona-contribution` receipt; a pipeline link's completion is a
// `pipeline-link` receipt carrying its ordinal. Receipts are attempt-scoped, so
// a rewind bumps `attempt` on the STAGE row and every prior receipt becomes
// invisible, while a park/resume within one attempt skips personas that already ran.
//
// FAILURE NEVER BLOCKS. A persona session that produces no
// evidence is retried once with a reduced brief (no knowledge block, artifact
// names instead of bodies). Still nothing: a
// `contribution` stub with `props.status = 'gap'` is recorded, `v2.persona.gap`
// is emitted, and the run CONTINUES. Every gap reaches the human as an advisory
// finding at the validation gate, where the decision already lives. The whole
// module is written so ANY unexpected error degrades to a gap: these stages
// already run successfully under the single-session approximation, and a
// regression here would block real intents.

import { dispatchPersona } from './persona-dispatch.js';
import { neutralizeTokens } from './stage-materializer.js';
import { evaluateGatePreconditions } from '../shared/gate-preconditions.js';
import { contributionArtifactId } from '../shared/ensemble-contribution.js';

export { contributionArtifactId };

// The stage modes that get real per-persona sessions. `pipeline` and `mob` have
// separate support sessions; `subagent` does only when it declares supports. A
// lead-only `subagent` remains one session like `inline`.
export const SESSION_ENSEMBLE_MODES = Object.freeze(['pipeline', 'mob', 'subagent']);

// The closure's protocol file distinguishes delegated single-session subagents
// from hub-and-spoke support sessions without relying on a release version.
export const ENSEMBLE_PROTOCOL_FILE = 'core/aidlc-common/protocols/stage-protocol-ensemble.md';

const subagentIsHubAndSpoke = (library) => {
  const paths = library?.runtimeFilePaths;
  // A library that carries no runtime-file list cannot say; only a release
  // closure is ever resolved here, and the resolver always stamps the list.
  if (paths == null) return true;
  return Array.isArray(paths)
    ? paths.includes(ENSEMBLE_PROTOCOL_FILE)
    : typeof paths.has === 'function' && paths.has(ENSEMBLE_PROTOCOL_FILE);
};

// Every cap is enforced on PERSISTED state, never an in-memory counter a resume
// would silently reset.
export const MAX_DISSENT_ROUNDS = 2;
export const MAX_PERSONA_ATTEMPTS = 2;
// Fan-out ceiling. An authored topology is library data, so "N supports" is
// whatever the release declares — and N sequential CLI sessions is N × a stage's
// worth of wall-clock and tokens. The cap is on the TOPOLOGY (resolution time),
// so the extras are known by name and reach the human as gaps instead of being
// silently dropped.
export const MAX_SUPPORT_PERSONAS = 6;
// Per-session wall clock. The child runner sends SIGKILL at the limit and waits
// for the child to close before a retry or gate gap can proceed.
export const MAX_PERSONA_SESSION_MS = 45 * 60 * 1000;
// Aggregate wall clock for everything ONE stage runs in its container: the lead,
// up to MAX_SUPPORT_PERSONAS supports (each up to MAX_PERSONA_SESSION_MS, retried
// once), the integrator, mob dissent rounds, pipeline links, and the reviewer
// loop's lead repair turns. Per-session caps alone multiply past the AgentCore
// runtime's max_lifetime (28800 s, terraform/modules/compute/agentcore), which
// kills the container and loses every persona after the kill. 6.5 h leaves the
// last 1.5 h for the engine commit, sensors and the gate hand-off. Measured from
// the stage attempt's start in this invocation (run-stage computes the deadline);
// every dispatch past it degrades to a GAP the human reads, and a budget that cut
// every collaborator blocks the gate overridably.
export const STAGE_BUDGET_MS = 6.5 * 60 * 60 * 1000;
const BUDGET_GAP_REASON = 'stage wall-clock budget exhausted before this session could run';

// A receipt SK offers exactly one discriminator per (kind, stage, attempt, unit):
// the ordinal. So it encodes (round, position) in one integer — round 1 uses
// 1..N, a dissent-triage round R uses (R-1)*BASE + position. "How many dissent
// rounds has this attempt already spent" is then readable straight off the
// persisted receipts, which is what survives a park/resume.
const DISSENT_ORDINAL_BASE = 1000;
const contributionOrdinal = ({ round, position }) => (round - 1) * DISSENT_ORDINAL_BASE + position;
const roundOfOrdinal = (ordinal) => Math.floor(Number(ordinal ?? 0) / DISSENT_ORDINAL_BASE) + 1;

// Read the `## Positions` section structurally (heading to next heading); a lazy
// multiline match can silently turn an objection into "no dissent".
const positionsSection = (content) => {
  const lines = String(content).split('\n');
  const start = lines.findIndex((line) => /^##\s+Positions\s*$/i.test(line));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

// `props.positions` (the structured form this runtime asks for) wins; the
// markdown `## Positions` section is the fallback for agents that only write it.
// An OBJECT's optional
// class marker — `OBJECT (judgment): …` — picks the triage route in `mob`;
// unlabelled objections default to `knowledge`, the bounded machine path, rather
// than to a human turn nobody asked for.
export const parsePositions = (row) => {
  const raw =
    typeof row?.positions === 'string' && row.positions.trim()
      ? row.positions
      : positionsSection(String(row?.content ?? ''));
  const positions = [];
  for (const line of raw.split('\n')) {
    const match = /^\s*(?:[-*]\s*)?(AGREE|OBJECT)\s*(?:\(([^)]*)\))?\s*:\s*(.+)$/i.exec(line);
    if (!match) continue;
    const stance = match[1].toUpperCase();
    const label = (match[2] ?? '').trim().toLowerCase();
    positions.push({
      stance,
      class: stance === 'OBJECT' ? (label === 'judgment' ? 'judgment' : 'knowledge') : null,
      text: match[3].trim(),
    });
  }
  return positions;
};

// The server-owned collaborator identity must match the persona being checked;
// otherwise one support could satisfy the whole mob. A gap stub is visible to the
// human but does not discharge the contribution obligation.
const isContributionEvidence = (row, agentRef) =>
  String(row?.status ?? '') !== 'gap' && String(row?.collaborator ?? '').trim() === agentRef;

const contributionRowFor = (rows, { stageId, agentRef }) => {
  const id = contributionArtifactId({ stageId, agentRef });
  return (rows ?? []).find((candidate) => String(candidate?.id ?? '') === id) ?? null;
};

const contributionFor = (rows, { stageId, agentRef }) => {
  const row = contributionRowFor(rows, { stageId, agentRef });
  return row && isContributionEvidence(row, agentRef) ? row : null;
};

// ── Briefs ─────────────────────────────────────────────────────────────────
// PURE, and the whole blindness contract: a support's brief names the stage's own
// artifacts (read through the MCP tools) and NEVER a sibling's contribution id —
// asserted by test. The explicit read prohibition mirrors
// `renderReviewerReadScope` in run-stage.js, because serial dispatch means a
// sibling's contribution IS already in the graph when the next support runs, so
// "we did not mention it" is not on its own sufficient.

const artifactNames = (entries = []) =>
  entries.map((entry) => entry?.artifact ?? entry).filter(Boolean);

const stageHeader = ({ stage, unit }) => [
  `Stage: ${stage.stageId} (phase: ${stage.phase ?? 'unphased'})`,
  ...(unit?.slug ? [`Unit: ${unit.slug}${unit.kind ? ` (kind: ${unit.kind})` : ''}`] : []),
];

const positionLine = (position) =>
  `- ${position.stance}${position.class ? ` (${position.class})` : ''}: ${neutralizeTokens(
    position.text,
  )}`;

// Every contribution field that reaches ANOTHER session's prompt is agent-authored
// text, so it is neutralized on the way in — the same treatment peer positions,
// judgment dissent and the human's answer already get. A support that copied a
// `{{INVOKE}}` / `{{HARNESS_DIR}}` token into its positions must not hand the
// integrator an instruction to run a binary this runtime does not have.
const positionsInline = (positions = []) =>
  neutralizeTokens(positions.map((p) => `${p.stance}: ${p.text}`).join(' | '));

export const buildSupportBrief = ({
  stage,
  unit = null,
  agentRef,
  mode,
  round = 1,
  reduced = false,
  // Dissent triage only: later rounds receive the revised draft and peer positions.
  // Round 1 passes none, preserving mutual blindness.
  peerPositions = [],
}) => {
  const contributionId = contributionArtifactId({ stageId: stage.stageId, agentRef });
  const outputs = artifactNames(stage.outputArtifacts);
  const inputs = artifactNames(stage.inputArtifacts);
  return [
    `# ${mode === 'mob' ? 'Mob' : 'Hub-and-spoke'} contribution: ${stage.stageId}`,
    '',
    `You are ${agentRef}, one of several collaborators on this stage. The lead agent`,
    'has already drafted the stage outputs. Review that draft from YOUR perspective',
    'alone and record your contribution.',
    '',
    ...stageHeader({ stage, unit }),
    `Round: ${round}`,
    `Draft to review (read with get_artifact): ${outputs.join(', ') || 'none recorded'}`,
    ...(reduced ? [] : [`Stage inputs (read as needed): ${inputs.join(', ') || 'none'}`]),
    '',
    '## Read scope (you are reviewing blind)',
    '',
    'Other collaborators are reviewing the same draft in their own sessions, and you',
    'MUST NOT look at their work: do not read, list, or search for any artifact of',
    'type `contribution` other than your own. Your value here is an uninfluenced',
    'position.',
    '',
    '## What to record',
    '',
    `Call create_artifact ONCE with artifactType \`contribution\`, id \`${contributionId}\`,`,
    `and props \`{ "collaborator": "${agentRef}", "positions": "<one position per line>" }\`.`,
    'The content must be markdown in exactly this shape:',
    'The markdown collaborator line is display text only; evidence identity comes from',
    'the server-owned `collaborator` property stamped from your session identity.',
    '',
    '```markdown',
    `**Collaborator:** ${agentRef}`,
    '',
    '## Contribution',
    '',
    '<what your perspective adds, corrects, or deepens>',
    '',
    '## Positions',
    '',
    '- AGREE: <what you endorse>',
    '- OBJECT (knowledge): <a factual or technical disagreement you can argue from evidence>',
    '- OBJECT (judgment): <a trade-off only a human stakeholder can settle>',
    '```',
    '',
    'Label every OBJECT `knowledge` or `judgment`; an unlabelled objection is read',
    'as `knowledge`. Do NOT edit the stage outputs — the lead integrates.',
    ...(peerPositions.length
      ? [
          '',
          '## Peer positions on the revised draft',
          '',
          'Your objection survived the integration. Here is what your peers argued.',
          'Re-record your contribution: withdraw the objection, or restate it knowing',
          'these positions.',
          '',
          ...peerPositions.map(
            (peer) => `- **${peer.agentRef}**: ${positionsInline(peer.positions)}`,
          ),
        ]
      : []),
  ].join('\n');
};

export const buildLinkBrief = ({
  stage,
  unit = null,
  agentRef,
  ordinal,
  totalLinks,
  reduced = false,
  upstreamLinks = [],
}) =>
  [
    `# Pipeline link ${ordinal} of ${totalLinks}: ${stage.stageId}`,
    '',
    `You are ${agentRef}, link ${ordinal} in an ordered pipeline. Every link before`,
    'you has already worked this stage. You see all of their work and you ENRICH it —',
    'correct, deepen, or extend the evolving artifacts directly. Do not restate what',
    'is already there, and do not start over.',
    '',
    ...stageHeader({ stage, unit }),
    `Upstream links (completed, in order): ${upstreamLinks.join(' \u2192 ') || 'none'}`,
    `Artifacts to enrich (read with get_artifact, rewrite with create_artifact): ${
      artifactNames(stage.outputArtifacts).join(', ') || 'none recorded'
    }`,
    ...(reduced
      ? []
      : [
          `Stage inputs (read as needed): ${
            artifactNames(stage.inputArtifacts).join(', ') || 'none'
          }`,
        ]),
    '',
    'This pipeline writes NO contribution files: your output IS the updated',
    `artifacts${
      ordinal === totalLinks ? ', and you are the final link — leave them complete.' : '.'
    }`,
  ].join('\n');

export const buildIntegratorBrief = ({
  stage,
  unit = null,
  agentRef,
  contributions = [],
  judgmentDissent = [],
  resumeAnswer = null,
  // Whether this integration session is given ask_question. False once the
  // integrator's one question for the attempt is spent (answered or not), so the
  // brief must not tell it to ask: judgment calls are then recorded as dissent.
  mayAsk = true,
  reduced = false,
}) =>
  [
    `# Integration: ${stage.stageId}`,
    '',
    `You are ${agentRef}, the lead for this stage. Your collaborators reviewed your`,
    'draft independently. Integrate their contributions into ONE consolidated set of',
    'stage outputs — rewrite the artifacts with create_artifact so the integrated',
    'version is what the stage records.',
    '',
    ...stageHeader({ stage, unit }),
    `Artifacts to integrate into: ${
      artifactNames(stage.outputArtifacts).join(', ') || 'none recorded'
    }`,
    '',
    '## Contributions to integrate',
    '',
    ...(contributions.length
      ? contributions.flatMap((row) => [
          `### ${row.agentRef}`,
          '',
          ...(reduced
            ? [`Positions: ${positionsInline(row.positions) || 'none recorded'}`]
            : [
                `Read the full contribution with get_artifact on \`${row.artifactId}\`.`,
                'Positions:',
                ...row.positions.map(positionLine),
              ]),
          '',
        ])
      : [
          'No collaborator recorded a contribution. Integrate your own draft and say',
          'so plainly in the stage output.',
          '',
        ]),
    'Where you carry a position forward, say so. Where you do NOT, record the dissent',
    'in the output attributed to the collaborator that raised it — never silently',
    'pick a winner.',
    ...(judgmentDissent.length
      ? [
          '',
          '## Judgment calls for the human',
          '',
          ...(resumeAnswer
            ? ['These trade-offs were put to the human; the answer follows below.']
            : mayAsk
              ? [
                  'These objections are trade-offs only a human stakeholder can settle. Raise',
                  'ONE consolidated `ask_question` covering them, with concrete options, then',
                  'stop: the platform parks the stage and resumes this integration with the',
                  'answer.',
                ]
              : [
                  'These objections are trade-offs only a human stakeholder can settle. The',
                  "stage's one question to the human is already spent, so do NOT ask: record",
                  'each one as attributed dissent in the output for the human to settle at',
                  'the validation gate.',
                ]),
          '',
          ...judgmentDissent.map(
            (item) => `- **${item.agentRef}**: ${neutralizeTokens(item.position)}`,
          ),
        ]
      : []),
    ...(resumeAnswer
      ? [
          '',
          '## The human has already answered',
          '',
          neutralizeTokens(resumeAnswer),
          '',
          'Apply this answer. Do NOT ask it again.',
        ]
      : []),
  ].join('\n');

// The lead's own prompt tail when native sessions are active. It REPLACES the
// single-session ensemble protocol (`renderEnsembleProtocol`), which instructs one
// agent to play every persona — exactly what real sessions exist to stop.
export const renderLeadTopologyBrief = ({ mode, leadAgentRef, supports = [] }) => {
  const refs = supports.map((support) => support.ref).filter(Boolean);
  if (refs.length === 0) return '';
  const collaborators = refs.join(', ');
  return [
    `## Ensemble topology (stage mode: ${mode}, separate sessions)`,
    '',
    `This stage runs as **${mode}** across ${refs.length + 1} personas, each in its OWN`,
    `session with its own context. You are the lead (**${leadAgentRef ?? 'the assigned agent'}**).`,
    '',
    ...(mode === 'pipeline'
      ? [
          'You are link 1 of an ordered pipeline. Produce a complete first pass of the',
          'stage outputs. The links after you run in this order, each enriching what it',
          `receives: ${collaborators}.`,
        ]
      : [
          'Produce your DRAFT of the stage outputs now. These collaborators then review',
          `that draft independently, blind to each other: ${collaborators}. You will be`,
          're-invoked in a separate integration session once their contributions are in.',
        ]),
    '',
    'Do NOT role-play the other personas and do NOT write their contributions: they',
    'are real sessions and they record their own. Claiming a review that did not',
    'happen is a false record.',
  ].join('\n');
};

// ── Topology resolution ────────────────────────────────────────────────────

// The native topology for a stage, or null when the stage keeps today's
// single-session behaviour. Gated on release mode (the existing authored
// provenance gate — an unpinned or 2.3.3-era intent is untouched), on the
// `V2_ENSEMBLE_SESSIONS=off` escape hatch, and on at least one support persona
// resolving from the SAME library the stage came from.
export const resolveEnsembleTopology = async ({
  stage,
  library,
  loadBlockBody,
  methodologyRelease = null,
  env = {},
}) => {
  if (!methodologyRelease) return null;
  if (String(env.V2_ENSEMBLE_SESSIONS ?? '').toLowerCase() === 'off') return null;
  if (!SESSION_ENSEMBLE_MODES.includes(stage?.mode)) return null;
  if (stage.mode === 'subagent' && !subagentIsHubAndSpoke(library)) return null;
  const refs = (stage.supportAgentRefs ?? []).filter(
    (ref) => ref && ref !== stage.agentRef && library?.agentsById?.[ref],
  );
  if (refs.length === 0) return null;
  const admitted = refs.slice(0, MAX_SUPPORT_PERSONAS);
  const dropped = refs.slice(MAX_SUPPORT_PERSONAS);
  const supports = [];
  for (const ref of admitted) {
    const block = library.agentsById[ref];
    supports.push({
      ref,
      displayName: block.displayName ?? block.name ?? ref,
      block,
      persona: await loadBlockBody(block),
    });
  }
  return {
    mode: stage.mode,
    leadAgentRef: stage.agentRef ?? null,
    supports,
    // Over the fan-out cap: named here so `runEnsembleSessions` can gap them.
    dropped,
    // Pipeline links are the lead followed by supports in declared order.
    links: stage.mode === 'pipeline' ? [stage.agentRef, ...admitted].filter(Boolean) : [],
  };
};

// ── Orchestration ──────────────────────────────────────────────────────────

const emptyEvidence = (topology) => {
  const supports = Array.isArray(topology?.supports) ? topology.supports : [];
  const links = Array.isArray(topology?.links) ? topology.links : [];
  // A persona dropped by the fan-out cap is DECLARED but never dispatched, so it
  // is listed here in every mode: that is what turns it into the advisory
  // "produced no contribution" finding the human reads at the gate, instead of a
  // silently shorter topology.
  const dropped = Array.isArray(topology?.dropped) ? topology.dropped : [];
  return {
    mode: topology?.mode ?? null,
    supports:
      topology?.mode === 'pipeline' ? [...dropped] : [...supports.map((s) => s.ref), ...dropped],
    links,
    contributions: [],
    gaps: [],
    dissent: [],
    dissentRounds: 0,
  };
};

// Bound one dispatch. The loser of the race is abandoned, never awaited again, and
// the timer is always cleared so a finished session cannot hold the event loop.
const withSessionTimeout = (pending, timeoutMs) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return pending;
  let timer = null;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, detail: `session exceeded ${timeoutMs}ms` }),
      timeoutMs,
    );
    timer?.unref?.();
  });
  return Promise.race([pending, expiry]).finally(() => clearTimeout(timer));
};

// A link's / integrator's evidence is that the DECLARED STAGE OUTPUTS moved. There
// is no contribution file to inspect there, and a session that
// exited 0 having written nothing produced nothing — `true` would have recorded a
// completed link for a session that never touched the artifacts. The comparison is
// a fingerprint diff rather than a timestamp test so it needs no trusted clock: a
// new id, a new generation, a new updated_at or a changed body all read as a write.
const outputsFingerprint = (rows = []) =>
  JSON.stringify(
    (rows ?? [])
      .map((row) =>
        [
          row?.id ?? '',
          row?.artifact_type ?? '',
          row?.updated_at ?? '',
          row?.generation ?? '',
          row?.version_count ?? '',
          row?.contentLength ?? '',
          typeof row?.content === 'string' ? row.content.length : '',
        ]
          .map(String)
          .join('\u0000'),
      )
      .toSorted(),
  );

// Run the authored topology. NEVER throws and NEVER fails the stage: the return is
// always `{ ensembleEvidence, findings }`, and an unexpected error becomes a gap
// the human reads at the gate.
export const runEnsembleSessions = async ({
  topology,
  stage,
  unit = null,
  policy = null,
  personaScope = {},
  attempt = 0,
  resumeAnswer = null,
  lead = { persona: '', block: null },
  // Everything dispatchPersona needs that is identical for every persona in this
  // stage (cli, models, env, workspaceDir, spawnFn, mcpEntry, materializers, ids).
  dispatchContext = {},
  dispatch = dispatchPersona,
  knowledgeFor = async () => '',
  readContributions = async () => [],
  // The current rows of this stage's DECLARED OUTPUT artifacts. Injected like
  // readContributions, because "did this session write?" is a graph question and
  // an unobservable graph must read as "no evidence", never as a pass.
  readStageOutputs = async () => [],
  writeGapStub = async () => {},
  pendingGate = async () => null,
  store,
  publish = async () => {},
  executionId,
  projectId,
  intentId,
  stageInstanceId,
  unitSlug = null,
  sectionIndex = null,
  sessionTimeoutMs = MAX_PERSONA_SESSION_MS,
  // The stage's wall-clock deadline (epoch ms), or null for no aggregate bound.
  // Injected with the clock so the degradation is testable without real time.
  deadlineMs = null,
  nowMs = Date.now,
  logger = null,
}) => {
  const evidence = emptyEvidence(topology);
  const remainingMs = () =>
    Number.isFinite(deadlineMs) ? deadlineMs - nowMs() : Number.POSITIVE_INFINITY;
  // The sessions the budget cut, named so the gate can say which perspectives are
  // absent and why. Added only when non-empty, so an unbounded run's evidence
  // shape is unchanged.
  const recordBudgetCut = ({ agentRef, role }) => {
    const cut = evidence.budgetExhausted ?? [];
    if (cut.some((row) => row.agentRef === agentRef && row.role === role)) return;
    evidence.budgetExhausted = [...cut, { agentRef, role }];
  };

  const emit = async ({ type, actor, summary, detail }) => {
    try {
      await store?.appendEvent?.({
        executionId,
        type,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor,
        summary,
        detail,
      });
    } catch {
      /* the timeline write is best-effort; the receipt is the durable record */
    }
    await publish({
      action: 'agent.note',
      noteType: type,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      summary,
    });
  };

  const gap = async ({ agentRef, role, reason }) => {
    evidence.gaps.push({ agentRef, role, reason });
    if (role === 'support') {
      // A failed re-dispatch means there is no NEW evidence for that round; it
      // must not replace a real contribution from the previous round with a gap.
      const rows = await readContributions().catch(() => []);
      if (!contributionFor(rows, { stageId: stage.stageId, agentRef })) {
        await writeGapStub({ agentRef, reason }).catch(() => {});
      }
    }
    await emit({
      type: 'v2.persona.gap',
      actor: agentRef ?? 'agentcore',
      summary: `GAP — ${role} persona ${agentRef ?? '(unresolved)'} produced no evidence for ${
        stage.stageId
      }: ${reason}`,
      detail: { mode: topology.mode, role, agentRef: agentRef ?? null, reason, attempt },
    });
  };

  const receipt = async (row) => {
    if (typeof store?.putReceipt !== 'function') return null;
    return store
      .putReceipt({ executionId, stageInstanceId, attempt, unitSlug, sectionIndex, ...row })
      .catch(() => null);
  };

  // Defence in depth for a session that was never given ask_question (a support or
  // a pipeline link) but parked the stage anyway. Nothing will ever thread the
  // answer back into that persona — a resume re-dispatches it blind to it, and it
  // asks again — so the gate is retired (CAS on pending; the row stays as the
  // audit record), the stage is un-parked exactly as an inline answer un-parks it,
  // and the run CONTINUES. Returns whether a gate was withdrawn.
  const withdrawOrphanGate = async ({ agentRef, role }) => {
    const gate = await pendingGate().catch(() => null);
    if (!gate) return false;
    await store
      ?.supersedeHumanTask?.({
        executionId,
        humanTaskId: gate.humanTaskId,
        supersededBy: `persona-${role}:${agentRef ?? 'unknown'}`,
      })
      .catch(() => null);
    await store?.resumeStageRow?.({ executionId, stageInstanceId }).catch(() => {});
    if (!unitSlug) {
      await store
        ?.updateExecution?.({ executionId, status: 'RUNNING', pendingHumanTaskId: null })
        .catch(() => {});
    }
    await emit({
      type: 'v2.persona.question_withdrawn',
      actor: agentRef ?? 'agentcore',
      summary: `Withdrew a question ${role} persona ${agentRef ?? '(unresolved)'} raised on ${
        stage.stageId
      }: that session has no path for an answer back into it`,
      detail: {
        mode: topology.mode,
        role,
        agentRef: agentRef ?? null,
        humanTaskId: gate.humanTaskId,
        attempt,
      },
    });
    return true;
  };

  // Every dispatch goes through here: one retry with a REDUCED brief, then the
  // caller decides what "still nothing" means for its role. `snapshot` is taken
  // BEFORE each dispatch and handed to `verify`, so a role whose evidence is "the
  // artifacts moved" compares against state the session cannot have influenced.
  const runPersona = async ({
    role,
    agentRef,
    agentBlock,
    persona,
    brief,
    verify,
    snapshot = null,
    // Only a session whose answer is threaded back into it may ask the human.
    canAsk = false,
  }) => {
    for (let tryIndex = 1; tryIndex <= MAX_PERSONA_ATTEMPTS; tryIndex += 1) {
      // Checked before EVERY dispatch, retries included: a session is never
      // started past the stage deadline, and one that starts is clamped to what is
      // left of it, so the ensemble as a whole cannot outlive the container.
      const left = remainingMs();
      if (left <= 0) {
        recordBudgetCut({ agentRef, role });
        return { ok: false, verified: null, reason: BUDGET_GAP_REASON };
      }
      const reduced = tryIndex > 1;
      const baseline = snapshot ? await snapshot().catch(() => null) : null;
      const dispatchTimeoutMs = Math.min(sessionTimeoutMs, left);
      const dispatchArgs = {
        role,
        agentBlock,
        persona,
        // The reduced retry drops the knowledge block too.
        knowledge: reduced ? '' : await knowledgeFor(agentRef).catch(() => ''),
        brief: brief(reduced),
        personaScope: { ...personaScope, agentRef, canAsk },
        ...dispatchContext,
        executionId,
        projectId,
        intentId,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        ...(dispatch === dispatchPersona ? { timeoutMs: dispatchTimeoutMs } : {}),
      };
      const pending = dispatch(dispatchArgs);
      const result = await (
        dispatch === dispatchPersona ? pending : withSessionTimeout(pending, dispatchTimeoutMs)
      ).catch((error) => ({ ok: false, detail: error }));
      const verified = result.ok ? await verify(baseline).catch(() => null) : null;
      if (verified) return { ok: true, verified };
      logger?.error?.('persona session produced no evidence', {
        stage: stage.stageId,
        persona: agentRef,
        role,
        attemptOfTwo: tryIndex,
        msg: result.ok ? 'session exited cleanly without evidence' : String(result.detail ?? ''),
      });
    }
    if (remainingMs() <= 0) {
      recordBudgetCut({ agentRef, role });
      return { ok: false, verified: null, reason: BUDGET_GAP_REASON };
    }
    return { ok: false, verified: null };
  };

  try {
    for (const agentRef of topology.dropped ?? []) {
      await gap({
        agentRef,
        role: 'support',
        reason: `topology declares more than ${MAX_SUPPORT_PERSONAS} support personas; this one was not dispatched`,
      });
    }
    const priorReceipts =
      typeof store?.listReceipts === 'function'
        ? await store.listReceipts(executionId, { stageInstanceId, attempt }).catch(() => [])
        : [];
    const ordinalsOf = (kind) =>
      new Set(
        priorReceipts
          .filter((row) => row?.kind === kind)
          .map((row) => Number(row.ordinal))
          .filter((ordinal) => Number.isFinite(ordinal)),
      );
    if (topology.mode === 'pipeline') {
      for (const row of priorReceipts) {
        if (row?.kind !== 'pipeline-link' || row?.choice !== 'gap') continue;
        const ordinal = Number(row.ordinal ?? row.detail?.ordinal);
        const agentRef =
          row.detail?.agentRef ?? (Number.isFinite(ordinal) ? topology.links?.[ordinal - 1] : null);
        if (!agentRef || evidence.gaps.some((gapRow) => gapRow.agentRef === agentRef)) continue;
        evidence.gaps.push({
          agentRef,
          role: 'link',
          reason: row.detail?.reason ?? 'pipeline link previously produced no evidence',
        });
      }
    }
    const stageOutputsFingerprint = async () =>
      outputsFingerprint(await readStageOutputs().catch(() => []));
    // Shared by link and integrator: the session counts only when the declared
    // outputs differ from the pre-dispatch snapshot. A null baseline means the
    // graph could not be read at all, which is no evidence either.
    const wroteStageOutput = async (baseline) =>
      baseline !== null && (await stageOutputsFingerprint()) !== baseline ? { wrote: true } : null;
    const context = {
      topology,
      stage,
      unit,
      attempt,
      evidence,
      runPersona,
      receipt,
      emit,
      gap,
      pendingGate,
      withdrawOrphanGate,
      stageOutputsFingerprint,
      wroteStageOutput,
    };
    if (topology.mode === 'pipeline') {
      await runPipeline({ ...context, completed: ordinalsOf('pipeline-link') });
    } else {
      await runHubAndSpoke({
        ...context,
        completed: ordinalsOf('persona-contribution'),
        priorReceipts,
        readContributions,
        resumeAnswer,
        lead,
      });
    }
  } catch (error) {
    // The conservative floor: an orchestration surprise degrades to a gap the
    // human sees, never to a failed stage.
    logger?.error?.('ensemble orchestration degraded', {
      stage: stage.stageId,
      mode: topology.mode,
      msg: error?.message ?? String(error),
    });
    await gap({
      agentRef: topology.leadAgentRef,
      role: 'ensemble',
      reason: `orchestration error: ${error?.message ?? String(error)}`,
    });
  }

  return {
    ensembleEvidence: evidence,
    findings: findingsFor({ stage, policy, attempt, evidence }),
  };
};

// `pipeline`: N+1 ordered links, link 1 being the lead session run-stage already
// completed. Completed links of the CURRENT attempt are skipped, so a park/resume
// resumes the chain instead of re-dispatching it; a rewind bumps `attempt`, every
// receipt disappears, and the whole chain re-runs in declared order.
const runPipeline = async ({
  topology,
  stage,
  unit,
  attempt,
  completed,
  runPersona,
  receipt,
  emit,
  gap,
  withdrawOrphanGate,
  stageOutputsFingerprint,
  wroteStageOutput,
}) => {
  const links = topology.links;
  const upstreamLinks = [];
  for (const [index, agentRef] of links.entries()) {
    const ordinal = index + 1;
    if (completed.has(ordinal)) {
      upstreamLinks.push(agentRef);
      continue;
    }
    const support = topology.supports.find((candidate) => candidate.ref === agentRef);
    // Link 1 IS the lead session run-stage already ran: it needs its receipt, not
    // a second dispatch.
    const outcome =
      ordinal === 1
        ? { ok: true, verified: true }
        : await runPersona({
            role: 'link',
            agentRef,
            agentBlock: support?.block ?? null,
            persona: support?.persona ?? '',
            brief: (reduced) =>
              buildLinkBrief({
                stage,
                unit,
                agentRef,
                ordinal,
                totalLinks: links.length,
                upstreamLinks: [...upstreamLinks],
                reduced,
              }),
            // A child-process return is not a write: this link completed only if the stage
            // outputs it was told to enrich actually moved.
            snapshot: stageOutputsFingerprint,
            verify: wroteStageOutput,
          });
    const gapReason = outcome.ok ? null : (outcome.reason ?? 'link session produced no evidence');
    // Written for a gap too (`choice: 'gap'`) so a resume advances past a link
    // that already burned its retry instead of looping on it; the gap itself is
    // what reaches the gate, via findingsFor below.
    await receipt({
      kind: 'pipeline-link',
      ordinal,
      choice: outcome.ok ? 'completed' : 'gap',
      detail: {
        mode: 'pipeline',
        agentRef,
        ordinal,
        totalLinks: links.length,
        attempt,
        ...(gapReason ? { reason: gapReason } : {}),
      },
    });
    if (outcome.ok) {
      upstreamLinks.push(agentRef);
      await emit({
        type: 'v2.persona.link_completed',
        actor: agentRef,
        summary: `Pipeline link ${ordinal}/${links.length} completed by ${agentRef} on ${stage.stageId}`,
        detail: { mode: 'pipeline', ordinal, agentRef, totalLinks: links.length, attempt },
      });
    } else {
      await gap({
        agentRef,
        role: 'link',
        reason: gapReason,
      });
    }
    // A link has no ask_question; a gate it somehow left is an orphan, not a park.
    if (ordinal > 1) await withdrawOrphanGate({ agentRef, role: 'link' });
  }
};

// `subagent` with supports and `mob`: blind supports, lead integration, then
// (mob only) dissent triage bounded by MAX_DISSENT_ROUNDS.
const runHubAndSpoke = async ({
  topology,
  stage,
  unit,
  attempt,
  evidence,
  completed,
  priorReceipts,
  runPersona,
  receipt,
  emit,
  gap,
  pendingGate,
  withdrawOrphanGate,
  readContributions,
  resumeAnswer,
  lead,
  stageOutputsFingerprint,
  wroteStageOutput,
}) => {
  // The dissent-round counter, read off PERSISTED receipts so a resume cannot
  // hand the mob a fresh budget.
  let round = Math.max(
    1,
    ...priorReceipts
      .filter((row) => row?.kind === 'persona-contribution')
      .map((row) => roundOfOrdinal(row.ordinal)),
  );
  evidence.dissentRounds = round;
  // The integrator gets ONE question per attempt, read off the persisted receipt
  // so a resume cannot re-arm it. Its presence is also what makes `resumeAnswer`
  // the integrator's answer: without it, the answer a resumed leg carries was the
  // LEAD's (the lead parked, the ensemble was deferred), which the lead's own
  // resumed conversation already applied.
  let integratorAsked = priorReceipts.some((row) => row?.kind === 'integrator-question');
  const integratorAnswer = integratorAsked ? resumeAnswer : null;

  const collect = async () => {
    const rows = await readContributions().catch(() => []);
    return topology.supports
      .map((support) => {
        const row = contributionFor(rows, { stageId: stage.stageId, agentRef: support.ref });
        return row
          ? { agentRef: support.ref, artifactId: String(row.id), positions: parsePositions(row) }
          : null;
      })
      .filter(Boolean);
  };
  const objections = () =>
    evidence.contributions.flatMap((row) =>
      row.positions
        .filter((position) => position.stance === 'OBJECT')
        .map((position) => ({
          agentRef: row.agentRef,
          stance: position.stance,
          class: position.class,
          // `position` is the field `evaluateGatePreconditions` quotes verbatim
          // into the gate finding.
          position: position.text,
        })),
    );

  // Returns true when the integrator raised its question and the stage must park.
  const integrate = async (judgmentDissent) => {
    const mayAsk = !integratorAsked && judgmentDissent.length > 0;
    const outcome = await runPersona({
      role: 'integrator',
      agentRef: topology.leadAgentRef,
      agentBlock: lead.block,
      persona: lead.persona,
      brief: (reduced) =>
        buildIntegratorBrief({
          stage,
          unit,
          agentRef: topology.leadAgentRef,
          contributions: evidence.contributions,
          judgmentDissent,
          resumeAnswer: integratorAnswer,
          mayAsk,
          reduced,
        }),
      // The integration IS a rewrite of the stage outputs, so nothing moving means
      // nothing was integrated — the contributions would silently go nowhere.
      snapshot: stageOutputsFingerprint,
      verify: wroteStageOutput,
      canAsk: mayAsk,
    });
    if (!outcome.ok) {
      await gap({
        agentRef: topology.leadAgentRef,
        role: 'integrator',
        reason: outcome.reason ?? 'integration session produced no evidence',
      });
    }
    if (!mayAsk) {
      await withdrawOrphanGate({ agentRef: topology.leadAgentRef, role: 'integrator' });
      return false;
    }
    const gate = await pendingGate().catch(() => null);
    if (!gate) return false;
    integratorAsked = true;
    await receipt({
      kind: 'integrator-question',
      ordinal: 1,
      choice: 'asked',
      humanTaskId: gate.humanTaskId ?? null,
      detail: { mode: topology.mode, round, agentRef: topology.leadAgentRef, attempt },
    });
    return true;
  };

  await dispatchSupports({
    topology,
    stage,
    unit,
    attempt,
    round,
    targets: topology.supports,
    completed,
    runPersona,
    receipt,
    emit,
    gap,
    withdrawOrphanGate,
    readContributions,
  });
  evidence.contributions = await collect();

  for (;;) {
    const open = objections();
    if (await integrate(open.filter((item) => item.class === 'judgment'))) {
      // The integrator raised the judgment calls as one question and the stage is
      // about to park. Maintained objections are recorded anyway so the human
      // reading the gate sees them verbatim; the resumed leg re-integrates with
      // the answer and skips every support that already contributed.
      evidence.dissent = open;
      await recordDissent({ evidence, emit, stage, attempt, mode: topology.mode, round });
      return;
    }
    evidence.contributions = await collect();
    // Only `mob` triages dissent; `subagent` integrates once and stops.
    if (topology.mode !== 'mob') break;
    const maintained = objections().filter((item) => item.class === 'knowledge');
    if (maintained.length === 0 || round >= MAX_DISSENT_ROUNDS) break;
    round += 1;
    evidence.dissentRounds = round;
    await dispatchSupports({
      topology,
      stage,
      unit,
      attempt,
      round,
      targets: topology.supports.filter((support) =>
        maintained.some((item) => item.agentRef === support.ref),
      ),
      completed,
      runPersona,
      receipt,
      emit,
      gap,
      withdrawOrphanGate,
      readContributions,
      peerPositionsFor: (agentRef) =>
        evidence.contributions.filter((row) => row.agentRef !== agentRef),
    });
    evidence.contributions = await collect();
  }
  evidence.dissent = objections();
  await recordDissent({ evidence, emit, stage, attempt, mode: topology.mode, round });
};

const dispatchSupports = async ({
  topology,
  stage,
  unit,
  attempt,
  round,
  targets,
  completed,
  runPersona,
  receipt,
  emit,
  gap,
  withdrawOrphanGate,
  readContributions,
  peerPositionsFor = () => [],
}) => {
  for (const support of targets) {
    const position = topology.supports.findIndex((entry) => entry.ref === support.ref) + 1;
    const ordinal = contributionOrdinal({ round, position });
    if (completed.has(ordinal)) continue;
    const peerPositions = peerPositionsFor(support.ref);
    const outcome = await runPersona({
      role: 'support',
      agentRef: support.ref,
      agentBlock: support.block,
      persona: support.persona,
      brief: (reduced) =>
        buildSupportBrief({
          stage,
          unit,
          agentRef: support.ref,
          mode: topology.mode,
          round,
          peerPositions,
          reduced,
        }),
      snapshot: async () => {
        const rows = await readContributions().catch(() => null);
        if (!Array.isArray(rows)) return null;
        const row = contributionRowFor(rows, {
          stageId: stage.stageId,
          agentRef: support.ref,
        });
        return outputsFingerprint(row ? [row] : []);
      },
      // Artifacts alone never satisfy the evidence check, and a session that
      // exited 0 without writing its contribution produced nothing.
      // On a dissent re-dispatch, an unchanged round-one row is not evidence that
      // the support answered the round-two brief.
      verify: async (baseline) => {
        if (baseline === null) return null;
        const rows = await readContributions().catch(() => null);
        if (!Array.isArray(rows)) return null;
        const row = contributionRowFor(rows, {
          stageId: stage.stageId,
          agentRef: support.ref,
        });
        if (!isContributionEvidence(row, support.ref) || outputsFingerprint([row]) === baseline) {
          return null;
        }
        return {
          agentRef: support.ref,
          artifactId: String(row.id),
          positions: parsePositions(row),
        };
      },
    });
    if (outcome.ok) {
      completed.add(ordinal);
      await receipt({
        kind: 'persona-contribution',
        ordinal,
        choice: 'contributed',
        detail: {
          mode: topology.mode,
          agentRef: support.ref,
          round,
          artifactId: outcome.verified.artifactId,
          positions: outcome.verified.positions,
          attempt,
        },
      });
      await emit({
        type: 'v2.persona.contribution',
        actor: support.ref,
        summary: `${support.ref} contributed to ${stage.stageId} (round ${round}): ${
          outcome.verified.positions.map((p) => `${p.stance}: ${p.text}`).join(' | ') ||
          'no positions recorded'
        }`,
        detail: {
          mode: topology.mode,
          round,
          agentRef: support.ref,
          artifactId: outcome.verified.artifactId,
          positions: outcome.verified.positions,
          attempt,
        },
      });
    } else {
      // Deliberately NO receipt: the missing contribution must stay missing so
      // `evaluateGatePreconditions` names this persona at the gate.
      await gap({
        agentRef: support.ref,
        role: 'support',
        reason: outcome.reason ?? 'no contribution artifact after one reduced-brief retry',
      });
    }
    // A support has no ask_question; a gate it somehow left is an orphan, not a
    // park — withdraw it and keep going rather than park on a question nobody
    // can answer back into this session.
    await withdrawOrphanGate({ agentRef: support.ref, role: 'support' });
  }
};

const recordDissent = async ({ evidence, emit, stage, attempt, mode, round }) => {
  for (const item of evidence.dissent) {
    await emit({
      type: 'v2.persona.dissent',
      actor: item.agentRef,
      // Verbatim: a summarized objection is a different objection.
      summary: `Maintained dissent on ${stage.stageId} (${item.agentRef}, ${
        item.class ?? 'knowledge'
      }): ${item.position}`,
      detail: {
        mode,
        round,
        agentRef: item.agentRef,
        positions: [{ stance: item.stance, class: item.class, text: item.position }],
        attempt,
      },
    });
  }
};

// The codes this stream can raise. Everything else in the evaluator belongs to
// another stream and must not leak out of an ensemble run.
const ENSEMBLE_FINDING_CODES = new Set([
  'persona_contribution_missing',
  'pipeline_link_incomplete',
  'review_dissent_maintained',
  'stage_budget_exhausted',
]);

// The gate's view of this ensemble. Built by calling S0's evaluator with the
// evidence actually gathered rather than hand-rolling finding objects, so codes,
// severities and remediation text cannot drift from the ones the orchestrator
// produces when it re-reads the receipts before the gate opens (`mergeFindings`
// then dedupes the overlap on (code, detail)).
export const findingsFor = ({ stage, policy, attempt, evidence }) => {
  if (!policy) return [];
  const gapped = new Set(evidence.gaps.map((row) => row.agentRef));
  const receipts = [
    ...evidence.contributions.map((row) => ({
      kind: 'persona-contribution',
      attempt,
      detail: { agentRef: row.agentRef },
    })),
    // A gapped link holds a receipt so a resume advances past it, but it is NOT a
    // completed link — the gate must still hear that the chain broke.
    ...evidence.links
      .filter((agentRef) => !gapped.has(agentRef))
      .map((agentRef) => ({ kind: 'pipeline-link', attempt, detail: { agentRef } })),
  ];
  const { findings } = evaluateGatePreconditions({
    stage,
    policy,
    attempt,
    receipts,
    ensembleEvidence: evidence,
  });
  return findings.filter((item) => ENSEMBLE_FINDING_CODES.has(item.code));
};

// The gate's view of an ensemble that never produced evidence at all — the caller's
// last resort if `runEnsembleSessions` itself failed to return. Built from the same
// evaluator as a normal run, over the DECLARED topology with zero receipts, so
// every persona is named exactly as it would be had each one gapped individually.
export const ensembleGapFindings = ({ stage, policy, attempt = 0, topology, reason }) => {
  const evidence = emptyEvidence(topology);
  evidence.gaps.push({ agentRef: topology?.leadAgentRef ?? null, role: 'ensemble', reason });
  return findingsFor({ stage, policy, attempt, evidence });
};

export default {
  MAX_DISSENT_ROUNDS,
  MAX_PERSONA_ATTEMPTS,
  MAX_PERSONA_SESSION_MS,
  STAGE_BUDGET_MS,
  MAX_SUPPORT_PERSONAS,
  ENSEMBLE_PROTOCOL_FILE,
  SESSION_ENSEMBLE_MODES,
  buildIntegratorBrief,
  buildLinkBrief,
  buildSupportBrief,
  contributionArtifactId,
  ensembleGapFindings,
  findingsFor,
  parsePositions,
  renderLeadTopologyBrief,
  resolveEnsembleTopology,
  runEnsembleSessions,
};
