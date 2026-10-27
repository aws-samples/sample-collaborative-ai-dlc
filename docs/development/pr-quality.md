# PR quality reports

CI updates one PR comment with cognitive-complexity, dependency counts, and branch-coverage changes
for source files changed between the merge base and PR commit. Findings are advisory: functions above 15 appear
when complexity or coverage worsens, or when the function is new/unmatched.
Unchanged debt is omitted; improvements appear separately.

## Reading the table

| Column              | Meaning                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Complexity / Δ      | Before → after score and change                                                                      |
| Depending files     | Direct production importers at the PR commit; backend only, excluding tests and AWS/external callers |
| Branch coverage / Δ | Covered branch outcomes and change in percentage points                                              |
| Uncovered branches  | Outcomes not exercised by tests, before → after                                                      |
| Icon                | 🟢 improving, 🟠 mixed/small regression, 🔴 large regression, 🟣 both metrics worsen substantially   |

Existing functions use complexity deltas even when coverage is unavailable.
Complexity increases turn red at `max(5, 20% of base)` for backend and `max(10, 20% of base)` for frontend,
adjusted by coverage changes.
New/unmatched functions use current complexity: orange above 15,
red above 50, purple above 100. Coverage below 50% raises this one level.
More than 10 depending files raises an existing warning one level, capped at purple,
when coverage is below 50% or regresses. Green improvements stay green.
These are review heuristics; use the numbers to judge each finding.

**Unknown** means coverage is missing or incompatible.
**n/a** means no branch outcomes or frontend dependency counts; **\*** marks coverage from failing/incomplete tests.
Coverage comparisons allow Node minor/patch differences within the same major; Vitest, provider, and configuration must match.
**New or unmatched** means no reliable previous function match—not necessarily new code.
The comment shows up to 20 findings and 20 improvements; artifacts contain all results.

## CI

Backend and frontend suites run independently at both revisions when their source, tests, or configuration change.
Docs-only and Terraform-only PRs skip coverage. Frontend-only PRs skip the backend suite.
Each `coverage-base-*` / `coverage-pr-*` artifact contains the requested suites' measurements.
Dependency analysis failures leave only those counts unknown. Partial reruns reuse artifacts only when their producers
were not rerun; missing or stale results are reported explicitly.

Same-repository PRs can comment immediately. Forks and Dependabot need the comment
workflow on the default branch; it validates report data without executing PR code.
Artifacts are retained for seven days: `complexity-*` lists every function in changed files with
base/PR scores and coverage; `dependencies-*` lists their direct production importers.
Both include Markdown and JSON. `pr-quality-*` holds the data used to publish the comment.

## Local use

```bash
npm run complexity
npm run complexity:compare -- --base origin/main --pr HEAD
```

The comparison reads committed source and writes JSON/Markdown to `reports/complexity/`.
Local hooks do not collect coverage or post comments.
