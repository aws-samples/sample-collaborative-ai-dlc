import { createHash } from 'node:crypto';

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

const projectStageState = ({ stages, stageRows }) => {
  const rowsByStage = new Map();
  for (const row of stageRows ?? []) {
    if (!row?.stageId) continue;
    const list = rowsByStage.get(row.stageId) ?? [];
    list.push(row);
    rowsByStage.set(row.stageId, list);
  }

  const projected = stages.map((stage) => ({
    ...stage,
    phase: normalizePhase(stage.phase),
    cloudState: stage.excluded ? 'SKIPPED' : stageAggregate(rowsByStage.get(stage.stageId) ?? []),
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

const renderState = ({ intent, stages, now, repositories, nativeScope }) => {
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

  return `# AI-DLC State Tracking

## Project Information
- **Project**: ${intent.prompt || intent.title || intent.intentId}
- **Project Type**: ${repositories.length > 0 ? 'Brownfield' : 'Greenfield'}
- **Scope**: ${nativeScope}
- **Start Date**: ${intent.createdAt || now}
- **State Version**: 7
- **Active Agent**: ${current?.leadAgent || ''}
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

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
- **Last Completed Stage**: ${lastCompleted?.stageId || 'none'}
- **Next Action**: ${current ? `Execute ${current.stageId}` : 'Workflow complete'}
- **Pending Artifacts**: ${pendingArtifacts}
`;
};

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
  const projectedStages = projectStageState({ stages, stageRows });
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
      repositories: normalizedRepos,
      nativeScope,
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
    },
    native: {
      upstreamRef,
      harness,
      workspaceLayout,
      scope: nativeScope,
      ...(workspaceLayout === 'spaces' ? { space: safeSpace, recordDir } : {}),
    },
    repositories: normalizedRepos,
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
  renderQuestionFile,
  slugify,
};

export default { projectNativeWorkspace };
