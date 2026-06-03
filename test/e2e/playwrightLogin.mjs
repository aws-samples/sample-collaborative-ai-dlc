// test/e2e/playwrightLogin.mjs
// Shared Playwright login helper used by the UI observer and the verify-* scripts,
// so the login flow (locator fallbacks, submit, dashboard wait) lives in one place
// instead of three divergent copies. The locator set is the richer one originally
// in observer.mjs (kept as canonical).

// Tries each locator factory in turn and fills the first visible match.
export async function fillFirst(page, locatorFns, value) {
  for (const fn of locatorFns) {
    try {
      const loc = fn();
      await loc.waitFor({ state: 'visible', timeout: 4000 });
      await loc.fill(value);
      return true;
    } catch {
      /* try next */
    }
  }
  throw new Error('Could not locate a target input for login');
}

// Logs in via the /login page. Returns true if the dashboard URL was reached
// within the timeout, false otherwise (callers may proceed regardless).
export async function login(page, { username, password, baseUrl }) {
  if (!baseUrl) throw new Error('login: baseUrl is required');
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await fillFirst(
    page,
    [
      () => page.getByLabel(/email|username/i),
      () => page.locator('input[type="email"]'),
      () => page.getByPlaceholder(/email|username/i),
      () => page.locator('input[name="username"]'),
      () => page.locator('#username'),
    ],
    username,
  );
  await fillFirst(
    page,
    [
      () => page.getByLabel(/password/i),
      () => page.locator('input[type="password"]'),
      () => page.getByPlaceholder(/password/i),
      () => page.locator('input[name="password"]'),
      () => page.locator('#password'),
    ],
    password,
  );
  await page
    .getByRole('button', { name: /sign in|log ?in|continue/i })
    .first()
    .click();
  let reachedDashboard = false;
  await page
    .waitForURL(/\/(dashboard)?$/, { timeout: 30000 })
    .then(() => {
      reachedDashboard = true;
    })
    .catch(() => {});
  return reachedDashboard;
}
