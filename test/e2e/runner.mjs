// test/e2e/runner.mjs
import { setTimeout as sleep } from 'node:timers/promises';
import { isPending, buildDefaultAnswer } from './defaultAnswer.mjs';
import { extractPullRequests } from './prGraph.mjs';

const POLL_MS = 15000;

// Classifies a tasks API response. The response may be a bare array or a
// { tasks: [...] } envelope (mirror the defensive shape-handling in
// prGraph.extractPullRequests). Distinguishes `failed` from `done` so an
// all-FAILED set is never mistaken for completion. Pure/testable.
export function classifyTasks(resp) {
  const tasks = Array.isArray(resp) ? resp : Array.isArray(resp?.tasks) ? resp.tasks : [];
  const settled =
    tasks.length > 0 && tasks.every((x) => x && (x.status === 'done' || x.status === 'failed'));
  const anyDone = tasks.some((x) => x && x.status === 'done');
  const anyFailed = tasks.some((x) => x && x.status === 'failed');
  return { settled, anyDone, anyFailed, count: tasks.length };
}

async function drivePhase({
  api,
  capture,
  reporter,
  projectId,
  sprintId,
  cfg,
  phaseLabel,
  statusUrl,
  watchTasks,
}) {
  const deadline = Date.now() + cfg.timeoutMs;
  const answered = new Set();
  let qCount = 0;
  let tasksDoneCaptured = false;
  let lastErr = null;
  // When the shared status reports terminal-SUCCESS but we have no proof the
  // phase ran (no RUNNING poll, no tasks done), give a few extra polls for the
  // task signal to surface before giving up — rather than spinning to the full
  // timeout and masking a "completed-without-transition" as a timeout.
  const SETTLE_POLLS = 4;
  let settlePolls = 0;
  const state = {
    sawRunning: false,
    sawTasksDone: false,
    tasksFailed: false,
    completed: false,
    completedAfterRunning: false,
    completeCaptured: false,
    seenStatuses: [],
  };

  while (Date.now() < deadline) {
    const questions = await api.get(`/sprints/${sprintId}/questions`).catch((e) => {
      lastErr = e;
      return [];
    });
    for (const q of Array.isArray(questions) ? questions : []) {
      if (isPending(q) && !answered.has(q.id)) {
        await api.put(`/sprints/${sprintId}/questions/${q.id}`, {
          structuredAnswer: buildDefaultAnswer(q),
        });
        answered.add(q.id);
        qCount += 1;
        reporter.event({ label: `${phaseLabel}-answered`, questionId: q.id, agent: q.agent });
        reporter.event(await capture(`${phaseLabel}-question-${qCount}`, statusUrl));
      }
    }

    if (watchTasks && !tasksDoneCaptured) {
      const t = await api
        .get(`/projects/${projectId}/agents/tasks?sprintId=${sprintId}`)
        .catch((e) => {
          lastErr = e;
          return { tasks: [] };
        });
      const c = classifyTasks(t);
      // Only consider tasks "settled" once none are still in flight. Distinguish
      // failed from done: an all-FAILED set is NOT a real completion and must not
      // set sawTasksDone (which would otherwise produce a false PASS).
      if (c.settled) {
        if (c.anyFailed) state.tasksFailed = true;
        if (c.anyDone) {
          reporter.event(await capture(`${phaseLabel}-tasks-complete`, statusUrl));
          state.sawTasksDone = true;
        } else {
          // All tasks failed: capture evidence but do not treat as done.
          reporter.event(await capture(`${phaseLabel}-tasks-failed`, statusUrl));
        }
        tasksDoneCaptured = true;
      }
    }

    const exec = await api.get(`/projects/${projectId}/agents?sprintId=${sprintId}`).catch((e) => {
      lastErr = e;
      return {};
    });
    const s = String(exec.status || '').toUpperCase();
    if (!state.seenStatuses.includes(s)) state.seenStatuses.push(s);
    if (s === 'RUNNING' || s === 'IN_PROGRESS') {
      state.sawRunning = true;
    }
    if (s === 'SUCCEEDED' || s === 'COMPLETED') {
      // Tasks reaching done is authoritative proof the phase really ran, even if
      // no RUNNING poll was caught. Accept either signal so we don't spin until
      // timeout re-capturing the same completion screenshot every poll.
      const ranForReal = state.sawRunning || state.sawTasksDone;
      state.completed = true;
      state.completedAfterRunning = ranForReal;
      if (!watchTasks || ranForReal) {
        if (!state.completeCaptured) {
          reporter.event(await capture(`${phaseLabel}-complete`, statusUrl));
          state.completeCaptured = true;
        }
        return state;
      }
      // Terminal-SUCCESS without ran-for-real proof: bound the wait. After a few
      // settle polls, return state so the assertion layer can report the real
      // reason (phase-completed-without-transition) and the run fails fast.
      settlePolls += 1;
      if (settlePolls >= SETTLE_POLLS) {
        if (!state.completeCaptured) {
          reporter.event(await capture(`${phaseLabel}-complete-no-transition`, statusUrl));
          state.completeCaptured = true;
        }
        return state;
      }
    }
    if (['FAILED', 'TIMED_OUT', 'ABORTED', 'STOPPED'].includes(s)) {
      reporter.event(await capture(`${phaseLabel}-failed`, statusUrl));
      throw new Error(`${phaseLabel} execution ended status=${s}`);
    }
    await sleep(POLL_MS);
  }
  reporter.event(await capture(`${phaseLabel}-timeout`, statusUrl));
  throw new Error(
    `${phaseLabel} timed out after ${cfg.timeoutMs}ms${lastErr ? ` (last poll error: ${lastErr.message})` : ''}`,
  );
}

// Decides what to do with a review node that already exists when the review
// phase starts (e.g. left behind by a prior --skip-cleanup run). Pure/testable.
//   - null/absent          -> proceed (launch agents)
//   - both reviews present  -> already complete, skip re-launch
//   - stale, or partial (exactly one review) -> fail fast, don't poll 30 min
export function inspectExistingReview(review) {
  if (!review || typeof review !== 'object') {
    return { failFast: false, alreadyComplete: false };
  }
  const hasBlind = Boolean(review.blindReview);
  const hasFull = Boolean(review.fullReview);
  const stale = Boolean(review.stale);
  const state = {
    sawRunning: false,
    completed: hasBlind && hasFull,
    status: review.status ?? null,
    riskScore: review.riskScore ?? null,
    hasBlind,
    hasFull,
  };
  if (hasBlind && hasFull && !stale) {
    return { failFast: false, alreadyComplete: true, state };
  }
  if (stale) {
    return { failFast: true, reason: 'review-stale-partial', state };
  }
  // Non-stale but partial: exactly one of the two reviews is present.
  if (hasBlind !== hasFull) {
    return { failFast: true, reason: 'review-stale-partial', state };
  }
  // Neither review present (and not stale): a fresh, empty node — proceed.
  return { failFast: false, alreadyComplete: false, state };
}

// Drives the Review phase. Unlike construction, completion is detected on the
// business signal (the Review node carrying both blind_review and full_review),
// which is far more reliable than the shared, phase-agnostic /agents status.
async function driveReview({ api, capture, reporter, projectId, sprintId, cfg, statusUrl }) {
  const deadline = Date.now() + cfg.timeoutMs;
  const answered = new Set();
  let qCount = 0;
  let lastErr = null;
  const state = {
    sawRunning: false,
    completed: false,
    status: null,
    riskScore: null,
    hasBlind: false,
    hasFull: false,
  };

  while (Date.now() < deadline) {
    const questions = await api.get(`/sprints/${sprintId}/questions`).catch((e) => {
      lastErr = e;
      return [];
    });
    for (const q of Array.isArray(questions) ? questions : []) {
      if (isPending(q) && !answered.has(q.id)) {
        await api.put(`/sprints/${sprintId}/questions/${q.id}`, {
          structuredAnswer: buildDefaultAnswer(q),
        });
        answered.add(q.id);
        qCount += 1;
        reporter.event({ label: 'review-answered', questionId: q.id, agent: q.agent });
        reporter.event(await capture(`review-question-${qCount}`, statusUrl));
      }
    }

    // Observed-running guard via the shared agents status (best-effort signal only).
    const exec = await api
      .get(`/projects/${projectId}/agents?sprintId=${sprintId}`)
      .catch(() => ({}));
    const s = String(exec.status || '').toUpperCase();
    if (s === 'RUNNING' || s === 'IN_PROGRESS') state.sawRunning = true;

    // Authoritative completion signal: the Review node has both reviews populated.
    const review = await api.get(`/sprints/${sprintId}/review`).catch((e) => {
      lastErr = e;
      return null;
    });
    if (review) {
      state.hasBlind = Boolean(review.blindReview);
      state.hasFull = Boolean(review.fullReview);
      state.status = review.status || state.status;
      state.riskScore = review.riskScore ?? state.riskScore;
      if (state.hasBlind && state.hasFull) {
        state.completed = true;
        reporter.event({
          label: 'review-results',
          status: state.status,
          riskScore: state.riskScore,
          hasBlind: true,
          hasFull: true,
        });
        reporter.event(await capture('review-complete', statusUrl));
        return state;
      }
    }
    await sleep(POLL_MS);
  }
  reporter.event(await capture('review-timeout', statusUrl));
  throw new Error(
    `review timed out after ${cfg.timeoutMs}ms${lastErr ? ` (last poll error: ${lastErr.message})` : ''}`,
  );
}

export async function runScenario({ api, observer, reporter, cfg, scenario, ctx = {} }) {
  const capture = (label, urlPath) => observer.capture(label, urlPath);

  reporter.event({ label: 'run-start', scenario: scenario.name, repos: cfg.repos });
  reporter.event(await capture('login', '/dashboard'));

  const [primary, ...rest] = cfg.repos;
  if (!primary) throw new Error('E2E_REPOS must list at least one owner/repo');
  ctx.branch = scenario.branch;

  const project = await api.post('/projects', {
    name: scenario.projectName,
    gitProvider: 'github',
    gitRepo: primary,
    agentCli: cfg.agentCli,
    issueIntegrationEnabled: false,
  });
  const projectId = project.id;
  ctx.projectId = projectId;
  reporter.event({ label: 'project-created', projectId, primary });
  reporter.event(await capture('project-created', `/project/${projectId}`));

  for (const r of rest) {
    await api.post(`/projects/${projectId}/repos`, {
      url: r,
      provider: 'github',
      role: 'secondary',
    });
    reporter.event({ label: 'repo-added', repo: r });
  }
  if (rest.length) reporter.event(await capture('repos-added', `/project/${projectId}`));

  const sprint = await api.post(`/projects/${projectId}/sprints`, {
    name: scenario.sprintName,
    description: scenario.description,
    phase: 'INCEPTION',
  });
  const sprintId = sprint.id;
  ctx.sprintId = sprintId;
  reporter.event({ label: 'sprint-created', sprintId });

  const sprintUrl = `/project/${projectId}/sprint/${sprintId}`;
  const constructionUrl = `${sprintUrl}/construction`;
  const reviewUrl = `${sprintUrl}/review`;
  const graphUrl = `${sprintUrl}/graph`;
  reporter.event(await capture('sprint-created', sprintUrl));
  const phaseResults = {};

  // Inception
  if (scenario.phases.includes('inception')) {
    await api.post(`/projects/${projectId}/agents`, {
      phase: 'inception',
      sprintId,
      description: scenario.description,
      event: { event: 'start' },
    });
    reporter.event(await capture('inception-started', sprintUrl));
    phaseResults.inception = await drivePhase({
      api,
      capture,
      reporter,
      projectId,
      sprintId,
      cfg,
      phaseLabel: 'inception',
      statusUrl: sprintUrl,
    });
  }

  // Approve -> Construction
  if (scenario.phases.includes('construction')) {
    await api.put(`/projects/${projectId}/sprints/${sprintId}`, { phase: 'CONSTRUCTION' });
    await api.put(`/projects/${projectId}/sprints/${sprintId}`, {
      branch: scenario.branch,
      baseBranch: cfg.baseBranch,
    });
    reporter.event(await capture('construction-approved', constructionUrl));

    // Construction
    await api.post(`/projects/${projectId}/agents`, {
      phase: 'construction-orchestrator',
      sprintId,
      branch: scenario.branch,
      baseBranch: cfg.baseBranch,
      event: { event: 'start' },
    });
    reporter.event(await capture('construction-started', constructionUrl));
    phaseResults.construction = await drivePhase({
      api,
      capture,
      reporter,
      projectId,
      sprintId,
      cfg,
      phaseLabel: 'construction',
      statusUrl: constructionUrl,
      watchTasks: true,
    });
  }

  // Collect PRs
  await sleep(5000);
  const graph = await api.get(`/sprints/${sprintId}/graph`).catch(() => ({ nodes: [] }));
  const prs = extractPullRequests(graph);
  reporter.event({ label: 'prs-collected', count: prs.length, prs });

  // Final visual narrative for human review:
  // 1. Construction view — shows tasks completed / work done
  reporter.event(await capture('construction-done', constructionUrl));
  // 2. Review phase (optional): mirror the UI "Kick-Off Review Agents" flow —
  // move to REVIEW, create the Review node, launch blind + full in parallel,
  // then wait on the Review node (not the shared status) for results.
  if (scenario.phases.includes('review')) {
    await api
      .put(`/projects/${projectId}/sprints/${sprintId}`, { phase: 'REVIEW' })
      .catch(() => {});
    reporter.event(await capture('review-prs', reviewUrl));

    // Pre-flight: a prior run (e.g. with --skip-cleanup) may have left a review
    // node behind. Inspect it before launching agents so we don't re-launch and
    // poll to the 30-min timeout against a half-finished review.
    const existing = await api.get(`/sprints/${sprintId}/review`).catch(() => null);
    const preflight = inspectExistingReview(existing);
    if (preflight.failFast) {
      reporter.event({ label: 'review-preflight', reason: preflight.reason, ...preflight.state });
      reporter.event(await capture('review-preflight-fail', reviewUrl));
      throw new Error(`review pre-flight: ${preflight.reason}`);
    }
    if (preflight.alreadyComplete) {
      reporter.event({ label: 'review-preflight', reason: 'already-complete', ...preflight.state });
      reporter.event(await capture('review-complete', reviewUrl));
      phaseResults.review = preflight.state;
    } else {
      // POST may 409 if a non-stale review already exists — that's fine.
      await api.post(`/sprints/${sprintId}/review`, { comments: '' }).catch(() => {});
      reporter.event({ label: 'review-node-created' });
      await api.post(`/projects/${projectId}/agents`, {
        phase: 'review-blind',
        sprintId,
        branch: scenario.branch,
        baseBranch: cfg.baseBranch,
        event: { event: 'start' },
      });
      await api.post(`/projects/${projectId}/agents`, {
        phase: 'review-full',
        sprintId,
        branch: scenario.branch,
        baseBranch: cfg.baseBranch,
        event: { event: 'start' },
      });
      reporter.event(await capture('review-started', reviewUrl));
      phaseResults.review = await driveReview({
        api,
        capture,
        reporter,
        projectId,
        sprintId,
        cfg,
        statusUrl: reviewUrl,
      });
    }
  }
  // 3. Graph view — the full knowledge graph (requirements -> stories -> tasks -> PRs)
  reporter.event(await capture('graph-final', graphUrl));

  return { projectId, sprintId, branch: scenario.branch, prs, phaseResults };
}
