# Repository guidance

This file is the shared implementation and review standard for contributors and coding agents across the repository. Follow any additional guidance in the directory being changed.

The goal is a PR that preserves working behavior and is well designed, understandable, and easy to maintain. Focus on correctness, regressions, established contracts, and KISS. Formatting preferences and minor code choices belong to the automated tools, not review findings.

## Understand the change

Read the relevant documentation, surrounding implementation, callers, and tests before editing or reviewing. Documentation describes intended behavior; code, package scripts, and CI show what is implemented and checked. Investigate discrepancies instead of assuming either side is correct.

| Start here                                                                         | Purpose                                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md)                         | Product overview, setup, contribution process                  |
| [Architecture](docs/concepts/architecture.md)                                      | Request path, agent runtime, authentication, infrastructure    |
| [Execution](docs/concepts/execution.md), [data model](docs/concepts/data-model.md) | Lifecycle, ownership of state, scheduling, artifacts, delivery |
| [Workflows and blocks](docs/concepts/workflows-and-blocks.md)                      | Versioning, scope selection, sensors, reviewers, human gates   |
| [Testing](docs/development/testing.md)                                             | Deterministic tests and manual integration/E2E procedures      |
| [User guides](docs/using-the-platform/)                                            | Expected user behavior for the feature being changed           |

## Project map

| Area                                 | Responsibility                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/src/`                      | React/TypeScript application: API clients in `services/`, state and subscriptions in `hooks/` and `contexts/`, screens in `pages/`, reusable UI in `components/` |
| `lambda/<name>/`                     | JavaScript ES-module Lambda workspaces, generally with `index.js` entry points and `test/` suites                                                                |
| `lambda/shared/`                     | Shared contracts, persistence helpers, authorization, provider adapters, and registries                                                                          |
| `lambda/v2-orchestrator/`            | Durable intent orchestration, gates, parallel lanes, delivery                                                                                                    |
| `lambda/agentcore/`                  | Agent runtime, CLI drivers, MCP tools, workspace and engine-owned Git operations                                                                                 |
| `lambda/yjs-server/`, `lambda/ws-*/` | Separate collaborative editing and application-event transports                                                                                                  |
| `terraform/`, `scripts/`             | Infrastructure, packaging, installation, deployment, release tooling                                                                                             |
| `docs/`, `zensical.toml`             | Documentation content and site navigation                                                                                                                        |

New work uses v2 intents and AgentCore. Retired v1 sprint history remains readable; do not accidentally re-enable its removed execution paths.

## Implementation and maintainability

- Keep the change focused on the requested behavior. Avoid unrelated refactors, dependency upgrades, or repository-wide formatting.
- Extend the existing owner of a responsibility. Prefer straightforward code and the smallest abstraction that solves the actual problem. Avoid speculative frameworks, duplicate sources of truth, and fallback paths without a supported use case.
- Preserve the dependency direction enforced by [.dependency-cruiser.cjs](.dependency-cruiser.cjs): workspaces may use `lambda/shared/`, but shared production code must not import workspaces, and workspaces must not import each other's internals. Do not introduce cycles or production imports of tests.
- Reuse helpers and registries before adding parallel implementations: `response.js`, `authz.js`, `v2-process-keys.js`, `v2-process-store.js`, `agent-command-registry.js`, and `artifact-extractors.js` in `lambda/shared/`; Git adapters in `lambda/shared/git-providers/`; tracker adapters in `lambda/trackers/providers/`.
- Route frontend API calls through domain services and `frontend/src/services/api.ts` so authentication, structured errors, and session expiry remain consistent. Reuse the existing hooks and UI components for collaboration and interaction patterns.
- Keep runtime dependencies in the owning package and verify deployment packaging. A package being available in the development dependency tree does not prove it will be present in a Lambda bundle or runtime container. Keep AWS SDK ranges aligned with `npm run sdk:sync` when changing them, and update the applicable lockfile.
- Follow the established pattern when it serves the requirement. A justified change to a pattern is valid: explain the reason, update affected consumers, and cover compatibility. Existing accidental complexity is not a reason to add more.
- Update the relevant documentation when behavior, configuration, or an architectural contract changes. Keep this file concise; put detailed designs and runbooks in `docs/` and link them here.

## Contracts to preserve

Apply the following checks where the change touches the relevant area.

**State and history.** DynamoDB execution state is authoritative for orchestration, recovery, and lane scheduling. Neptune holds knowledge and traceability; authored artifact Markdown is canonical and derived items/edges are rebuildable projections. Preserve identifiers, provenance, immutable history, and supersession on rewind. Do not drive scheduling from the graph projection.

**Pinned configuration.** Running intents use pinned workflow versions and captured runtime/environment settings. Later workflow, project, or environment edits must not silently retarget an existing execution. Use the shared runtime-target and snapshot helpers.

**Durable execution and recovery.** Orchestrator side effects belong inside durable `ctx.step(...)` boundaries. Operation names and order are part of replay compatibility for executions already in progress. Worker state changes must enforce run and stage-attempt ownership atomically with the write; a prior read alone does not guard against rewind. Preserve the `orchestratorRunId` / `stageCallbackId` contract, duplicate-delivery behavior, and supported legacy records described in the recovery guide.

**Human gates and delivery.** Preserve park/resume, recorded answers, conversation recovery, and the independence of parallel lane questions. Required human gates and blocking sensors must still gate progress. In the agent runtime, Git and repository credentials belong to the engine; work must survive park/failure, and partial multi-repository integration must not unblock dependent units.

**Authorization and credentials.** Check both authenticated identity and access to the requested project/entity on the backend. Preserve the distinction between platform administration and project membership. Realtime tokens must remain bound to identity and scope. Reuse credential resolution and safe logging; keep provider/model secrets out of browser responses, logs, fixtures, and generated artifacts. For changes to these paths, cover denied access as well as success.

**Realtime and frontend state.** Application WebSocket events and Yjs document sync are separate transports. Yjs server memory is not durable storage. Preserve persisted-state loading, reconnect/token refresh, event deduplication where applicable, subscription cleanup, and isolation when switching intents or projects. Hydration must not overwrite concurrent edits or duplicate initial document content.

**APIs and deployment.** Trace changes to request/response shapes, event payloads, persisted records, and runtime commands through every producer and consumer, including frontend types and Terraform routes, permissions, and environment wiring. Check existing data, in-flight executions, and supported providers/CLIs. Explain any migration or coordinated deployment requirement; do not assume a clean install.

## Validation

Run commands from the repository root unless noted. Use a Node version supported by CI (22 or 24); the frontend requires at least Node 22.22. Install backend dependencies with `npm ci` and the separate frontend dependency tree with `npm --prefix frontend ci`.

Start with focused checks, then broaden when shared contracts or dependencies change. The package scripts and [CI workflows](.github/workflows/) are authoritative for commands and enforced checks.

| Change                                | Checks                                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS/TS code                            | `npm run lint`, `npm run format:check`, `npm run secretlint`                                                                                                                                               |
| Backend behavior                      | `npx vitest run --project=<name>` (for example `--project=intents` or `--project=agentcore`); use `npm test` for the full backend suite when the impact spans workspaces                                   |
| Backend module boundaries             | `npm run dep:check`                                                                                                                                                                                        |
| AWS SDK dependencies                  | `npm run sdk:check`                                                                                                                                                                                        |
| Frontend behavior                     | `npm --prefix frontend test` and `npm --prefix frontend run build` (includes TypeScript checking)                                                                                                          |
| Installer, release, or script tooling | `npm run test:release`, plus syntax checks for changed shell scripts                                                                                                                                       |
| Terraform                             | `terraform -chdir=terraform fmt -check -recursive`; follow the temporary local-backend override and init/validate procedure in [Terraform CI](.github/workflows/terraform.yml). Do not commit the override |
| Markdown only                         | `npm run format:check -- <changed-files>` and verify links; application tests are unnecessary unless behavior also changes                                                                                 |
| Published docs or navigation          | `uv sync --group docs`, then `uv run zensical build` (Python 3.12+)                                                                                                                                        |

The root Vitest configuration starts Gremlin and DynamoDB Local through Testcontainers, even for a selected backend project; it needs a working Docker daemon. Root `npm test` does not run the frontend suite or `scripts/test/*.test.mjs`. Frontend tests use jsdom without those containers.

For behavior changes, add or adjust tests that exercise the contract and the actual failure/regression scenario. Include relevant error, retry, concurrency, or compatibility paths; avoid tests that merely mirror implementation details. Prefer the existing test harnesses and injectable clients/clocks over new parallel infrastructure.

The credentialed agent E2E and deployed-stack procedures in the testing guide make real model calls or touch AWS resources. Use them when the task includes that validation; they are not routine unit checks. Local hooks may skip checks when optional tools are missing, so a successful hook is not evidence that every check ran.

Record what ran, what passed or failed, and what could not be checked. Distinguish a missing prerequisite or pre-existing failure from a regression introduced by the change. Do not claim a test passed without running it or seeing its result.

## PR review standard

When asked to review, provide findings without editing the PR unless fixes are requested. Review the proposed diff against its intended base, then follow changed behavior into callers, consumers, tests, docs, and deployment wiring. Use a merge-base comparison when reviewing a branch; do not include unrelated work from the target branch. If the base or requirements are uncertain, state the assumption.

Answer these questions:

1. **What does it do?** Explain the problem, the resulting user/system behavior, and the main design choices. Give a before/after example when useful.
2. **Is it correct?** Check the real execution path, failure handling, authorization, state transitions, and side effects. Passing tests support the review but do not replace tracing the implementation.
3. **Can it regress existing behavior?** Check affected callers, persisted data, retries/replay, concurrent work, existing configurations, and relevant providers/CLIs. Follow the contracts above and identify concrete gaps in regression coverage.
4. **Does it respect established patterns?** Cite the relevant implementation or documented contract and explain the practical cost of a deviation. Do not treat an unfamiliar approach as a defect by itself.
5. **Is it maintainable and simple?** Look for unclear ownership, duplicated business rules, unnecessary coupling, abstractions without a current need, and complexity that makes the affected behavior harder to change safely.

Report an issue only when it is introduced or made materially worse by the PR and has a concrete correctness, regression, security, operational, or maintenance impact. Verify the relevant code path before asserting a bug. If evidence is incomplete, label the uncertainty or ask a focused question. Keep pre-existing issues separate.

Each finding should contain:

- **Severity and a specific title:** P0 for an immediate critical failure, P1 for a high-impact issue, P2 for a material but bounded issue. Explain impact instead of relying on the label alone.
- **Location:** the smallest useful changed file/line reference.
- **Evidence:** the triggering input, state, or sequence; what happens; and what should happen under the existing contract. Cite a caller, test, or document when it establishes the expectation.
- **Consequence and direction:** who or what breaks, and a concise correction or regression-test suggestion. Do not prescribe a broad rewrite when a local fix suffices.

Order findings by severity and combine duplicates with the same root cause. Exclude formatting, naming preferences, minor code rearrangements, and speculative future requirements unless they cause a demonstrated problem. A maintainability finding must explain the concrete ongoing cost.

Return a short behavior/design summary, actionable findings, validation performed and remaining gaps, and an overall assessment of whether changes are needed. If no material issues are found, say so explicitly; include any limits on that conclusion. Keep optional suggestions clearly separate from required fixes.
