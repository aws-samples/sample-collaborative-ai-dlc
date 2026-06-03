// test/e2e/run.mjs
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { loadConfig } from './config.mjs';
import { srpLogin } from './auth.mjs';
import { createApiClient } from './apiClient.mjs';
import { createObserver } from './observer.mjs';
import { createReporter } from './report.mjs';
import { runScenario } from './runner.mjs';
import { assertE2EExpectations } from './prGraph.mjs';
import { aheadBy } from './githubCompare.mjs';
import { teardownRun, cleanupProject, cleanupAdvisory } from './teardown.mjs';
import { resolveScenarioConfig } from './scenarios.mjs';
import { parseArgs } from './cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const cfg = loadConfig({ ...process.env, ...parseArgs(process.argv.slice(2)) });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = cfg.outDir ? resolve(cfg.outDir, runId) : resolve(__dirname, 'artifacts', runId);
  const reporter = createReporter(outDir);

  const stamp = Date.now();
  const baseName = cfg.projectName || `e2e-${stamp}`;
  const scenario = {
    ...resolveScenarioConfig(cfg),
    projectName: baseName,
    sprintName: cfg.projectName ? `${baseName}-sprint` : `e2e-sprint-${stamp}`,
    branch: `ai-dlc/${baseName}-${stamp}`,
  };

  let observer = null;
  let api = null;
  let status = 'FAIL';
  let result = { prs: [] };
  const ctx = {};
  let assertion = { ok: false, violations: [], missing: [], note: 'not-run' };

  try {
    const tokens = await srpLogin(cfg);
    api = createApiClient({ apiBaseUrl: cfg.apiBaseUrl, idToken: tokens.idToken });
    observer = await createObserver({
      frontendUrl: cfg.frontendUrl,
      username: cfg.username,
      password: cfg.password,
      outDir,
    });
    reporter.event({ label: 'login', reachedDashboard: observer.loginReachedDashboard });

    result = await runScenario({ api, observer, reporter, cfg, scenario, ctx });

    if (cfg.githubToken || scenario.expectations.expectedChangedRepos) {
      const changed = [];
      if (scenario.expectations.expectedChangedRepos) {
        changed.push(...scenario.expectations.expectedChangedRepos);
      } else {
        for (const full of cfg.repos) {
          const [owner, repo] = full.split('/');
          // aheadBy() already maps a 404 (missing branch) to 0 commits ahead.
          // Any other failure (auth, rate-limit, transient 5xx) must NOT be
          // silently coerced to "repo unchanged" — that could invert the
          // assertion. Let it propagate so the run fails loudly instead.
          const n = await aheadBy({
            token: cfg.githubToken,
            owner,
            repo,
            base: cfg.baseBranch,
            head: result.branch,
          });
          if (n > 0) changed.push(full);
        }
      }
      assertion = assertE2EExpectations({
        prs: result.prs,
        changedRepos: changed,
        expectPrs: scenario.expectations.expectPrs,
        phaseState: result.phaseResults?.construction,
        requireTaskCompletion: scenario.expectations.requireTaskCompletion,
        requireRunningTransition: scenario.expectations.requireRunningTransition,
        requireReview: scenario.expectations.requireReview,
        reviewState: result.phaseResults?.review,
        enforceRepoAllowList: true,
      });
      status = assertion.ok ? 'PASS' : 'FAIL';
    } else {
      assertion = assertE2EExpectations({
        prs: result.prs,
        changedRepos: [],
        expectPrs: scenario.expectations.expectPrs,
        phaseState: result.phaseResults?.construction,
        requireTaskCompletion: scenario.expectations.requireTaskCompletion,
        requireRunningTransition: scenario.expectations.requireRunningTransition,
        requireReview: scenario.expectations.requireReview,
        reviewState: result.phaseResults?.review,
        enforceRepoAllowList: false,
      });
      assertion.note =
        'no E2E_GITHUB_TOKEN or explicit changed repos; validated phase signals and PR presence only';
      status = assertion.ok ? 'PASS' : 'FAIL';
    }
  } catch (e) {
    reporter.event({ label: 'error', message: e.message, stack: e.stack });
    const projectId = result.projectId ?? ctx.projectId;
    const sprintId = result.sprintId ?? ctx.sprintId;
    const failPath = sprintId
      ? `/project/${projectId}/sprint/${sprintId}/construction`
      : '/dashboard';
    if (observer) {
      await observer
        .capture('failure', failPath)
        .then((ev) => reporter.event(ev))
        .catch(() => {});
    }
  } finally {
    // Always clean up Neptune (sprint + project) to avoid polluting staging.
    // Fall back to ctx (populated as soon as the project/sprint are created) so
    // cleanup still runs when runScenario throws before returning a result.
    const projectId = result.projectId ?? ctx.projectId;
    const sprintId = result.sprintId ?? ctx.sprintId;
    const branch = result.branch ?? ctx.branch;
    let cleanupWarning = null;
    if (!cfg.skipCleanup) {
      const cleanup = await cleanupProject({ api, projectId, sprintId }).catch((e) => ({
        error: e.message,
      }));
      reporter.event({ label: 'cleanup', ...cleanup });
      cleanupWarning = cleanupAdvisory(cleanup, { projectId, sprintId });
      if (cleanupWarning) {
        reporter.event({ label: 'cleanup-warning', warning: cleanupWarning });
        console.warn(`E2E WARNING — ${cleanupWarning}`);
      }
    } else {
      reporter.event({ label: 'cleanup-skipped' });
    }

    // Optional: close PRs + delete branches on GitHub (only when E2E_TEARDOWN=true)
    if (cfg.teardown && cfg.githubToken && result.prs?.length) {
      const td = await teardownRun({ token: cfg.githubToken, prs: result.prs, branch }).catch(
        (e) => ({ error: e.message }),
      );
      reporter.event({ label: 'teardown', td });
    }
    reporter.finalize({
      status,
      prs: result.prs || [],
      assertion,
      meta: { runId, projectId, sprintId, branch, cleanupWarning },
    });
    if (observer) await observer.close();
  }

  console.log(`E2E ${status} — report: ${join(outDir, 'report.html')}`);
  process.exit(status === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
