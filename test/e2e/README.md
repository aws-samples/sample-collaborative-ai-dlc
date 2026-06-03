# AI-DLC E2E Harness

Realistic end-to-end test: real Cognito SRP login + REST API driving the full
inception -> construction -> review -> PR flow across multiple repos, with a
Playwright browser observer that screenshots the real UI at every step for human
review.

## Setup

1. `cd test/e2e && npm install && npx playwright install chromium`
2. `cp .env.e2e.example .env.e2e` and fill in `E2E_USERNAME`, `E2E_PASSWORD`,
   `E2E_FRONTEND_URL`, `E2E_REPOS` (first = primary). Pool/client/API/region are
   read from `frontend/.env`.
3. Ensure the test user's GitHub is connected in the app (server-side token).

## Run

- Unit tests: `npm test`
- Full E2E (hits staging, creates real PRs, never merges): `npm run e2e`

Artifacts: `test/e2e/artifacts/<runId>/report.html` (open in a browser) +
`screenshots/`, `events.jsonl`, `summary.json`. The report shows a metrics strip
(durations per phase, repos, questions, PRs, review result + risk score) and a
collapsible screenshot timeline.

## Scenarios

The run is driven by a scenario (`scenarios.mjs`). Default: `multi-changed`.

| Scenario        | Phases (default)                | Expectation                                      |
| --------------- | ------------------------------- | ------------------------------------------------ |
| `single-repo`   | inception, construction         | exactly one PR, on the primary repo              |
| `multi-changed` | inception, construction         | one PR per changed repo, none on unchanged repos |
| `no-change`     | inception, construction         | zero PRs, but construction must really run       |
| `review-cycle`  | inception, construction, review | PRs created, then blind+full review produced     |

## Parameters

Configurable via env (`.env.e2e` or process env) or CLI flags. Precedence:
**CLI flag > env > .env files**.

| CLI flag                     | Env                              | Meaning                                                          |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `--scenario <name>`          | `E2E_SCENARIO`                   | scenario to run (default `multi-changed`)                        |
| `--phases <csv>`             | `E2E_PHASES`                     | phases to execute, e.g. `inception,construction,review`          |
| `--expected-changed-repos`   | `E2E_EXPECTED_CHANGED_REPOS`     | deterministic changed-repo set (skips GitHub `aheadBy`)          |
| `--repos <csv>`              | `E2E_REPOS`                      | repos, first = primary                                           |
| `--base-branch <name>`       | `E2E_BASE_BRANCH`                | base branch (default `main`)                                     |
| `--question-strategy <name>` | `E2E_QUESTION_STRATEGY`          | how agent questions are answered (default `default-answer`)      |
| `--out <dir>`                | `E2E_OUT_DIR`                    | artifacts root dir                                               |
| `--skip-cleanup`             | `E2E_SKIP_CLEANUP`               | leave the Neptune project/sprint for inspection                  |
| `--teardown`                 | `E2E_TEARDOWN`                   | close created PRs + delete branches (never merges)               |
| `--no-expect-prs`            | `E2E_EXPECT_PRS=false`           | invert the PR expectation                                        |
| (env only)                   | `E2E_REQUIRE_RUNNING_TRANSITION` | require an observed RUNNING->COMPLETED transition (default true) |
| (env only)                   | `E2E_REQUIRE_TASK_COMPLETION`    | require >=1 completed task before asserting PRs (default true)   |

### Examples

```bash
# Target a specific scenario + phases
node run.mjs --scenario multi-changed --phases inception,construction

# Deterministic assertion (no dependency on GitHub aheadBy)
node run.mjs --scenario multi-changed --expected-changed-repos org/repo-a,org/repo-b

# Full review cycle, keep state for inspection
node run.mjs --scenario review-cycle --skip-cleanup

# Inspect without cleanup
E2E_SCENARIO=review-cycle E2E_SKIP_CLEANUP=true npm run e2e
```

## Robustness — phase completion

The shared `/agents` status field is phase-agnostic and can momentarily report
the _previous_ phase's terminal status right after a new phase starts. To avoid
false `PASS`:

- **Construction** is only accepted as complete once an observed
  `RUNNING -> COMPLETED` transition is seen (`sawRunning` then `completed`),
  plus, when PRs are expected, at least one task reaching `done`.
- **Review** completion is detected on the business signal — the Review node
  carrying both `blindReview` and `fullReview` — not the shared status.

Assertions (`assertE2EExpectations`) fail with explicit reasons:
`phase-never-ran`, `phase-completed-without-transition`, `tasks-never-completed`,
`no-prs-created`, `unexpected-prs-created`, `review-never-ran`, `review-incomplete`.

## Review flow

For `review-cycle` (or any run including the `review` phase): the harness moves
the sprint to REVIEW, creates the Review node (`POST /sprints/:id/review`),
launches `review-blind` + `review-full` in parallel (mirrors the UI "Kick-Off
Review Agents" button), then waits for both reviews and captures status + risk
score. `review-modify` is not driven automatically.

## Assertion

With `E2E_GITHUB_TOKEN` set (or `--expected-changed-repos`), the run asserts PRs
are created only on repos with commits ahead of base (no PR on unchanged repos,
no missing PR on changed ones). Otherwise it validates phase signals and PR
presence only.

## Teardown

Set `E2E_TEARDOWN=true` / `--teardown` (with a token) to close created PRs and
delete branches after the run. It NEVER merges.
