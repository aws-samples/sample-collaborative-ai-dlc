import { createHash } from 'node:crypto';
import { parseBoltDag } from './v2-sensor-contract.js';

const PHASES = ['initialization', 'ideation', 'inception', 'construction', 'operation'];
const PHASE_LABELS = {
  initialization: 'INITIALIZATION PHASE',
  ideation: 'IDEATION PHASE',
  inception: 'INCEPTION PHASE',
  construction: 'CONSTRUCTION PHASE',
  operation: 'OPERATION PHASE',
};

const sha256 = (body) => createHash('sha256').update(body).digest('hex');

const slugify = (value, fallback = 'intent') => {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\p{ASCII}]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || fallback;
};

const recordDate = (value) => {
  const date = new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    String(safe.getUTCFullYear()).slice(-2),
    String(safe.getUTCMonth() + 1).padStart(2, '0'),
    String(safe.getUTCDate()).padStart(2, '0'),
  ].join('');
};

const assertSafeSegment = (value, field) => {
  const segment = String(value ?? '');
  if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..') {
    throw new Error(`native-export: ${field} must be a safe path segment`);
  }
  return segment;
};

const normalizePhase = (phase) => {
  const value = String(phase ?? '').toLowerCase();
  return PHASES.includes(value) ? value : null;
};

const titleCase = (value) =>
  String(value ?? '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');

const parseJsonValue = (value, field) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`native-export: ${field} contains invalid JSON`);
  }
};

const optionLetter = (index) => String.fromCharCode(65 + index);

const renderQuestionAnswer = ({ answer, question, index }) => {
  const parsed = parseJsonValue(answer, 'question answer');
  const entry = Array.isArray(parsed?.answers)
    ? parsed.answers[index]
    : index === 0
      ? parsed
      : null;
  if (!entry) return '';
  if (typeof entry === 'string') return entry.trim();

  const selected = Array.isArray(entry.selectedOptions)
    ? entry.selectedOptions
        .filter((selectedIndex) => Number.isInteger(selectedIndex) && selectedIndex >= 0)
        .map((selectedIndex) => {
          const label = question.options?.[selectedIndex]?.label;
          return label ? `${optionLetter(selectedIndex)}. ${label}` : optionLetter(selectedIndex);
        })
    : [];
  const freeText = typeof entry.freeText === 'string' ? entry.freeText.trim() : '';
  if (selected.length === 0) return freeText ? `X. ${freeText}` : '';
  return freeText ? `${selected.join(', ')}; ${freeText}` : selected.join(', ');
};

const renderQuestionFile = ({ stageId, tasks }) => {
  const sections = [];
  let questionNumber = 0;
  for (const task of tasks) {
    const questions = parseJsonValue(task.questions, `question gate ${task.humanTaskId}`);
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error(`native-export: question gate ${task.humanTaskId} has no questions`);
    }
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      if (!question?.text) {
        throw new Error(`native-export: question gate ${task.humanTaskId} has an invalid question`);
      }
      questionNumber += 1;
      const multi =
        question.type === 'multi' && !String(question.text).includes('select all that apply')
          ? ' (select all that apply)'
          : '';
      const options = Array.isArray(question.options) ? question.options : [];
      const optionLines = options.map((option, optionIndex) => {
        const description = option?.description ? ` — ${option.description}` : '';
        return `${optionLetter(optionIndex)}. ${option?.label ?? ''}${description}`;
      });
      if (!options.some((option) => /^other\b/i.test(String(option?.label ?? '').trim()))) {
        optionLines.push('X. Other (please specify)');
      }
      const answer = renderQuestionAnswer({ answer: task.answer, question, index });
      sections.push(
        [
          `## Q${questionNumber}. ${question.text}${multi}`,
          '',
          ...optionLines,
          '',
          answer ? `[Answer]: ${answer}` : '[Answer]:',
        ].join('\n'),
      );
    }
  }
  return `# ${titleCase(stageId)} Questions\n\n${sections.join('\n\n')}\n`;
};

const stageAggregate = (rows) => {
  if (rows.length === 0) return 'PENDING';
  if (rows.every((row) => row.state === 'SUCCEEDED')) return 'SUCCEEDED';
  if (rows.every((row) => row.state === 'SKIPPED')) return 'SKIPPED';
  if (rows.some((row) => row.state === 'WAITING_FOR_HUMAN')) return 'WAITING_FOR_HUMAN';
  if (rows.some((row) => row.state === 'RUNNING')) return 'RUNNING';
  if (rows.some((row) => row.state === 'FAILED')) return 'FAILED';
  return 'PENDING';
};

const normalizedUnitPlan = (unitPlan) => {
  if (!unitPlan || !Array.isArray(unitPlan.units) || unitPlan.units.length === 0) return null;
  const hasRecordedAutonomyMode = ['gated', 'autonomous'].includes(unitPlan.autonomyMode);
  const units = unitPlan.units.map((unit) => ({
    name: assertSafeSegment(unit.slug ?? unit.name, 'unit'),
    depends_on: (unit.dependsOn ?? unit.depends_on ?? []).map((dependency) =>
      assertSafeSegment(dependency, 'unit dependency'),
    ),
  }));
  const dagBody = renderUnitDagBlock(units);
  const parsed = parseBoltDag(`\`\`\`yaml\n${dagBody}\n\`\`\`\n`);
  if (!parsed.ok) {
    throw new Error(`native-export: unit plan is invalid: ${parsed.detail}`);
  }
  return {
    units: parsed.units.map((unit) => ({
      name: unit.name,
      depends_on: unit.depends_on,
    })),
    batches: parsed.batches,
    skipMatrix: unitPlan.skipMatrix ?? {},
    walkingSkeleton: unitPlan.walkingSkeleton ?? null,
    autonomyMode: hasRecordedAutonomyMode ? unitPlan.autonomyMode : 'gated',
    autonomyModeSource: hasRecordedAutonomyMode ? 'cloud' : 'export-default',
  };
};

const normalizedUnitRows = (unitRows = []) => {
  const rowsByUnit = new Map();
  for (const row of unitRows) {
    if (!row?.slug) continue;
    const rows = rowsByUnit.get(row.slug) ?? [];
    rows.push(row);
    rowsByUnit.set(row.slug, rows);
  }
  for (const [slug, rows] of rowsByUnit) {
    if (rows.some((row) => row.sectionIndex != null)) {
      rowsByUnit.set(
        slug,
        rows.filter((row) => row.sectionIndex != null),
      );
    }
  }
  return rowsByUnit;
};

const completedUnitSlugs = ({ unitPlan, unitRows = [] }) => {
  if (!unitPlan) return new Set();
  const rowsByUnit = normalizedUnitRows(unitRows);
  return new Set(
    unitPlan.units
      .filter((unit) => {
        const rows = rowsByUnit.get(unit.name) ?? [];
        return rows.length > 0 && rows.every((row) => row.state === 'MERGED');
      })
      .map((unit) => unit.name),
  );
};

const dependencyReadyUnitSlugs = ({ unitPlan, completedUnits }) => {
  if (!unitPlan) return [];
  return unitPlan.units
    .filter((unit) => !completedUnits.has(unit.name))
    .filter((unit) => unit.depends_on.every((dependency) => completedUnits.has(dependency)))
    .map((unit) => unit.name);
};

const completedUnitTimestamp = ({ unitSlug, unitRows = [], fallback }) => {
  const timestamps = unitRows
    .filter((row) => row?.slug === unitSlug && row.state === 'MERGED')
    .flatMap((row) => [row.mergedAt, row.completedAt, row.updatedAt])
    .filter(Boolean)
    .toSorted();
  return timestamps.at(-1) ?? fallback;
};

const timestampMs = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const stageTimeline = ({ intent, stages, stageRows = [], now }) => {
  const rowsByStage = new Map();
  for (const row of stageRows) {
    if (!row?.stageId) continue;
    const rows = rowsByStage.get(row.stageId) ?? [];
    rows.push(row);
    rowsByStage.set(row.stageId, rows);
  }

  const workflowStartedMs = timestampMs(intent.createdAt) ?? timestampMs(now) ?? 0;
  let cursor = workflowStartedMs;
  const timeline = [];

  for (const stage of stages) {
    if (!['x', '-'].includes(stage.marker)) continue;
    const rows = rowsByStage.get(stage.stageId) ?? [];
    const activeRows =
      stage.marker === '-'
        ? rows.filter((row) => !['SUCCEEDED', 'SKIPPED'].includes(row.state))
        : rows;
    const startedCandidates = activeRows
      .flatMap((row) => [row.startedAt])
      .map(timestampMs)
      .filter((value) => value !== null);
    const rawStarted = startedCandidates.length ? Math.min(...startedCandidates) : null;
    const startedMs = Math.max(rawStarted ?? cursor + 1, cursor + 1);

    let completedAt = null;
    if (stage.marker === 'x') {
      const completedCandidates = rows
        .flatMap((row) => [row.completedAt, row.updatedAt])
        .map(timestampMs)
        .filter((value) => value !== null);
      const rawCompleted = completedCandidates.length ? Math.max(...completedCandidates) : null;
      const completedMs = Math.max(rawCompleted ?? startedMs + 1, startedMs + 1);
      completedAt = new Date(completedMs).toISOString();
      cursor = completedMs;
    } else {
      cursor = startedMs;
    }

    timeline.push({
      stageId: stage.stageId,
      phase: stage.phase,
      agent: stage.leadAgent ?? '',
      produces: stage.produces ?? [],
      startedAt: new Date(startedMs).toISOString(),
      completedAt,
    });
  }

  return timeline;
};

const unitStageAggregate = ({ stage, rows, unitPlan, completedUnits }) => {
  if (stage.forEach !== 'unit-of-work' || stage.forEachDegraded || !unitPlan) {
    return stageAggregate(rows);
  }
  const rowsByUnit = new Map();
  for (const row of rows) {
    if (!row.unitSlug) continue;
    const unitRows = rowsByUnit.get(row.unitSlug) ?? [];
    unitRows.push(row);
    rowsByUnit.set(row.unitSlug, unitRows);
  }
  const unitComplete = (unit) => {
    if (completedUnits.has(unit.name)) return true;
    const skippedStages = unitPlan.skipMatrix?.[unit.name];
    if (Array.isArray(skippedStages) && skippedStages.includes(stage.stageId)) return true;
    return (rowsByUnit.get(unit.name) ?? []).some((row) =>
      ['SUCCEEDED', 'SKIPPED'].includes(row.state),
    );
  };
  if (unitPlan.units.every(unitComplete)) return 'SUCCEEDED';
  return stageAggregate(
    rows.filter((row) => !row.unitSlug || !unitComplete({ name: row.unitSlug })),
  );
};

const projectStageState = ({ stages, stageRows, unitPlan = null, unitRows = [] }) => {
  const rowsByStage = new Map();
  for (const row of stageRows ?? []) {
    if (!row?.stageId) continue;
    const list = rowsByStage.get(row.stageId) ?? [];
    list.push(row);
    rowsByStage.set(row.stageId, list);
  }
  const completedUnits = completedUnitSlugs({ unitPlan, unitRows });

  const projected = stages.map((stage) => ({
    ...stage,
    phase: normalizePhase(stage.phase),
    cloudState: stage.excluded
      ? 'SKIPPED'
      : unitStageAggregate({
          stage,
          rows: rowsByStage.get(stage.stageId) ?? [],
          unitPlan,
          completedUnits,
        }),
  }));
  const firstUnfinished = projected.findIndex(
    (stage) => !['SUCCEEDED', 'SKIPPED'].includes(stage.cloudState),
  );
  return projected.map((stage, index) => ({
    ...stage,
    marker:
      stage.cloudState === 'SUCCEEDED'
        ? 'x'
        : stage.cloudState === 'SKIPPED'
          ? 'S'
          : index === firstUnfinished
            ? '-'
            : ' ',
  }));
};

const phaseStatus = (phase, stages) => {
  const phaseStages = stages.filter((stage) => stage.phase === phase);
  if (phaseStages.every((stage) => stage.marker === 'S')) {
    return 'Skipped';
  }
  if (phaseStages.every((stage) => ['x', 'S'].includes(stage.marker))) return 'Verified';
  if (phaseStages.some((stage) => ['-', '?', 'R'].includes(stage.marker))) return 'Active';
  return 'Pending';
};

const normalizeProjectType = (value) => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'greenfield') return 'Greenfield';
  if (normalized === 'brownfield') return 'Brownfield';
  return null;
};

const projectTypeFromArtifacts = (artifacts = []) => {
  const detected = new Set();
  for (const artifact of artifacts) {
    const content = String(artifact?.content ?? '').replaceAll('*', '');
    for (const match of content.matchAll(
      /\b(?:project|request)\s+type\s*(?:\||:)\s*[^|\n]{0,80}\b(greenfield|brownfield)\b/gi,
    )) {
      detected.add(normalizeProjectType(match[1]));
    }
  }
  return detected.size === 1 ? [...detected][0] : null;
};

const projectTypeFromDescription = (intent) => {
  const content = [intent?.title, intent?.prompt].filter(Boolean).join('\n');
  const detected = new Set(
    [...content.matchAll(/\b(greenfield|brownfield)\b/gi)].map((match) =>
      normalizeProjectType(match[1]),
    ),
  );
  return detected.size === 1 ? [...detected][0] : null;
};

const resolveProjectType = ({ intent, artifacts = [] }) => {
  const recorded = normalizeProjectType(intent?.projectType);
  if (recorded) return recorded;

  const artifactType = projectTypeFromArtifacts(artifacts);
  if (artifactType) return artifactType;

  return projectTypeFromDescription(intent) ?? 'Unknown';
};

const renderState = ({
  intent,
  stages,
  now,
  projectType,
  nativeScope,
  unitPlan,
  completedUnits,
  nextUnit,
}) => {
  const activeIndex = stages.findIndex((stage) => stage.marker === '-');
  const current = activeIndex >= 0 ? stages[activeIndex] : null;
  const next =
    activeIndex >= 0
      ? stages.slice(activeIndex + 1).find((stage) => !['x', 'S'].includes(stage.marker))
      : null;
  const lastCompleted = stages.toReversed().find((stage) => stage.marker === 'x');
  const completed = stages.filter((stage) => stage.marker === 'x').length;
  const execute = stages.filter((stage) => stage.marker !== 'S');
  const skipped = stages.filter((stage) => stage.marker === 'S');
  const phaseLines = PHASES.map(
    (phase) => `- **${phase[0].toUpperCase()}${phase.slice(1)}**: ${phaseStatus(phase, stages)}`,
  ).join('\n');
  const stageLines = PHASES.map((phase) => {
    const phaseStages = stages.filter((stage) => stage.phase === phase);
    if (phaseStages.length === 0) return '';
    const lines = [`### ${PHASE_LABELS[phase]}`];
    if (phase === 'construction') lines.push('Per unit: exported cloud units');
    for (const stage of phaseStages) {
      lines.push(
        `- [${stage.marker}] ${stage.stageId} — ${stage.marker === 'S' ? 'SKIP' : 'EXECUTE'}`,
      );
    }
    return lines.join('\n');
  })
    .filter(Boolean)
    .join('\n\n');
  const status = current ? 'Running' : 'Completed';
  const lifecycle = current?.phase?.toUpperCase() ?? 'COMPLETED';
  const pendingArtifacts = current?.produces?.length ? current.produces.join(', ') : 'none';
  const orderedCompletedUnits =
    unitPlan?.batches.flat().filter((unit) => completedUnits?.has(unit)) ?? [];
  const lastCompletedUnit = orderedCompletedUnits.at(-1) ?? null;
  const lastCompletedUnitStage = stages
    .filter(
      (stage) =>
        stage.phase === 'construction' && stage.forEach === 'unit-of-work' && stage.marker !== 'S',
    )
    .at(-1);
  const constructionResume = current?.phase === 'construction' && nextUnit;
  const resumeLastCompleted =
    constructionResume && lastCompletedUnit && lastCompletedUnitStage
      ? `${lastCompletedUnitStage.stageId} for unit ${lastCompletedUnit}`
      : lastCompleted?.stageId || 'none';
  const resumeNextAction = current
    ? constructionResume
      ? `Execute ${current.stageId} for unit ${nextUnit}`
      : `Execute ${current.stageId}`
    : 'Workflow complete';

  return `# AI-DLC State Tracking

## Project Information
- **Project**: ${intent.prompt || intent.title || intent.intentId}
- **Project Type**: ${projectType}
- **Scope**: ${nativeScope}
- **Start Date**: ${intent.createdAt || now}
- **State Version**: 7
- **Active Agent**: ${current?.leadAgent || ''}
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:
- **Construction Autonomy Mode**: ${unitPlan?.autonomyMode ?? 'unset'}

## Scope Configuration
- **Stages to Execute**: ${execute.map((stage) => stage.number || stage.stageId).join(', ') || 'none'}
- **Stages to Skip**: ${skipped.map((stage) => stage.number || stage.stageId).join(', ') || 'none'}
- **Depth**: Standard
- **Test Strategy**: Standard
- **Review Override**:

## Workspace State
- **Project Root**: .
- **Languages**:
- **Frameworks**:
- **Build System**:

## Execution Plan Summary
- **Total Stages**: ${execute.length}
- **Completed**: ${completed}
- **In Progress**: ${current?.stageId || 'none'}

## Runtime State
- **Revision Count**: 0
${unitPlan?.walkingSkeleton ? '- **Skeleton Stance**: on' : ''}

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

${phaseLines}

## Stage Progress
<!-- Checkbox states: [ ] not started, [-] in progress, [?] awaiting approval (gate open), [R] revising (user rejected gate), [x] completed, [S] skipped via --stage/--phase jump -->

${stageLines}

## Current Status
- **Lifecycle Phase**: ${lifecycle}
- **Current Stage**: ${current?.stageId || 'none'}
- **Next Stage**: ${next?.stageId || 'none'}
- **Status**: ${status}
- **Last Updated**: ${now}

## Session Resume Point
- **Last Completed Stage**: ${resumeLastCompleted}
- **Next Action**: ${resumeNextAction}
- **Pending Artifacts**: ${pendingArtifacts}
`;
};

const renderUnitDagBlock = (units) =>
  [
    'units:',
    ...units.flatMap((unit) => [
      `  - name: ${unit.name}`,
      `    depends_on: [${unit.depends_on.join(', ')}]`,
    ]),
  ].join('\n');

const upsertUnitDagArtifact = (content, unitPlan) => {
  const block = `\`\`\`yaml\n${renderUnitDagBlock(unitPlan.units)}\n\`\`\``;
  const source = String(content ?? '');
  let replaced = false;
  const updated = source.replace(/```ya?ml[^\n]*\n([\s\S]*?)```/g, (match, inner) => {
    if (replaced || !/^\s*units\s*:/m.test(inner)) return match;
    replaced = true;
    return block;
  });
  if (replaced) return updated.endsWith('\n') ? updated : `${updated}\n`;
  if (updated.trim()) {
    return `${updated.trimEnd()}\n\n## Exported Unit DAG\n\n${block}\n`;
  }
  return `# Unit of Work Dependency

## Unit DAG

${block}

## Export Context

This dependency graph was reconstructed from the approved Collaborative AI-DLC unit plan.
`;
};

const renderAuditEntry = ({ heading, timestamp, event, fields = {} }) => `## ${heading}
**Timestamp**: ${timestamp}
**Event**: ${event}
${Object.entries(fields)
  .map(([key, value]) => `**${key}**: ${value}`)
  .join('\n')}

---
`;

const renderAudit = ({
  intent,
  nativeScope,
  now,
  stageTimeline: timeline = [],
  unitPlan = null,
  completedUnits = new Set(),
  unitRows = [],
}) => {
  const startedAt = intent.createdAt || now;
  let sequence = 0;
  const entries = [
    {
      timestamp: startedAt,
      sequence: sequence++,
      body: renderAuditEntry({
        heading: 'Workflow Started',
        timestamp: startedAt,
        event: 'WORKFLOW_STARTED',
        fields: {
          'Workflow ID': intent.intentId,
          Scope: nativeScope,
          Request: 'Exported Collaborative AI-DLC checkpoint',
        },
      }),
    },
  ];
  for (const stage of timeline) {
    entries.push({
      timestamp: stage.startedAt,
      sequence: sequence++,
      body: renderAuditEntry({
        heading: `Stage Started: ${stage.stageId}`,
        timestamp: stage.startedAt,
        event: 'STAGE_STARTED',
        fields: {
          Stage: stage.stageId,
          Agent: stage.agent,
        },
      }),
    });
    if (stage.completedAt) {
      entries.push({
        timestamp: stage.completedAt,
        sequence: sequence++,
        body: renderAuditEntry({
          heading: `Stage Completed: ${stage.stageId}`,
          timestamp: stage.completedAt,
          event: 'STAGE_COMPLETED',
          fields: {
            Stage: stage.stageId,
            Details: 'Imported from Collaborative AI-DLC checkpoint',
            Artifacts: stage.produces.join(', ') || 'none',
          },
        }),
      });
    }
  }
  const orderedCompletedUnits =
    unitPlan?.batches.flat().filter((unit) => completedUnits.has(unit)) ?? [];
  for (const unitSlug of orderedCompletedUnits) {
    const batchIndex = unitPlan.batches.findIndex((batch) => batch.includes(unitSlug));
    const timestamp = completedUnitTimestamp({ unitSlug, unitRows, fallback: now });
    entries.push({
      timestamp,
      sequence: sequence++,
      body: renderAuditEntry({
        heading: 'Bolt Completed',
        timestamp,
        event: 'BOLT_COMPLETED',
        fields: {
          'Bolt names': unitSlug,
          'Batch number': batchIndex + 1,
          'Bolt slug': unitSlug,
        },
      }),
    });
    if (
      unitSlug === unitPlan.walkingSkeleton &&
      ['gated', 'autonomous'].includes(unitPlan.autonomyMode)
    ) {
      entries.push({
        timestamp: completedUnitTimestamp({ unitSlug, unitRows, fallback: now }),
        sequence: sequence++,
        body: renderAuditEntry({
          heading: 'Autonomy Mode Set',
          timestamp,
          event: 'AUTONOMY_MODE_SET',
          fields: { Mode: unitPlan.autonomyMode },
        }),
      });
    }
  }

  entries.sort(
    (left, right) =>
      String(left.timestamp).localeCompare(String(right.timestamp)) ||
      left.sequence - right.sequence,
  );
  return `# AI-DLC Audit Log\n\n${entries.map((entry) => entry.body).join('\n')}`;
};

const renderRuntimeGraph = ({
  intent,
  nativeScope,
  unitPlan,
  now,
  stageTimeline: timeline,
  recordRoot,
}) => ({
  workflow_id: intent.createdAt || now,
  scope: nativeScope,
  started_at: intent.createdAt || now,
  stages: timeline.map((stage) => ({
    stage_slug: stage.stageId,
    started_at: stage.startedAt,
    completed_at: stage.completedAt,
    agent: stage.agent || null,
    memory_path: `${recordRoot.path}/${stage.phase}/${stage.stageId}/memory.md`,
    memory_entries: null,
    memory_breakdown: null,
    sensor_firings: [],
    outcome: stage.completedAt ? 'approved' : 'pending',
    learnings_captured: stage.completedAt ? { from_orchestrator: 0, from_user_addition: 0 } : null,
  })),
  ...(unitPlan
    ? {
        bolt_dag: {
          units: unitPlan.units,
          batches: unitPlan.batches,
        },
      }
    : {}),
});

const artifactPath = ({
  artifact,
  recordRoot,
  stageById,
  repositories,
  workspaceLayout = 'spaces',
}) => {
  const type = assertSafeSegment(slugify(artifact.artifactType || artifact.type), 'artifact type');
  const stage = stageById.get(artifact.stageId);
  const phase = normalizePhase(artifact.phase || stage?.phase);
  if (!phase || !artifact.stageId) {
    throw new Error(`native-export: artifact ${artifact.id ?? type} has no native producer stage`);
  }
  const stageId = assertSafeSegment(artifact.stageId, 'artifact stage');
  if (stageId === 'reverse-engineering') {
    if (workspaceLayout === 'flat') {
      return `${recordRoot.path}/inception/reverse-engineering/${type}.md`;
    }
    const repo = artifact.repository || (repositories.length === 1 ? repositories[0].name : null);
    if (!repo) {
      throw new Error(`native-export: reverse-engineering artifact ${type} has no repository`);
    }
    return `aidlc/spaces/${recordRoot.space}/codekb/${assertSafeSegment(repo, 'repository')}/${type}.md`;
  }
  if (phase === 'construction' && artifact.unitSlug) {
    return `${recordRoot.path}/construction/${assertSafeSegment(artifact.unitSlug, 'unit')}/${stageId}/${type}.md`;
  }
  return `${recordRoot.path}/${phase}/${stageId}/${type}.md`;
};

const projectNativeWorkspace = ({
  intent,
  stages,
  stageRows = [],
  artifacts = [],
  humanTasks = [],
  repositories = [],
  unitPlan: rawUnitPlan = null,
  unitRows = [],
  space = 'default',
  now = new Date().toISOString(),
  upstreamRef,
  harness,
  workspaceLayout = 'spaces',
  nativeScope = intent?.scope,
}) => {
  if (!intent?.intentId) throw new Error('native-export: intentId is required');
  if (!nativeScope) throw new Error('native-export: native scope is required');
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error('native-export: at least one workflow stage is required');
  }
  const safeSpace = assertSafeSegment(slugify(space, 'default'), 'space');
  if (!['flat', 'spaces'].includes(workspaceLayout)) {
    throw new Error(`native-export: unsupported workspace layout ${workspaceLayout}`);
  }
  const label = slugify(intent.title || intent.prompt || intent.intentId);
  const recordDir = `${recordDate(intent.createdAt || now)}-${label}`;
  const recordRoot =
    workspaceLayout === 'flat'
      ? { space: null, path: 'aidlc-docs' }
      : {
          space: safeSpace,
          path: `aidlc/spaces/${safeSpace}/intents/${recordDir}`,
        };
  const normalizedRepos = repositories.map((repo) => ({
    name: assertSafeSegment(repo.name, 'repository'),
    url: String(repo.url || ''),
    branch: String(repo.branch || intent.branch || ''),
  }));
  if (workspaceLayout === 'flat' && normalizedRepos.length > 1) {
    throw new Error('native-export: legacy flat workspaces do not support multiple repositories');
  }
  const unitPlan = normalizedUnitPlan(rawUnitPlan);
  const completedUnits = completedUnitSlugs({ unitPlan, unitRows });
  const unitOrder = unitPlan?.batches.flat() ?? [];
  const remainingUnits = unitOrder.filter((unit) => !completedUnits.has(unit));
  const readyUnits = dependencyReadyUnitSlugs({ unitPlan, completedUnits });
  const nextUnit = readyUnits[0] ?? remainingUnits[0] ?? null;
  const projectedStages = projectStageState({ stages, stageRows, unitPlan, unitRows });
  const timeline = stageTimeline({
    intent,
    stages: projectedStages,
    stageRows,
    now,
  });
  const projectType = resolveProjectType({
    intent,
    artifacts,
  });
  const stageById = new Map(projectedStages.map((stage) => [stage.stageId, stage]));
  const stageByInstance = new Map(
    stageRows
      .filter((stage) => stage?.stageInstanceId)
      .map((stage) => [stage.stageInstanceId, stage]),
  );
  const files = new Map();
  if (workspaceLayout === 'spaces') {
    files.set('aidlc/active-space', `${safeSpace}\n`);
    files.set(`aidlc/spaces/${safeSpace}/intents/active-intent`, `${recordDir}\n`);
    files.set(
      `aidlc/spaces/${safeSpace}/intents/intents.json`,
      `${JSON.stringify(
        [
          {
            uuid: intent.intentId,
            slug: label,
            dirName: recordDir,
            scope: nativeScope,
            ...(normalizedRepos.length ? { repos: normalizedRepos.map((repo) => repo.name) } : {}),
            status: projectedStages.some((stage) => stage.marker === '-')
              ? 'in-flight'
              : 'complete',
          },
        ],
        null,
        2,
      )}\n`,
    );
  }
  files.set(
    `${recordRoot.path}/aidlc-state.md`,
    renderState({
      intent,
      stages: projectedStages,
      now,
      projectType,
      nativeScope,
      unitPlan,
      completedUnits,
      nextUnit,
    }),
  );
  const auditPath =
    workspaceLayout === 'flat'
      ? `${recordRoot.path}/audit.md`
      : `${recordRoot.path}/audit/export.md`;
  files.set(
    auditPath,
    renderAudit({
      intent,
      nativeScope,
      now,
      stageTimeline: timeline,
      unitPlan,
      completedUnits,
      unitRows,
    }),
  );
  if (workspaceLayout === 'spaces' && normalizedRepos.length > 0) {
    const org = normalizedRepos[0].url.match(/[:/]([^/:]+)\/[^/]+(?:\.git)?$/)?.[1] || 'workspace';
    files.set(
      'repos.json',
      `${JSON.stringify(
        {
          org,
          repos: normalizedRepos.map((repo) => ({
            name: repo.name,
            ...(repo.branch ? { branch: repo.branch } : {}),
            ...(repo.url ? { url: repo.url } : {}),
          })),
        },
        null,
        2,
      )}\n`,
    );
  }
  for (const artifact of artifacts) {
    const path = artifactPath({
      artifact,
      recordRoot,
      stageById,
      repositories: normalizedRepos,
      workspaceLayout,
    });
    if (files.has(path)) throw new Error(`native-export: duplicate output path ${path}`);
    files.set(path, String(artifact.content ?? ''));
  }
  if (unitPlan) {
    const dependencyPath = `${recordRoot.path}/inception/units-generation/unit-of-work-dependency.md`;
    files.set(dependencyPath, upsertUnitDagArtifact(files.get(dependencyPath), unitPlan));
  }
  files.set(
    `${recordRoot.path}/runtime-graph.json`,
    `${JSON.stringify(
      renderRuntimeGraph({
        intent,
        nativeScope,
        unitPlan,
        now,
        stageTimeline: timeline,
        recordRoot,
      }),
      null,
      2,
    )}\n`,
  );
  const questionGroups = new Map();
  for (const task of humanTasks) {
    if (task?.kind !== 'question' || task.status === 'superseded') continue;
    const producer = stageByInstance.get(task.stageInstanceId);
    const stageId = task.stageId ?? producer?.stageId;
    const stage = stageById.get(stageId);
    const phase = normalizePhase(task.phase ?? producer?.phase ?? stage?.phase);
    if (!stageId || !phase) {
      throw new Error(
        `native-export: question gate ${task.humanTaskId ?? 'unknown'} has no native producer stage`,
      );
    }
    const syntheticArtifact = {
      id: task.humanTaskId,
      artifactType: `${stageId}-questions`,
      stageId,
      phase,
      unitSlug: task.unitSlug ?? producer?.unitSlug ?? null,
    };
    const path = artifactPath({
      artifact: syntheticArtifact,
      recordRoot,
      stageById,
      repositories: normalizedRepos,
      workspaceLayout,
    });
    if (files.has(path)) continue;
    const tasks = questionGroups.get(path) ?? [];
    tasks.push(task);
    questionGroups.set(path, tasks);
  }
  for (const [path, tasks] of questionGroups) {
    tasks.sort(
      (left, right) =>
        String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) ||
        String(left.humanTaskId ?? '').localeCompare(String(right.humanTaskId ?? '')),
    );
    const producer = stageByInstance.get(tasks[0].stageInstanceId);
    files.set(
      path,
      renderQuestionFile({
        stageId: tasks[0].stageId ?? producer?.stageId,
        tasks,
      }),
    );
  }
  const manifest = {
    schemaVersion: 1,
    mode: 'workflow-continuation',
    exportedAt: now,
    source: {
      projectId: intent.projectId,
      intentId: intent.intentId,
      workflowId: intent.workflowId,
      workflowVersion: intent.workflowVersion,
      scope: intent.scope,
      projectType,
    },
    native: {
      upstreamRef,
      harness,
      workspaceLayout,
      scope: nativeScope,
      ...(workspaceLayout === 'spaces' ? { space: safeSpace, recordDir } : {}),
    },
    repositories: normalizedRepos,
    ...(unitPlan
      ? {
          construction: {
            unitCount: unitPlan.units.length,
            batches: unitPlan.batches,
            completedUnits: unitOrder.filter((unit) => completedUnits.has(unit)),
            remainingUnits,
            readyUnits,
            nextUnit,
            walkingSkeleton: unitPlan.walkingSkeleton,
            autonomyMode: unitPlan.autonomyMode,
            autonomyModeSource: unitPlan.autonomyModeSource,
          },
        }
      : {}),
    files: [...files]
      .map(([path, body]) => ({
        path,
        bytes: Buffer.byteLength(body),
        sha256: sha256(body),
      }))
      .toSorted((a, b) => a.path.localeCompare(b.path)),
  };
  files.set('export-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return { files, manifest, recordDir, stages: projectedStages };
};

export {
  PHASES,
  artifactPath,
  projectNativeWorkspace,
  projectStageState,
  recordDate,
  resolveProjectType,
  renderUnitDagBlock,
  renderQuestionFile,
  slugify,
  upsertUnitDagArtifact,
};

export default { projectNativeWorkspace };
