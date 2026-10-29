# PR review signals and Isobar maps

One bot comment combines the existing cognitive-complexity and branch-coverage report with an
[Isobar](https://github.com/r3al1tym/isobar)-based map of the repository. The map is a fixed atlas:
the same file stays at the same position across PRs. CI computes the overlays deterministically;
it never calls a model or regenerates the architecture.

## Reading the comment

The bold title identifies the report as automatically computed. Quality and Isobar are independently
collapsible and open by default. The quality table keeps the existing order and scoring: ten
functions are initially visible, or more when needed to show every purple result. Remaining functions
stay in a closed disclosure. Missing or partial coverage is explicit.

Red marks changed files; green marks static name matches or import links to other files. These
links are possible reach, not proven runtime execution or a risk grade. Tests and documentation use
different marker colors. A/B identify changed files explained in Signals; they need not be the first
functions in the quality table. The short Legend explains marker shapes and solid/dotted links.

Static analysis cannot establish the safety of Terraform/IAM changes, external callers, dynamic
dispatch, or test protection before tests run. No production JS/TS in the analyzer's scope suppresses
the empty quality section, while a useful map and its scope limitation remain visible.

## Automation and forks

`PR Review Signals` uses `pull_request_target`. It checks out only the trusted controller revision,
installs its locked tooling, and fetches contributor Git objects as data. Contributor files, package
scripts, dependencies and configuration are never checked out or executed by this reporter.
The analysis job has read permissions. A separate trusted publisher has `contents: write` and
`pull-requests: write`, and validates the bounded JSON/PNG artifacts before any publication.

For allowed normal PR events, this static report does not need per-run approval of contributor code.
It does not disable repository/organization Actions event policies. GitHub can suppress certain
`pull_request_target` events, including SHA-like branch names. See
[GitHub's security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

The existing `PR Quality` tests still use `pull_request` and retain the fork approval policy.
After an approved test run completes, its validated coverage enriches the same comment. A later
static update preserves applicable measured coverage. The first map can recover a still-available,
same-head legacy quality artifact; expired or incompatible reports are not treated as measurements.

Both publishers share a lock and reject stale heads, changed target refs or merge bases. A target-tip
advance with the same merge base is valid. Human comments are untouched. Updates reuse the owned
`complexity-coverage-report` bot marker and display one image.

## Artifacts and maintenance

The `review-signals-*` artifact contains the map PNG, static evidence JSON, quality JSON and controller
context. The publisher stores images and validated snapshots on the dedicated `pr-impact-assets`
branch. The comment uses an immutable asset commit, so an updated image is not hidden by URL caching.
No generated images or reports are committed to the application branch.

The atlas and stable file anchors are versioned in `.isobar/map.json` and `.isobar/anchors.json`.
Changes to these files are deliberate design changes, reviewed with their tests. Isobar's engine is
pinned to `2ec719904ac7dc30de08e152e4622fe8e02fa57a`; its preview CLI is not used because its
missing-map fallback can invoke inference. Node/TSX tooling is isolated in `scripts/pr-impact/`;
Pillow runs in a Python virtual environment.

Run `npm run test:release` for the tooling tests. Local map previews can use
`scripts/pr-impact/render.mjs` with the pinned engine, full base/head SHAs and a venv Python executable.
Use the trusted checkout as `--repo`: the contributor revision remains an object-store input.

The new target workflow activates after it exists on the default branch. Existing PRs receive a map
on their next supported event. A real external-fork smoke run after merge remains the hosted proof
that the applicable Actions event policies permit the workflow.
