// test/e2e/verify-multipr-ui.mjs
// Drives the LOCAL frontend (with the multi-PR tab changes) against the staging
// API and asserts the PR selector tabs render for a kept multi-repo sprint.
// Usage: node verify-multipr-ui.mjs <projectId> <sprintId>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { login } from './playwrightLogin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const projectId = process.argv[2];
const sprintId = process.argv[3];
if (!projectId || !sprintId) throw new Error('need <projectId> <sprintId>');

const cfg = loadConfig({ ...process.env });
const base = process.env.LOCAL_URL || 'http://localhost:5173';
const outDir = join(__dirname, 'artifacts', 'verify-multipr-ui');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 1000 } })
).newPage();
const findings = {};
try {
  await login(page, { username: cfg.username, password: cfg.password, baseUrl: base });

  const reviewUrl = `${base}/project/${projectId}/sprint/${sprintId}/review`;
  // Wait on the graph response we depend on (the PR tabs are derived from it)
  // rather than a fixed sleep, which is HMR-sensitive and flaky.
  const graphResponse = page
    .waitForResponse((r) => /\/sprints\/[^/]+\/graph(\?|$)/.test(r.url()), { timeout: 30000 })
    .catch(() => null);
  await page.goto(reviewUrl, { waitUntil: 'domcontentloaded' });
  await graphResponse;
  // Settle on the rendered PR tab count instead of a fixed timeout.
  await page
    .waitForFunction(
      () => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        return tabs.some((t) => /#\d+/.test(t.textContent || ''));
      },
      { timeout: 15000 },
    )
    .catch(() => {});

  // PR selector tabs carry text like "retail-store-ui #5". The content tabs
  // (Blind/Full/Comments/Code) do not contain a '#<number>'.
  const allTabs = await page.getByRole('tab').allInnerTexts();
  const prTabs = allTabs.filter((t) => /#\d+/.test(t));
  findings.allTabs = allTabs;
  findings.prTabs = prTabs;

  await page.screenshot({ path: join(outDir, '01-review-default.png'), fullPage: true });

  // Click each PR tab and screenshot the scoped state.
  for (let i = 0; i < prTabs.length; i += 1) {
    const label = prTabs[i];
    const tab = page.getByRole('tab', { name: label });
    await tab.click().catch(() => {});
    // Wait for the tab to reflect selection rather than a fixed sleep.
    await tab
      .first()
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => {});
    await page
      .waitForFunction(
        (sel) => {
          const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
          const t = tabs.find((el) => (el.textContent || '').includes(sel));
          return t ? t.getAttribute('aria-selected') === 'true' : true;
        },
        label,
        { timeout: 5000 },
      )
      .catch(() => {});
    await page.screenshot({ path: join(outDir, `02-pr-${i + 1}.png`), fullPage: true });
  }

  // Is there a "View PR" button visible?
  findings.viewPrVisible = await page
    .getByRole('button', { name: /view .*#\d+/i })
    .first()
    .isVisible()
    .catch(() => false);

  findings.ok = prTabs.length >= 2 && findings.viewPrVisible;
  console.log(JSON.stringify(findings, null, 2));
} catch (e) {
  console.error('VERIFY ERROR:', e.message);
  await page.screenshot({ path: join(outDir, 'error.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
