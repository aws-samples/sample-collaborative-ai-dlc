# PR review signals

One automatically computed, deterministic PR comment combines quality metrics and an
[Isobar](https://github.com/r3al1tym/isobar) repository map. Both sections open by default and can be collapsed independently.
Quality metrics cover source files changed between the merge base and PR commit. Findings are advisory: functions above 15 appear
when complexity or coverage worsens, or when the function is new/unmatched.
Unchanged debt is omitted; improvements appear in the same table.
When no source files are analyzed, or no findings, improvements, or analysis warnings remain,
the quality section is omitted. Without a map, CI removes its previous quality-only comment.
The map can remain visible for infrastructure, CI or documentation changes.

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

**—** marks unavailable coverage; **unknown** marks unavailable backend dependency counts.
**n/a** means no branch outcomes or frontend dependency counts; **\*** marks coverage from failing/incomplete tests.
Coverage comparisons allow Node minor/patch differences within the same major; Vitest, provider, and configuration must match.
**New or unmatched** means no reliable previous function match—not necessarily new code.
Rows are sorted 🟣 → 🔴 → 🟠 → 🟢. The first 10 are visible, or all purple rows if there are more;
the remaining rows appear under “Show more”. GitHub comment size limits still apply; artifacts contain all results.
Coverage diagnostics stay in the artifacts; the comment shows one notice if measurements are unavailable or incomplete.

## Reading the map

The atlas stays fixed across PRs. Red marks changed files; green marks static name matches or import links.
These links show possible reach, not proven runtime impact or a risk grade.
A/B identify changed files described in Signals; they need not match the first functions in the quality table.
The Legend explains marker shapes, test/documentation colors and solid/dotted links.
Terraform/IAM, CI and documentation changes can have a map even when production JS/TS metrics do not apply.

## CI

Backend and frontend suites run independently at both revisions when their source, tests, or configuration change.
Tools come from the workflow's merge commit so older PR branches need not contain them; tests still use the exact base and PR revisions.
Docs-only and Terraform-only PRs skip coverage. Frontend-only PRs skip the backend suite.
Each `coverage-base-*` / `coverage-pr-*` artifact contains the requested suites' measurements.
Dependency analysis failures leave only those counts unknown. Partial reruns reuse artifacts only when their producers
were not rerun; missing or stale results are reported explicitly.

`PR Review Signals` uses `pull_request_target` and the trusted default-branch controller.
It reads contributor Git objects as data without checking out or executing contributor code.
For supported fork events, the static report can run before contributor-code approval, subject to
[GitHub's event policies](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).
The existing `PR Quality` workflow uses `pull_request`; its tests retain the fork-approval policy.
Approved coverage runs enrich the same comment through a trusted publisher; later static updates preserve valid measurements.
The target workflow activates once it exists on the default branch; existing PRs update on their next supported event.

Artifacts are retained for seven days: `complexity-*` lists every function in changed files with
base/PR scores and coverage; `dependencies-*` lists their direct production importers.
Both include Markdown and JSON. `pr-quality-*` holds the data used to publish the comment.
`review-signals-*` contains the map PNG, static evidence and quality JSON.

The fixed atlas and file positions live in `.isobar/map.json` and `.isobar/anchors.json`.
The `pr-impact-assets` branch stores images and validated snapshots; comments link to an immutable asset commit.
Updates replace the same bot comment with one image. Full results remain in the linked artifacts when the display is shortened.
Run `npm run test:release` when changing the atlas or reporting tools.

## Local use

```bash
npm run complexity
npm run complexity:compare -- --base origin/main --pr HEAD
```

The comparison reads committed source and writes JSON/Markdown to `reports/complexity/`.
Local hooks do not collect coverage or post comments.
