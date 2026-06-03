// test/e2e/observer.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { login } from './playwrightLogin.mjs';

export async function createObserver({ frontendUrl, username, password, outDir }) {
  if (!frontendUrl) throw new Error('E2E_FRONTEND_URL is required for the UI observer');
  const shotsDir = join(outDir, 'screenshots');
  mkdirSync(shotsDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  let seq = 0;

  let loginReachedDashboard = false;
  try {
    loginReachedDashboard = await login(page, { username, password, baseUrl: frontendUrl });
  } catch (e) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw e;
  }

  async function capture(label, urlPath) {
    if (urlPath) {
      let currentPath = '';
      try {
        currentPath = new URL(page.url()).pathname.replace(/\/$/, '');
      } catch {
        currentPath = '';
      }
      const want = urlPath.replace(/\/$/, '');
      if (currentPath !== want) {
        await page
          .goto(`${frontendUrl}${urlPath}`, { waitUntil: 'domcontentloaded' })
          .catch(() => {});
      }
    }
    await page.waitForTimeout(1500); // allow async UI to render
    seq += 1;
    const n = String(seq).padStart(4, '0');
    const file = join(shotsDir, `${n}-${label}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return { seq, label, path: urlPath || page.url(), file };
  }

  async function close() {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return { capture, close, loginReachedDashboard };
}
