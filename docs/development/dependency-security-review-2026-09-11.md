# Dependency security review — 2026-09-11

Base: `f7e22dd0ed17745c41e9bc11998823609e59927e` (`main`).
Branch: `chore/dep-upgrades`.

The review found 14 open Dependabot alerts and two open CodeQL alerts. Secret scanning
had no open alerts. A fresh npm audit also identified the Nano ID advisory in both
the backend and frontend development dependency trees.

## Upgrade compatibility and risk

Risk means the likelihood and impact of an application or tooling regression after
the upgrade, rather than the severity of the original vulnerability. Versions below
are resolved lockfile versions. All changed packages are listed, including Vitest's
internal dependencies.

Each runtime dependency and each brace-expansion major version was installed and
checked separately before the next upgrade. Nano ID was checked separately in the
root and frontend trees. The Vitest packages were upgraded as a matching set in each
tree because they declare exact internal dependencies and coverage peer versions;
their individual changes were reviewed separately.

| Package                                                 | Previous → selected                       | Risk       | Compatibility review and remaining risk                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `js-yaml`                                               | 4.3.1 → **4.3.2**                         | **Medium** | Same v4 API and dependency requirements. The patch counts empty merge sources and introduces a maximum of 100 mappings in a merge sequence. Unusually large YAML merge sequences can now be rejected; ordinary workflow metadata, artifact parsing, and seeding passed 71 application tests. Normal aliases and rejection of the empty-source budget bypass are covered by a regression test. |
| `brace-expansion`, through `readdir-glob` / minimatch 5 | 2.1.2 → **2.1.4**                         | **Low**    | Retains the callable CommonJS API and balanced-match v1 requirement. Bounds total expansion characters and intermediate results. Extreme patterns can be truncated; normal patterns and an actual ZIP export selecting nested JS/TS files passed before upgrading the other copy.                                                                                                             |
| `brace-expansion`, through `glob` / minimatch 10        | 5.0.7 → **5.0.9**                         | **Low**    | Retains the named `expand` API and balanced-match v4 requirement. Drops Node 18 support; the repository uses Node 22/24 in CI and Node 24 for Lambda/AgentCore. Expansion limits, padded ranges, and ZIP generation passed independently after this change.                                                                                                                                   |
| `hono`                                                  | 4.13.0 → **4.13.5**                       | **Low**    | Satisfies the MCP SDK's `^4.11.4` range and Node >=16.9 requirement. Tightens query-fragment handling, static generation paths, and opt-in dotted form nesting (32 levels / 10,000 intermediate objects). The application does not directly use Hono static generation or dotted parsing. Normal queries/forms, rejection cases, and 82 MCP application tests passed.                         |
| `qs`                                                    | 6.15.3 → **6.16.0**                       | **Low**    | Satisfies Express and body-parser ranges; dependency requirements are unchanged. The new stringify depth option defaults to Infinity. Strict comma-array limit handling changes only when those options are enabled. Normal nested values, both advisory cases, and a real loopback HTTP form request through the MCP SDK's Express app passed.                                               |
| `nanoid` (root and frontend)                            | 3.3.16 → **3.3.18**                       | **Low**    | Stays on v3 and satisfies PostCSS's `^3.3.16` range. No dependency or Node engine changes. Normal ID generation and zero-size custom generators were checked for ESM, CommonJS, browser, and async browser entry points in each tree. The frontend production build passed before upgrading its Vitest.                                                                                       |
| `vitest`                                                | root 4.1.10 / frontend 4.1.9 → **4.1.11** | **Low**    | Uses the security backport within v4. Existing Node 22/24 and Vite 8 satisfy its engines and peers. Backend mocks, projects, and coverage passed 1,516 tests; frontend tests and build passed separately. Browser access restrictions and restored lifecycle concurrency can affect unusual test setups; no configuration changes were needed here.                                           |
| `@vitest/coverage-v8` (root)                            | 4.1.10 → **4.1.11**                       | **Low**    | Exact peer `vitest@4.1.11` is satisfied. The upstream patch changes package/version alignment, not coverage implementation. Coverage generation passed for 94 shared/agent runtime test files.                                                                                                                                                                                                |
| `@vitest/mocker`                                        | root 4.1.10 / frontend 4.1.9 → **4.1.11** | **Low**    | Contains the redirect-mock filesystem allowlist fix. Mocks deliberately reading outside the permitted filesystem scope can now fail. Existing backend mocks and all 540 frontend tests passed.                                                                                                                                                                                                |
| `@vitest/runner`                                        | root 4.1.10 / frontend 4.1.9 → **4.1.11** | **Low**    | Restores the global concurrency limit for test lifecycle hooks. This can change timing/concurrency, so the project-based backend suite and frontend suite were run. No runner configuration changes were required.                                                                                                                                                                            |
| `@vitest/expect`                                        | root 4.1.10 / frontend 4.1.9 → **4.1.11** | **Low**    | Upstream patch changes version alignment, without assertion implementation changes. Existing assertions, including AWS client mock matchers and frontend DOM matchers, passed.                                                                                                                                                                                                                |
| `@vitest/pretty-format`                                 | root 4.1.10 / frontend 4.1.9 → **4.1.11** | **Low**    | Version alignment without implementation changes in these patches. Assertion formatting and snapshot consumers were exercised by both suites.                                                                                                                                                                                                                                                 |
| `@vitest/snapshot`                                      | root 4.1.10 / frontend 4.1.9 → **4.1.11** | **Low**    | Version alignment without implementation changes in these patches. No snapshot updates were needed.                                                                                                                                                                                                                                                                                           |
| `@vitest/spy`                                           | root 4.1.10 / frontend 4.1.9 → **4.1.11** | **Low**    | Version alignment without implementation changes in these patches. Existing spies, mock resets, and AWS client mocks passed in the backend/frontend suites.                                                                                                                                                                                                                                   |
| `@vitest/utils`                                         | root 4.1.10 / frontend 4.1.9 → **4.1.11** | **Low**    | Version alignment without implementation changes in these patches. Internal consumers and the coverage provider resolve the matching version and passed their checks.                                                                                                                                                                                                                         |

Vite, Rolldown, PostCSS, Lightning CSS, AWS SDKs, and all unrelated lockfile versions
are unchanged. Both complete dependency trees passed `npm ls --all`. Clean `npm ci
--ignore-scripts` installations verified each resulting lockfile.

AgentCore's Dockerfile installs its own manifest, independently of the workspace
lockfile. The manifest now pins js-yaml 4.3.2 and overrides Hono to 4.13.5 and qs to
6.16.0. Changing that manifest also changes Terraform's image source hash and
invalidates Docker's dependency-install layer, so deployment rebuilds the runtime
with the fixes. These pins passed a separate production-only installation and
application smoke test. **Low compatibility risk for these pins; medium residual
rebuild risk** because the image's other pre-existing dependency ranges still float.
The production install was audited and exercised; the full Docker image and live AWS
deployment were not built or deployed in this review.

## Finding coverage

| Findings                                                                                     | Mitigation                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dependabot **208** — `GHSA-2883-xcg3-v3hh`                                                   | js-yaml 4.3.2                                                                                                                                                                                                                                                                                                            |
| Dependabot **205–207** — `GHSA-crvj-82cr-hjcx`, `GHSA-g6gw-c38x-mqfc`, `GHSA-gqvv-2mrq-wpjv` | Hono 4.13.5                                                                                                                                                                                                                                                                                                              |
| Dependabot **201–204** — `GHSA-82fw-gwwq-j7x9`                                               | Vitest and mocker 4.1.11 in both trees                                                                                                                                                                                                                                                                                   |
| Dependabot **199–200** — `GHSA-4mjr-xmp4-gh2g`, `GHSA-x5fp-wj9c-mxmx`                        | qs 6.16.0                                                                                                                                                                                                                                                                                                                |
| Dependabot **161–162, 170–171** — `GHSA-mh99-v99m-4gvg`, `GHSA-rgw5-rvv9-x895`               | Both brace-expansion copies patched on their current major versions                                                                                                                                                                                                                                                      |
| npm audit — `GHSA-2v37-7h3g-55p8`                                                            | Nano ID 3.3.18 in both trees                                                                                                                                                                                                                                                                                             |
| CodeQL **25** — clear-text logging                                                           | The empty realtime-secret error no longer embeds the configured SSM parameter path. The generic HTTP 500 response and useful exception/request diagnostics remain. Regression checks cover the log and successful token generation. **Low change risk.**                                                                 |
| CodeQL **24** — environment-derived shell command                                            | The release test process helper explicitly uses `shell: false`; the single fixed `bash -c` probe is kept separate from the helper that accepts script paths. A regression verifies literal paths/arguments containing spaces and shell metacharacters without command execution. **Low change risk; test tooling only.** |

## Open Dependabot PRs

- [PR #425](https://github.com/aws-samples/sample-collaborative-ai-dlc/pull/425)
  upgrades qs to 6.16.0. Its diff and successful existing CI checks were reviewed.
  The same dependency fix is incorporated and independently tested here.
- [PR #448](https://github.com/aws-samples/sample-collaborative-ai-dlc/pull/448)
  is titled as a mocker upgrade but actually changes frontend Vitest to 5.0.0.
  Its existing CI is successful. The v5 release includes changes to mock clearing,
  sequential options, hook validation, configuration resolution, and assertions.
  **Medium migration risk** compared with the available v4 security backport.
  This PR selects and tests 4.1.11 instead; it does not locally claim validation of v5.

The existing bot PRs are left open for the maintainer to resolve when this combined PR merges.

## Verification

- Frontend baseline: **77 files / 540 tests passed**, followed by a successful production build.
- js-yaml alone: **5 files / 71 tests passed**, plus the bounded merge-budget check.
- brace-expansion 2.1.4 and 5.0.9: separate normal-expansion, resource-limit, and ZIP checks passed.
- Hono alone: **3 files / 82 MCP tests passed**, plus normal/adversarial query and form checks.
- qs alone: both advisory regressions and the MCP Express HTTP form check passed.
- Nano ID: all four entry points checked separately in both trees; frontend build passed.
- Backend Vitest/coverage: **94 files / 1,516 tests passed** on Node **24.18.0**.
  This focused coverage run excluded the two graph integration files; the complete
  backend run is recorded separately below.
- Complete backend suite on Node **22.22.2**: **158 files / 2,837 tests passed**, including
  the graph and durable orchestration integration tests.
- Frontend Vitest: **77 files / 540 tests passed** and production build passed on Node **24.18.0**.
- Release tooling and dependency security regressions: **63 tests passed**.
- All Lambda workspace build commands passed, and **37 built ESM entry points**
  imported successfully in fresh Node 24 processes.
- Standalone AgentCore production installation: **zero audit vulnerabilities**,
  exact js-yaml/Hono/qs security pins verified, YAML parsing and HTTP `/ping` passed,
  and the actual MCP server initialized and listed **20 tools** over stdio. This
  also checks the current floating MCP SDK 1.30.0 installation, separately from
  the workspace's locked SDK 1.29.0.
- CodeQL-related intent paths: **5 selected tests passed**, including successful realtime
  token generation, generic error responses, and preserved diagnostic context.
- Complete npm audits, including development dependencies: **zero vulnerabilities** in
  root, frontend, standalone Yjs, and the existing Cognito lockfile.
- Formatting, changed-file secretlint, and AWS SDK alignment checks passed. Lint passed with existing unrelated
  warnings; SDK alignment retains the existing Smithy warning. Production frontend
  builds retain the baseline large-chunk warning.

The checks use local Gremlin and DynamoDB containers, application tests, dependency
regressions, and production frontend builds. They do not deploy or exercise a live AWS
environment. GitHub security alerts are tracked against the default branch and will
remain open until the fixes merge and the corresponding scans complete.

## Upstream evidence

- [js-yaml 4.3.2 changelog](https://github.com/nodeca/js-yaml/blob/4.3.2/CHANGELOG.md)
- [brace-expansion resource-limit advisory](https://github.com/advisories/GHSA-rgw5-rvv9-x895)
- [Hono 4.13.5 release](https://github.com/honojs/hono/releases/tag/v4.13.5)
- [Hono changes from 4.13.0](https://github.com/honojs/hono/compare/v4.13.0...v4.13.5)
- [qs 6.16.0 changelog](https://github.com/ljharb/qs/blob/v6.16.0/CHANGELOG.md)
- [Nano ID advisory](https://github.com/advisories/GHSA-2v37-7h3g-55p8)
- [Vitest 4.1.10 release](https://github.com/vitest-dev/vitest/releases/tag/v4.1.10)
- [Vitest 4.1.11 release](https://github.com/vitest-dev/vitest/releases/tag/v4.1.11)
- [Vitest 4.1.11 changes](https://github.com/vitest-dev/vitest/compare/v4.1.10...v4.1.11)
- [Vitest 5.0.0 release](https://github.com/vitest-dev/vitest/releases/tag/v5.0.0)

Published npm package manifests were also checked for exact versions, dependency
requirements, integrity hashes, engine ranges, and peer compatibility.
