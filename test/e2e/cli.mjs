// test/e2e/cli.mjs
// Maps CLI flags to the same env keys config.mjs already understands, so the
// harness can be steered from argv without changing any other module. argv
// overrides env which overrides the .env files (merge happens in run.mjs).

// Flags that take a value: --flag value  OR  --flag=value
const VALUE_FLAGS = {
  scenario: 'E2E_SCENARIO',
  name: 'E2E_PROJECT_NAME',
  phases: 'E2E_PHASES',
  'expected-changed-repos': 'E2E_EXPECTED_CHANGED_REPOS',
  out: 'E2E_OUT_DIR',
  repos: 'E2E_REPOS',
  'base-branch': 'E2E_BASE_BRANCH',
  'question-strategy': 'E2E_QUESTION_STRATEGY',
  'clarifying-questions': 'E2E_CLARIFYING_QUESTIONS',
  description: 'E2E_DESCRIPTION',
  cli: 'E2E_CLI',
};

// Boolean flags: --flag (true) or --no-flag (false)
const BOOLEAN_FLAGS = {
  'skip-cleanup': 'E2E_SKIP_CLEANUP',
  teardown: 'E2E_TEARDOWN',
  'expect-prs': 'E2E_EXPECT_PRS',
};

export function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;

    let body = token.slice(2);
    let negated = false;
    if (body.startsWith('no-')) {
      negated = true;
      body = body.slice(3);
    }

    let key = body;
    let inlineValue;
    const eq = body.indexOf('=');
    if (eq !== -1) {
      key = body.slice(0, eq);
      inlineValue = body.slice(eq + 1);
    }

    if (Object.prototype.hasOwnProperty.call(BOOLEAN_FLAGS, key)) {
      const envKey = BOOLEAN_FLAGS[key];
      if (inlineValue !== undefined) out[envKey] = inlineValue;
      else out[envKey] = negated ? 'false' : 'true';
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, key)) {
      const envKey = VALUE_FLAGS[key];
      if (inlineValue !== undefined) {
        out[envKey] = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !String(next).startsWith('--')) {
          out[envKey] = next;
          i += 1;
        } else {
          out[envKey] = '';
        }
      }
    }
  }
  return out;
}
