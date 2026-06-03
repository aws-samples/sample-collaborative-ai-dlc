// test/e2e/config.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

export function buildConfig(env) {
  const m = env;
  const need = (k) => {
    const v = m[k];
    if (!v) throw new Error(`Missing required config: ${k}`);
    return v;
  };
  return {
    region: need('VITE_AWS_REGION'),
    userPoolId: need('VITE_AWS_USER_POOL_ID'),
    userPoolClientId: need('VITE_AWS_USER_POOL_CLIENT_ID'),
    apiBaseUrl: need('VITE_API_BASE_URL').replace(/\/$/, ''),
    frontendUrl: String(m.E2E_FRONTEND_URL || '').replace(/\/$/, ''),
    username: need('E2E_USERNAME'),
    password: need('E2E_PASSWORD'),
    repos: String(m.E2E_REPOS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    agentCli: m.E2E_CLI || 'kiro',
    githubToken: m.E2E_GITHUB_TOKEN || '',
    baseBranch: m.E2E_BASE_BRANCH || 'main',
    teardown: /^(1|true|yes)$/i.test(m.E2E_TEARDOWN || ''),
    timeoutMs: Number(m.E2E_TIMEOUT_MS || 1800000),
    description: m.E2E_DESCRIPTION || '',
    phaseSelection: m.E2E_PHASES || '',
    scenarioName: m.E2E_SCENARIO || 'multi-changed',
    projectName: m.E2E_PROJECT_NAME || '',
    expectedChangedRepos: String(m.E2E_EXPECTED_CHANGED_REPOS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    skipCleanup: /^(1|true|yes)$/i.test(m.E2E_SKIP_CLEANUP || ''),
    questionStrategy: m.E2E_QUESTION_STRATEGY || 'default-answer',
    clarifyingQuestions:
      m.E2E_CLARIFYING_QUESTIONS === undefined || m.E2E_CLARIFYING_QUESTIONS === ''
        ? 2
        : Math.max(0, Math.floor(Number(m.E2E_CLARIFYING_QUESTIONS)) || 0),
    outDir: m.E2E_OUT_DIR || '',
    expectPrs: !/^(0|false|no)$/i.test(m.E2E_EXPECT_PRS || ''),
    requireTaskCompletion: !/^(0|false|no)$/i.test(m.E2E_REQUIRE_TASK_COMPLETION || 'true'),
    requireRunningTransition: !/^(0|false|no)$/i.test(m.E2E_REQUIRE_RUNNING_TRANSITION || 'true'),
  };
}

export function loadConfig(env = process.env) {
  const fe = parseEnvFile(resolve(repoRoot, 'frontend', '.env'));
  const e2e = parseEnvFile(resolve(repoRoot, 'test', 'e2e', '.env.e2e'));
  return buildConfig({ ...fe, ...e2e, ...env });
}
