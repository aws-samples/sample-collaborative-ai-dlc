// test/e2e/verify-multipr-ui-matrix.mjs
// Senior-tester matrix: intercepts the sprint graph API on the LOCAL frontend and
// rewrites the PullRequest node set to exercise edge cases the real e2e can't
// easily produce (0 PRs, 1 PR, 3 PRs, stale filtering, missing repository).
// Usage: node verify-multipr-ui-matrix.mjs <projectId> <sprintId>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { login } from './playwrightLogin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function prNode(over) {
  const repo = over.repository ?? 'owner/repo';
  const n = over.pr_number ?? '1';
  return {
    id: over.id,
    type: 'PullRequest',
    label: 'PR',
    pr_url: over.pr_url ?? `https://github.com/${repo}/pull/${n}`,
    pr_number: String(n),
    repository: over.repository, // may be undefined on purpose
    branch: over.branch ?? 'feat/x',
    base_branch: over.base_branch ?? 'main',
    stale: over.stale ?? false,
  };
}

// scenario -> graph node set
const SCENARIOS = {
  zero: [],
  one: [prNode({ id: 'a', repository: 'owner/ui', pr_number: '5' })],
  three: [
    prNode({ id: 'a', repository: 'owner/ui', pr_number: '5' }),
    prNode({ id: 'b', repository: 'owner/infra', pr_number: '5' }),
    prNode({ id: 'c', repository: 'owner/payments-service-with-a-long-name', pr_number: '12' }),
  ],
  staleMix: [
    prNode({ id: 'fresh', repository: 'owner/ui', pr_number: '6' }),
    prNode({ id: 'old', repository: 'owner/ui', pr_number: '5', stale: true }),
  ],
  missingRepo: [prNode({ id: 'a', repository: undefined, pr_number: '9' })],
};

const EXPECT = {
  zero: { prTabs: 0, warning: true, kickOffDisabled: true, viewPr: false },
  one: { prTabs: 0, warning: false, kickOffDisabled: false, viewPr: true },
  three: { prTabs: 3, warning: false, kickOffDisabled: false, viewPr: true },
  staleMix: { prTabs: 0, warning: false, kickOffDisabled: false, viewPr: true },
  missingRepo: { prTabs: 0, warning: false, kickOffDisabled: false, viewPr: true },
};

const projectId = process.argv[2];
const sprintId = process.argv[3];
if (!projectId || !sprintId) throw new Error('need <projectId> <sprintId>');

const cfg = loadConfig({ ...process.env });
const base = process.env.LOCAL_URL || 'http://localhost:5173';
const outDir = join(__dirname, 'artifacts', 'verify-multipr-ui');
mkdirSync(outDir, { recursive: true });

let currentNodes = [];
let stripSprintPr = false;

const browser = await chromium.launch({ headless: true });
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 1000 } })
).newPage();
const results = {};
let failures = 0;
try {
  // Rewrite the graph response with the scenario's PR nodes.
  await page.route('**/sprints/*/graph', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ nodes: currentNodes, edges: [] }),
    });
  });

  // For the true "zero PRs" case, also strip the PR copied onto the sprint vertex
  // (otherwise the intentional sprint.prUrl backward-compat fallback keeps hasPr true).
  await page.route('**/projects/*/sprints/*', async (route) => {
    const url = route.request().url();
    if (!stripSprintPr || /\/graph(\?|$)/.test(url)) return route.fallback();
    const resp = await route.fetch();
    let body = await resp.text();
    try {
      const json = JSON.parse(body);
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        json.prUrl = null;
        json.prNumber = null;
        body = JSON.stringify(json);
      }
    } catch {
      /* leave body untouched */
    }
    await route.fulfill({ response: resp, body });
  });

  await login(page, { username: cfg.username, password: cfg.password, baseUrl: base });

  const reviewUrl = `${base}/project/${projectId}/sprint/${sprintId}/review`;

  for (const name of Object.keys(SCENARIOS)) {
    currentNodes = SCENARIOS[name];
    stripSprintPr = name === 'zero';
    const want = EXPECT[name];
    await page.goto(reviewUrl, { waitUntil: 'domcontentloaded' });
    // Wait for the (intercepted) graph fetch triggered by the reload rather than
    // a fixed sleep — the route we control is the deterministic settle signal.
    const graphResponse = page
      .waitForResponse((r) => /\/sprints\/[^/]+\/graph(\?|$)/.test(r.url()), { timeout: 30000 })
      .catch(() => null);
    await page.reload({ waitUntil: 'domcontentloaded' }); // ensure fresh graph fetch
    await graphResponse;
    // Settle on the expected PR-tab count. For scenarios that expect 0 tabs the
    // count never rises, so this resolves quickly (or times out harmlessly).
    await page
      .waitForFunction(
        (expected) => {
          const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
          const prTabCount = tabs.filter((t) => /#\d+/.test(t.textContent || '')).length;
          return prTabCount === expected;
        },
        want.prTabs,
        { timeout: 15000 },
      )
      .catch(() => {});

    const allTabs = await page
      .getByRole('tab')
      .allInnerTexts()
      .catch(() => []);
    const prTabs = allTabs.filter((t) => /#\d+/.test(t));
    const warning = await page
      .getByText(/No Pull Request found/i)
      .first()
      .isVisible()
      .catch(() => false);
    const kickOff = page.getByRole('button', { name: /Kick-Off Review Agents/i }).first();
    const kickOffDisabled = await kickOff.isDisabled().catch(() => null);
    const viewPr = await page
      .getByRole('button', { name: /view .*#\d+/i })
      .first()
      .isVisible()
      .catch(() => false);

    const got = { prTabs: prTabs.length, warning, kickOffDisabled, viewPr };
    const ok =
      got.prTabs === want.prTabs &&
      got.warning === want.warning &&
      got.kickOffDisabled === want.kickOffDisabled &&
      got.viewPr === want.viewPr;
    if (!ok) failures += 1;
    results[name] = { ok, got, want, tabLabels: prTabs };
    await page.screenshot({ path: join(outDir, `matrix-${name}.png`), fullPage: true });
  }

  console.log(JSON.stringify({ failures, results }, null, 2));
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error('MATRIX ERROR:', e.message);
  await page.screenshot({ path: join(outDir, 'matrix-error.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
