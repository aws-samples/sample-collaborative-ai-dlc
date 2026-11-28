# Native execution: PR plan

Agreed on 2026-11-26. This document is the single source of truth for the native execution work. Names of fields, error codes, commands, files and branches are proposals; a PR may change them.

## Goal

A member runs an intent with the AI-DLC methodology itself ("native") instead of the platform's stage engine. Native reuses the existing runtime image, credential chain, orchestrator, gates, graph and UI. The work lands as small, stacked PRs on `main`, hidden behind a runtime flag until it is ready. The target is near feature parity with platform intents.

## How this document is used

- **Lives in the repository.** The document is committed with PR 1, at the bottom of the stack.
- **Updated in every PR.** Each PR ticks the criteria it meets and records any change to a decision, a criterion or the order.
- **Details per PR.** Details are settled when a PR starts, so the pieces fit together. A decision made there is added to the decisions table.
- **Risk accepted.** The checks under "Checks to do first" happen inside their PR, not before the work starts. A late surprise is an accepted risk.
- **Nothing dropped silently.** Postponed work goes into "Open topics". Whoever works on a PR adds a topic as soon as one comes up.

## Terms

| Term               | Meaning                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform intent    | Today's v2 intent. Unchanged by this plan.                                                                                                  |
| Native intent      | An intent with `engine: "native"`.                                                                                                          |
| Workspace          | The native intent's directory on EFS. It holds the repository checkouts and the CLI's conversation store.                                   |
| Turn               | One run of the coding CLI in the workspace. It ends when AI-DLC waits for a human, reports completion, or fails.                            |
| AI-DLC source      | The Git repository and ref a space takes AI-DLC from.                                                                                       |
| Primary repository | The repository that holds AI-DLC's framework files and records. AI-DLC runs from its root.                                                  |
| Flag               | The SSM parameter `/<project>/<env>/native-execution`, of type `String`. `enabled` switches native on; anything else, or no parameter, off. |

## Decisions this plan is built on

All confirmed by the plan owner on 2026-11-26.

| #   | Decision                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Small PRs into `main`, hidden behind a flag. Reuse the runtime image, credential chain and UI. No separate control plane.                                                                                                                                           |
| D2  | One shared EFS mount. The harness sandbox isolates workspaces from each other.                                                                                                                                                                                      |
| D3  | The flag is a runtime platform setting in SSM, like `stage-skipping`. Terraform has one variable, for the storage only.                                                                                                                                             |
| D4  | The AI-DLC source is a space setting. Unset means upstream `awslabs/aidlc-workflows` at its newest stable release tag.                                                                                                                                              |
| D5  | The source may be any Git repository on any connected provider, private ones included, through the existing connections.                                                                                                                                            |
| D6  | One install path for every source: clone at the ref, run the repository's own packaging script, copy the result into the workspace. No dependency on published releases.                                                                                            |
| D7  | An intent keeps the AI-DLC commit it started with. Updating is an explicit member action, and that action is in the first release.                                                                                                                                  |
| D8  | Claude Code first. Codex, OpenCode and Kiro follow as one PR each.                                                                                                                                                                                                  |
| D9  | No push per turn. With the PR strategy `intent-pr`, commit, push and pull request happen once, at the end. With `pr-per-unit`, each finished unit is also committed, pushed and given its pull request. Changed by D33; it was "once, at the end" for every intent. |
| D10 | AI-DLC's records live inside the primary repository. The commit contains everything Git does not ignore, AI-DLC's framework files included.                                                                                                                         |
| D11 | An intent may have several repositories. The member picks the primary one.                                                                                                                                                                                          |
| D12 | AI-DLC's stages are written into the existing stage rows. The plan the UI joins them against comes from AI-DLC's state file.                                                                                                                                        |
| D13 | Stage rows for native are display only, have one writer, and can be rebuilt from the file. Stage actions (rewind, revise, recompose and similar) are refused in the first release.                                                                                  |
| D14 | No check of the AI-DLC version or identity anywhere. An unknown format degrades to a simpler view; it never blocks a turn.                                                                                                                                          |
| D15 | Near feature parity with platform intents is the target. Attachments and tracker-issue import apply to native intents.                                                                                                                                              |
| D16 | A space's custom MCP servers apply to native turns.                                                                                                                                                                                                                 |
| D17 | A workspace lives until its intent is deleted.                                                                                                                                                                                                                      |
| D18 | Output and usage per stage come after the release. Postponed work is tracked under "Open topics".                                                                                                                                                                   |
| D19 | The PRs are stacked: one branch per PR, named `feat/native-<description>`, each based on the branch of the PR before it. Rebase onto `main` before working. One checkout, no worktrees.                                                                             |
| D20 | Dev is deployed only through `scripts/deploy-terraform.sh dev` and `scripts/deploy-frontend.sh dev`.                                                                                                                                                                |

Three consequences worth knowing before starting:

- **Sandbox always on for native.** D2 only isolates if every native process runs in the sandbox, whatever the Admin sandbox setting says.
- **Source code from the AI-DLC source runs in the runtime.** D6 executes the source's packaging script. It runs in the same sandbox as the CLI.
- **The commit is the version.** With D6 there is no release-signature check. The intent records the exact commit instead.

### Decisions taken in the PRs

Settled when a PR started, on the date given. "Plan owner" means the plan owner chose it. "Proposed" means the PR proposed it and the plan owner raised no objection; it can still be changed.

| #   | PR  | Decision                                                                                                                                                                                                                                                                                         | Source     |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| D21 | 1   | A native draft holds every repository of the space from the start, as a platform intent does. The member's `primaryRepo` is stored and comes first in `repos`. It is required when the space has several repositories. This replaces "one repository until PR 19".                               | Plan owner |
| D22 | 1   | A native draft snapshots every space setting a platform draft snapshots, except workflow, scope, release and stage skipping. Whether a native turn honours a setting is decided by the PR that uses it, or by the parity review in PR 23.                                                        | Plan owner |
| D23 | 1   | For PR 1: local commits on the branch are allowed as validated slices land. Push and pull request wait for the plan owner. Asked again when the next PR starts.                                                                                                                                  | Plan owner |
| D24 | 1   | `engine` on create: absent or `null` is a platform intent and stores nothing. `"native"` is native. Anything else is 400 `engine_invalid`. Only native rows and responses carry `engine` and `primaryRepo`.                                                                                      | Proposed   |
| D25 | 1   | Refused on a native create and on PATCH of a native draft, with 400 `native_input_not_supported`: `scope`, `composedGrid`, `policyScope`, `skipStageIds`, `aidlcSettings`, `methodologyReleaseId`, `methodologyReleaseTest`, `constructionGateAutonomy`, `sparseCheckout`.                       | Proposed   |
| D26 | 1   | `engine` in any PATCH body is 400 `engine_immutable`. A native draft's title, prompt and conversation language can be saved.                                                                                                                                                                     | Proposed   |
| D27 | 1   | A native execution that reaches the orchestrator is refused right after `load-meta`, with reason `native_engine_unsupported`. Nothing is written, so a stray invocation cannot turn a draft into a failed intent.                                                                                | Proposed   |
| D28 | 1   | The space detail response reports `nativeExecution: "enabled" \| "disabled"`, for v2 spaces only. The space list does not report it.                                                                                                                                                             | Proposed   |
| D29 | 1   | Terraform does not create the flag's parameter. A deployment that never set it has native off.                                                                                                                                                                                                   | Proposed   |
| D30 | 1   | A space without a repository cannot hold a native intent (400 `native_repository_required`), because the primary repository holds AI-DLC's records (D10).                                                                                                                                        | Proposed   |
| D31 | 1   | The space detail response keeps the flag for one minute per warm Lambda container, because every open space page polls that response. A switch of the flag reaches the browser within that minute. Intent creation reads the flag uncached. A failed read is logged and counts as disabled.      | Proposed   |
| D32 | 1   | A native create makes the PR-strategy check of a platform create: `pr-per-unit` in a space with a provider that has no draft pull requests is 409 `PR_STRATEGY_UNSUPPORTED`. Changed with D33. Before, the check was skipped, because native delivery did not use the value.                     | Proposed   |
| D33 | 1   | Native intents honour the space's PR strategy. With `pr-per-unit`, a unit that AI-DLC has finished is committed and pushed and gets its pull request, without waiting for the end of the intent. There is still no push per turn. This changes D9 and takes the pull request per unit out of T5. | Plan owner |
| D34 | 1   | The delivery per unit is built as PR 18, right after the delivery at the end. The former PRs 18 to 22 are now 19 to 23. Their branch names stay.                                                                                                                                                 | Proposed   |
| D35 | 2   | The native draft page has a model picker, and the model is saved on the draft: PATCH of a native draft accepts `cliModels`. A platform draft does not read the field, as before. PR 2 becomes backend and frontend. This adds to D26.                                                            | Plan owner |
| D36 | 2   | The native draft page shows the output-language field of a platform draft. Whether a native turn honours the language is still decided by PR 9 or the parity review (D22).                                                                                                                       | Plan owner |
| D37 | 2   | The picker for the primary repository starts with the repository the space marks as primary, otherwise with the first. The member can change it before creating.                                                                                                                                 | Plan owner |
| D38 | 2   | For PR 2: commits as validated slices land, a force-push with lease of the rebased PR 1 branch, a push of PR 2's branch, and its pull request against PR 1's branch. Asked again when the next PR starts.                                                                                        | Plan owner |
| D39 | 2   | The browser learns the flag from the space detail response that `SpacePermissionsContext` polls every 15 seconds. The New Intent page reads the space from the list, which does not report the flag (D28), and makes no request of its own.                                                      | Proposed   |
| D40 | 2   | The engine choice has two options, "Platform workflow" (preselected) and "Native AI-DLC". It is not offered on a New Intent page that asks for a release (`?release`), tests one (`?testRelease`) or starts from another intent (`?fromIntent`).                                                 | Proposed   |
| D41 | 2   | In a space without a repository, the native choice shows a note and the create button is disabled. The backend would answer 400 `native_repository_required` (D30).                                                                                                                              | Proposed   |
| D42 | 2   | The native draft page offers Claude Code only and selects it as soon as the runtime reports it available. A platform draft still needs an explicit pick.                                                                                                                                         | Proposed   |
| D43 | 2   | The model is shared state of the collaborative draft, like the output language, and the draft's auto-save sends it. The picker lists the Claude Code models the runtime reports and "Default — runtime", which removes the model. There is no free-text entry (T19).                             | Proposed   |
| D44 | 2   | `cliModels` on PATCH: a model id sets the model of that CLI, `null` removes it, and a CLI left out keeps its model. The rules of the space setting apply, for every CLI it knows, so T2 needs no change here. A change is recorded on the timeline.                                              | Proposed   |
| D45 | 2   | The flag decides whether the engine choice is offered. It does not change a choice the member has made: a chosen native form stays when the flag reads disabled, and the server refuses the create with 409 `native_execution_disabled`. The browser's flag can lag (D31).                       | Proposed   |
| D46 | 2   | Any member who may edit the draft may change its model. The space's model setting stays with the owner. The model id is held to the format rules of the space setting, not to the list the runtime reports. Confirmed by the plan owner on 2026-11-28.                                           | Plan owner |

## Workspace layout

```text
/mnt/aidlc/                                  EFS mount on the runtime
  spaces/<projectId>/
    aidlc-cache/<commit>/                    packaged AI-DLC, per source commit
    intents/<intentId>/                      the workspace, same layout as /mnt/workspace today
      .aidlc/                                CLI conversation store; never committed
      <owner>/<repo>/                        repository checkouts; one is primary
```

## Rules for every PR

- **Flag off means no change.** Each PR has a criterion that proves platform intents behave as before.
- **No new tables, queues or Lambdas.** New code is runtime commands, one orchestrator module and shared helpers.
- **Durable steps.** Native adds new step names prefixed `native-`. Existing names and their order stay untouched.
- **Authorization.** Every new route and command gets a test for denied access as well as success.
- **Branch code is reference material.** Nothing is copied from `feat/native-aidlc-execution` without review. The modules worth reading are named per PR.
- **Deploying to dev.** Dev is deployed only with `./scripts/deploy-terraform.sh dev` and `./scripts/deploy-frontend.sh dev`. Nothing reaches dev any other way: no direct `terraform apply`, no manual upload.
- **Dev environment.** Dev runs `main`.
- **Validation.** The checks in `AGENTS.md` apply. Each PR names its focused test projects.

## Branches

The PRs are stacked in the order of the sequence table.

- **One branch per PR.** A branch is named `feat/native-<description>`. The first starts from `main`. Each later one starts from the branch of the PR before it.
- **Pull request base.** A pull request targets the branch below it, so it shows only its own change. The first targets `main`.
- **Rebase before working.** Work on a branch starts with a rebase of the stack onto the current `main`. `main` is never merged into a branch.
- **Merge order.** PRs merge into `main` bottom first. The next branch is then rebased onto `main`, and its pull request targets `main`.
- **Pushed branches.** A rebase rewrites a branch that was already pushed. Its next push is `git push --force-with-lease`.
- **No worktrees.** All work happens in the one checkout, by switching branches.

```sh
# Before working: move the whole stack onto the current main.
git fetch origin
git switch <top branch of the stack>
git rebase --update-refs origin/main

# Start the next PR on top of the stack.
git switch -c feat/native-<description>

# After the bottom PR is merged: take its commits out of the stack.
git fetch origin
git switch <top branch of the stack>
git rebase --update-refs --onto origin/main <merged branch>
```

`--update-refs` moves every branch of the stack in the same run.

## Working on a PR

One PR is worked on at a time, in the order of the sequence table. The checkout is shared, so two sessions at once would collide. A session starts with one instruction: work on PR `<n>` of this document.

1. **Read** this document in full, then `AGENTS.md`.
2. **Rebase and branch** as described under "Branches".
3. **Settle the details** with the plan owner before building. Ask; do not assume. Add each decision to the decisions table.
4. **Do the PR's check first**, if "Checks to do first" lists one, and report the result before building on it.
5. **Build** the PR's scope and nothing else.
6. **Validate** as `AGENTS.md` and the PR's "Verify" line say.
7. **Update this document.** Tick the criteria that are met, record what changed, and add every open topic that came up.
8. **Hand over** to the plan owner: what ran, what passed, what is left. Commit, push and the pull request happen when the plan owner says so.

## Sequence

| #   | PR                                       | Branch                             | Area               | Depends on |
| --- | ---------------------------------------- | ---------------------------------- | ------------------ | ---------- |
|     | **A. Hidden foundations**                |                                    |                    |            |
| 1   | Flag and `engine` on intents             | `feat/native-flag-and-engine`      | backend            |            |
| 2   | New Intent choice and the native draft   | `feat/native-new-intent-choice`    | backend, frontend  | 1          |
| 3   | Workspace storage and runtime capability | `feat/native-workspace-storage`    | Terraform, runtime |            |
| 4   | AI-DLC source per space                  | `feat/native-aidlc-source`         | backend, frontend  | 1          |
|     | **B. Runtime building blocks**           |                                    |                    |            |
| 5   | Bun version in the image                 | `feat/native-bun-version`          | image              |            |
| 6   | Sandbox scope for a workspace            | `feat/native-sandbox-scope`        | runtime            | 3          |
| 7   | Prepare: directory and checkout          | `feat/native-prepare-workspace`    | runtime            | 3          |
| 8   | Install AI-DLC into the workspace        | `feat/native-install-aidlc`        | runtime            | 4, 5, 6, 7 |
| 9   | Turn with Claude Code                    | `feat/native-claude-turn`          | runtime            | 6, 8       |
|     | **C. First end-to-end run in dev**       |                                    |                    |            |
| 10  | Intent page for a native intent          | `feat/native-intent-page`          | frontend           | 2          |
| 11  | Orchestrator loop: start, answer, finish | `feat/native-orchestrator-loop`    | orchestrator       | 9, 10      |
| 12  | Resume after a failed turn               | `feat/native-resume-failed-turn`   | backend            | 11         |
|     | **D. Full experience**                   |                                    |                    |            |
| 13  | Structured questions from question files | `feat/native-structured-questions` | runtime, backend   | 11         |
| 14  | Stage actions refused for native         | `feat/native-refuse-stage-actions` | backend, frontend  | 11         |
| 15  | Stage sync: plan and stage rows          | `feat/native-stage-sync`           | all                | 14         |
| 16  | Artifacts and graph                      | `feat/native-artifacts-graph`      | runtime            | 11         |
| 17  | Delivery at the end                      | `feat/native-delivery`             | runtime, backend   | 11         |
| 18  | Delivery per unit                        | `feat/native-delivery-per-unit`    | all                | 15, 17     |
| 19  | Several repositories with a primary      | `feat/native-multi-repo`           | all                | 17         |
| 20  | Update AI-DLC on a running intent        | `feat/native-update-aidlc`         | all                | 11         |
|     | **E. Release**                           |                                    |                    |            |
| 21  | Managed environments                     | `feat/native-managed-environments` | environments       | 3, 11      |
| 22  | Cleanup on deletion                      | `feat/native-cleanup-on-deletion`  | backend, runtime   | 11         |
| 23  | Admin switch and documentation           | `feat/native-admin-switch`         | frontend, docs     | all above  |

Each branch is based on the branch in the row above; the first is based on `main`. "Depends on" names the PRs a PR builds on. It matters only when the order changes. Work after the release is listed under "Open topics".

---

## A. Hidden foundations

### PR 1: Flag and `engine` on intents

Backend only. Nothing visible in the UI.

- **Scope:** one shared reader for the flag in `lambda/shared/`, modelled on `fetchPlatformStageSkipping` in `lambda/intents/index.js`. `engine` accepted on intent creation and stored on the execution row. `nativeExecution` on the project detail response so the browser can learn the flag. Read permission for the parameter on the Lambdas that read it. This document is committed with this PR.
- **Built:** the reader and the engine helpers are in `lambda/shared/native-execution.js`. The intents and projects Lambdas read the flag; the orchestrator does not need it yet. An independent review of the change led to D31.
- **Reviewed again** on 2026-11-27, after the rebase onto `main` at d3a4e4f6. No defect was found and no code changed. The review recorded the first version of D32, T15, T16, the addition to T13 and the note on PR 2, and added the `shared` project to the Verify line.
- **Changed by D33** on 2026-11-27: a native create makes the PR-strategy check again (D32). Both create paths share one helper in `lambda/intents/index.js`.
- **Rebased** on 2026-11-27 onto `main` at 6da09a64, together with PR 2. #838 had added `role` to `handleCreateIntent` at the place where PR 1 put its create helpers. Both are kept; no other commit conflicted.

Acceptance criteria:

- [x] A missing parameter, a read failure and any value other than `enabled` all count as disabled.
- [x] Flag disabled: creating an intent with `engine: "native"` returns 409 `native_execution_disabled` and writes nothing.
- [x] Flag enabled: the same request stores a draft, and the intent's API responses carry `engine: "native"`.
- [x] A request without `engine` behaves exactly as today. The existing creation tests pass unmodified.
- [x] A native draft stores title, prompt, the repositories, the primary repository and the base branches. Workflow, scope, release and stage-skip inputs are rejected with 400 (D25).
- [x] A native create whose space cannot honour its PR strategy returns 409 `PR_STRATEGY_UNSUPPORTED` and writes nothing, as a platform create does. Added by D32.
- [x] The attachment routes work on a native draft as on a platform draft.
- [x] A native draft takes every repository of the space. `primaryRepo` is one of them and is required when the space has several. Otherwise 400. Changed by D21; the criterion was "exactly one repository until PR 19".
- [x] `engine` cannot be changed after creation.
- [x] Starting a native draft returns 409 `native_start_unavailable`. PR 11 removes this.
- [x] If a native execution ever reaches the orchestrator, it fails closed and never loads a stage plan.
- [x] The project detail response reports `nativeExecution`. A non-member still gets 403.
- [x] Terraform changes are limited to the read permission. No variable, no environment wiring.
- [x] Dev check: with the parameter set to `enabled`, the create request stores a native draft; with the parameter removed, it returns 409. Done by the plan owner on 2026-11-27 with this branch deployed to dev, before the merge. The parameter was removed again afterwards.

Verify: `npx vitest run --project=shared --project=intents --project=projects --project=v2-orchestrator`. In dev, set the parameter with `aws ssm put-parameter` and repeat the create request.

### PR 2: New Intent choice and the native draft

- **Scope:** `NewIntentPage.tsx` offers the engine choice when the project reports the flag as enabled. `IntentComposePage.tsx` shows a native draft as CLI, model and Start. Since D35, the model is a picker and PATCH of a native draft accepts it.
- **Note from PR 1:** the draft's auto-save (`useCollaborativeIntentDraft.ts`) sends `composedGrid` and `skipStageIds` with every save. A native draft refuses both, even as `null` (D25), so its auto-save must send title, prompt and conversation language only. Since D35 it also sends the models.
- **Built:** the flag reaches the pages through `SpacePermissionsContext` (D39). The collaborative draft hook knows a native draft from the intent it is seeded with and sends title, prompt, models and conversation language for it. The model change is `patchCliModels` in `lambda/shared/cli-models.js`, routed by `handleUpdateIntent`, and `updateExecution` gained `cliModels`. The details settled in this PR are D35 to D46.
- **Reviewed** independently on 2026-11-27. No defect in the platform paths was found. The review led to D45 and D46, to `cliModels` moving the draft revision in `updateExecution`, and to tests for a lagging read of the draft row, for a member who joins a draft a peer already filled, and for a save that outlives its document.
- **Known limit:** a native draft whose shared document was filled before this PR has no model in that document. Its page shows "Default — runtime" while the draft still holds the space's model, until a member picks a model. Only drafts created through the API and opened in the browser before this PR are affected.
- **Tests:** the existing tests of the New Intent page are unmodified. In `IntentComposePage.test.tsx`, the stand-in for the draft hook gained `cliModels` and `setCliModel`; the existing tests themselves are unmodified. The engine choice has its own file, `NewIntentPage.native.test.tsx`.

Acceptance criteria:

- [x] Flag disabled: the New Intent page renders exactly as today, with no engine control in the DOM. Existing tests pass unmodified.
- [x] Flag enabled: the member can choose "Native AI-DLC". Workflow, scope, release and stage selection disappear for that choice.
- [x] Attachments and tracker-issue import work for a native intent exactly as for a platform intent.
- [x] In a space with several repositories, the member picks the primary repository for a native intent. Moved here from PR 19 by D21: the backend requires `primaryRepo` in such a space.
- [x] Creating sends `engine: "native"`, and `primaryRepo` when the space has several repositories, and opens the draft. Sparse checkout is not offered for a native intent (T11).
- [x] The native draft page shows CLI (Claude Code only), model and Start. It shows no stage grid, no compose actions and no permanent loading skeleton.
- [x] Pressing Start shows the backend's message while Start is unavailable.
- [x] The compose page of a platform draft is unchanged.
- [x] The model picker lists the Claude Code models the runtime reports. A pick reaches every member on the draft and is saved with the draft. Added by D35.
- [x] PATCH of a native draft sets or removes a model per CLI, under the rules of the space setting. An invalid value is 400 and writes nothing. A viewer and a non-member get 403. A platform draft keeps its models. Added by D35.
- [x] Dev check: with the flag enabled, the New Intent page offers the choice, a native draft opens with CLI, model and Start, and Start shows the backend's message. With the flag removed, the choice is gone. Done by the plan owner on 2026-11-28 with this branch deployed to dev. The screenshots in pull request #921 show the New Intent page with the flag off and on, a native draft open in two browsers, and the refused Start.

Verify: `npm --prefix frontend test`, `npm --prefix frontend run build`, `npx vitest run --project=shared --project=intents`. In dev, flip the flag and reload.

### PR 3: Workspace storage and runtime capability

- **Scope:** Terraform variable `enable_native_workspace_storage`, default `false`. When `true`: one encrypted EFS file system, mount targets in the runtime's subnets, one access point, and a second filesystem entry on the core runtime at `/mnt/aidlc`. The runtime's `capabilities` command reports `nativeWorkspace`.
- **Check first:** AgentCore must accept session storage and an EFS access point on the same runtime. The API allows up to five filesystem entries; the combination is untested. If it is refused, stop and re-plan.
- **Reference:** the EFS parts of `terraform/modules/compute/native-runs/main.tf` on the branch.

Acceptance criteria:

- [ ] Variable `false`: a plan against an existing deployment shows no change. A test in `terraform/tests/` asserts no EFS resources and the same single filesystem entry as today.
- [ ] Variable `true` with network mode `VPC`: the plan adds the file system, the mount targets, the access point and the runtime entry.
- [ ] NFS is reachable only from the runtime's security group. The runtime role may mount and write only that access point.
- [ ] Variable `true` with another network mode fails at plan time with a clear message.
- [ ] After apply in dev, `capabilities` reports `nativeWorkspace: true`, and a file written in one session is readable in a new session.
- [ ] Without the storage, `capabilities` reports `nativeWorkspace: false`.
- [ ] A platform intent still runs end to end in dev after the apply.
- [ ] `terraform/environments/dev.tfvars.example` documents the variable.

Verify: `terraform -chdir=terraform fmt -check -recursive`, `terraform test`, review of the saved plan before apply.

### PR 4: AI-DLC source per space

- **Scope:** space setting `aidlcSource` with `repository` and `ref`, stored like the other space settings in `lambda/projects/index.js`. A section in the space settings UI, shown only when the flag is enabled.
- **To settle with the plan owner when this PR starts:** whether the setting also names plugin sources, a list of repositories and refs beside the AI-DLC source (T18). The answer changes the shape of the setting, so it comes before the setting is built.

Acceptance criteria:

- [ ] Unset: the API returns the default (upstream repository, newest stable release tag) and marks it as the default.
- [ ] The repository can be picked from the space's connected providers or entered as a public HTTPS URL.
- [ ] `ref` accepts a tag, a branch or a commit. Empty means the newest stable release tag of that repository.
- [ ] A URL containing credentials is rejected.
- [ ] The same roles that may change other space settings may change this one. A member can read it. A non-member gets 403.
- [ ] Saving does not contact the repository. Resolution to a commit happens in PR 8.
- [ ] Flag disabled: the section is not rendered.

Verify: `npx vitest run --project=projects`, frontend tests.

---

## B. Runtime building blocks

PRs 5 to 9 are verified by tests. They become reachable from the product in PR 11.

### PR 5: Bun version in the image

- **Scope:** raise `BUN_VERSION` in `lambda/agentcore/Dockerfile` from 1.4.0 to the version AI-DLC's copy runtime requires (1.4.4 or newer), with new checksums.

Acceptance criteria:

- [ ] The image builds for arm64 and amd64 with checksum verification, and `bun --version` matches.
- [ ] The existing code sensors that use `bunx` still pass their tests.
- [ ] `terraform/tests/agentcore-image.tftest.hcl` passes.

### PR 6: Sandbox scope for a workspace

- **Scope:** in `lambda/agentcore/sandbox/`, a scope built from `projectId` and `intentId`. A process in that scope sees its own workspace and nothing else under the mount.
- **Check first:** whether sandbox-runtime 0.0.81 can re-allow one directory inside a denied tree. If not, the launcher's own mount namespace does the scoping.

Acceptance criteria, all proven in the real image:

- [ ] A process in intent A's scope can create and read files in A's workspace.
- [ ] It cannot list, read or write another intent's workspace in the same space.
- [ ] It cannot list, read or write anything of another space, including that space's AI-DLC cache.
- [ ] A symlink in A that points at B cannot be followed, and `..` traversal fails.
- [ ] Identifiers are validated as safe path segments before any path is built.
- [ ] The scope applies whether the Admin sandbox setting is on or off. Request payloads and child environment variables cannot disable or widen it.
- [ ] Sandbox behaviour for platform intents is unchanged. Existing sandbox tests pass unmodified.

Verify: `npx vitest run --project=agentcore` plus the SRT image integration tests (`./scripts/agent-e2e-testing.sh --sandbox`, see `docs/development/testing.md`).

### PR 7: Prepare: directory and checkout

- **Scope:** runtime command `native-prepare-start` in `lambda/shared/agent-command-registry.js`, accepted and run in the background like `init-ws-start`. The workspace root becomes a per-invocation value (today a constant in `lambda/agentcore/http-server.js`). Checkout reuses `checkoutRepos` and the credential chain.
- **Reference:** `native/efs-workspace.js` on the branch.

Acceptance criteria:

- [ ] The command creates the workspace and checks out the intent's repositories on the intent branch, each from its base branch. Several repositories since D21; the primary one is first in `repos`.
- [ ] The intent's attachments are placed in the workspace the way `init-ws` places them (`materializeAttachments`).
- [ ] Credentials reach Git the same way as in `init-ws`. None appear in the payload, in logs or in files on EFS.
- [ ] Running it again on an existing workspace keeps local work. It neither resets nor clones again.
- [ ] It fails with a named reason when the storage is missing (`native_storage_unavailable`), the repository is unreachable, or an identifier is invalid.
- [ ] It is refused without a valid grant for that execution, and for an execution that is not native.
- [ ] Platform commands still use `/mnt/workspace`. Existing `init-ws` tests pass unmodified.

### PR 8: Install AI-DLC into the workspace

- **Scope:** `native-prepare-start` gains the install step. It resolves the space's source to a commit, clones it, runs the source's packaging script (`bun scripts/package.ts <harness>`) inside the PR 6 scope, caches the result per space and commit, copies the harness tree into the primary repository, runs AI-DLC's own project setup, and records repository, ref, commit and version on the intent.
- **Check first:** whether the packaging script needs network access or a dependency install, and how long clone plus packaging take in the image.
- **To settle with the plan owner when this PR starts:** whether prepare also installs the space's AI-DLC plugins (T18). If it does, the cache and the record on the intent carry each plugin's commit beside the AI-DLC commit, and the checks named under T18 come first.

Acceptance criteria:

- [ ] The default source installs in the real image. The result reports version and commit.
- [ ] A private source reachable through one of the space's connections clones with a brokered credential. Covered per supported provider by a fixture repository.
- [ ] An unreachable source fails with `aidlc_source_unreachable`, naming the repository.
- [ ] A source without a working packaging script fails with `aidlc_source_invalid`, and the timeline shows the script's last lines.
- [ ] The intent records the resolved commit. Preparing the same intent again uses that commit, even when the space setting or the branch head has changed.
- [ ] Packaging and setup run inside the workspace scope. A fixture script that tries to read another workspace or a credential fails.
- [ ] A second intent on the same commit neither clones nor packages again.
- [ ] After install, the primary repository contains AI-DLC's files for Claude Code.

### PR 9: Turn with Claude Code

The largest uncertainty in the plan.

- **Scope:** runtime command `native-turn-start`. It reuses the CLI driver, spawn, usage recorder and credential chain, runs inside the workspace scope from the primary repository, and returns `waiting`, `done` or `failed`. Output goes to the existing intent-level output stream.
- **Check first:** how AI-DLC asks its questions when Claude Code runs without a terminal. This decides how reliably `waiting` can be detected.
- **Note from PR 2:** the member's model is `cliModels[cli]` on the draft (D35). A stage run prefers the model of the agent's tier (`tierModels`) in `lambda/agentcore/model-resolver.js`. A native turn has no agent tier, and the snapshotted tier models must not replace the member's pick.
- **Reference:** `native/turn-interaction.js`, `native/transport-instructions.js`, `native/harness-output.js` and `native/method-output.js` on the branch show what version 2.11.1 needed. Read them; do not copy the version-specific parts.

Acceptance criteria:

- [ ] The first turn starts AI-DLC with the intent's title and prompt, and tells it where the attachments are.
- [ ] A turn that ends with AI-DLC asking something returns `waiting` with AI-DLC's message.
- [ ] A later turn delivers the member's reply into the same conversation, also after the runtime session was replaced.
- [ ] If the conversation cannot be continued, a new one starts and AI-DLC resumes from its own saved state.
- [ ] `done` is returned only when AI-DLC's state says the workflow is complete, not because the CLI exited.
- [ ] `failed` carries a reason for a CLI error, a credential error and a timeout. Work already done stays in the workspace.
- [ ] CLI and model credentials resolve as for platform intents. A CLI disabled by the Admin is refused.
- [ ] The CLI gets no platform stage prompt and no platform question or artifact tools.
- [ ] The space's custom MCP servers are available to the CLI under the same policy as for platform intents (`lambda/shared/runtime-mcp-policy.js`).
- [ ] Token usage is recorded through the existing usage recorder.
- [ ] A turn never pushes to a remote.

Verify: `npx vitest run --project=agentcore` with a scripted model provider, plus the credentialed agent procedure in `docs/development/testing.md` once.

---

## C. First end-to-end run in dev

### PR 10: Intent page for a native intent

Acceptance criteria:

- [ ] A native intent opens in every state (draft, running, waiting, done, failed) with Overview, Work and Graph, and without a permanent loading skeleton.
- [ ] Views that need stages show nothing until PR 15.
- [ ] Work shows the open question with the existing gate card, and the output stream.
- [ ] Platform intents render as before. Existing tests pass unmodified.

### PR 11: Orchestrator loop: start, answer, finish

- **Scope:** one module `lambda/v2-orchestrator/native.js`, entered when the execution is native. Steps: prepare, then turns. `waiting` opens a human gate with AI-DLC's message and a free-text answer. The answer starts the next turn. Removes the Start refusal from PR 1.

Acceptance criteria:

- [ ] Start on a native draft sets the intent running. The timeline shows the workspace prepared and the AI-DLC version and commit installed.
- [ ] When AI-DLC waits, the intent is waiting and a gate shows AI-DLC's message.
- [ ] A member answers in free text through the existing answer endpoint. The answer is recorded with the member's identity.
- [ ] One answer starts exactly one turn. A double submit and a replay of the durable execution do not start a second one.
- [ ] `done` ends the intent as succeeded. `failed` ends it as failed with the reason.
- [ ] Cancel during a turn stops the CLI and ends the intent as cancelled. The workspace stays.
- [ ] The page updates without a reload when a turn starts, a question arrives and the intent ends.
- [ ] Start is refused with `native_storage_unavailable` when the space's runtime does not report the storage.
- [ ] Flag switched off: no new start and no new turn. Existing native intents stay readable.
- [ ] A non-member can neither start nor answer.
- [ ] For platform executions, step names and order are unchanged. Existing orchestrator and replay tests pass unmodified.

Verify: `npx vitest run --project=v2-orchestrator --project=intents`. Dev journey: create, start, answer AI-DLC's questions in free text, reach "complete".

### PR 12: Resume after a failed turn

Acceptance criteria:

- [ ] Resume on a failed native intent starts a new turn in the same workspace, without cloning or installing again.
- [ ] AI-DLC continues from its saved state.
- [ ] A runtime session lost in the middle of a turn fails the turn within the heartbeat timeout, and Resume then works.
- [ ] Resume is refused while a turn is running.

---

## D. Full experience

### PR 13: Structured questions from question files

- **Scope:** at the end of a turn, the runtime reads the active stage's question file. Open `[Answer]:` slots become questions in the gate's existing shape. The answer is written into the slots before the next turn.
- **Reference:** `native/question-file.js` on the branch, without its identity gate.

Acceptance criteria:

- [ ] A question file with N questions renders N questions in the existing question editor, with their options in order.
- [ ] Selections and free text are written into the matching `[Answer]:` slots. A test compares the whole saved file with the expected bytes.
- [ ] If the file changed after it was shown, the reply stays in history and the member sees the current questions. Nothing is overwritten silently.
- [ ] A file that cannot be parsed falls back to PR 11's message and free text. The turn does not fail.
- [ ] Drafting an answer together works as for platform intents.
- [ ] No code path checks the AI-DLC version or source.

### PR 14: Stage actions refused for native

Lands before PR 15, because stage rows make these actions reachable.

Acceptance criteria:

- [ ] For a native intent, `rewind`, `revise`, `repair`, `recompose`, `compose`, `quorum-edit`, `decision`, `verify`, `feedback` and `export` return 409 `not_supported_for_native` and change nothing. One test per route.
- [ ] Their controls do not render for a native intent.
- [ ] Start, answer, cancel, resume and the read routes keep working for native. One test each.
- [ ] Platform intents are unaffected.

### PR 15: Stage sync: plan and stage rows

- **Scope:** the runtime parses `aidlc-state.md` at the end of a turn. The orchestrator writes stage rows and the plan in one step. The intent API returns the plan in the shape the frontend already consumes, and `IntentContext.tsx` uses it for native intents.
- **Reference:** `lambda/shared/native-workspace-projector.js` on main holds the same mapping in the other direction. `native/workflow-resume-state.js` on the branch reads the file.
- **Note from the research for PR 18:** the projector writes the state format of AI-DLC 2.3.3. From 2.11.0 on, the state file still has one row per stage, not per unit. While units are built one after the other, a stage's row is ticked only once every unit has finished that stage.

| AI-DLC marker                     | Stage row state     |
| --------------------------------- | ------------------- |
| `[ ]` not started                 | `PENDING`           |
| `[-]` in progress, `[R]` revising | `RUNNING`           |
| `[?]` awaiting approval           | `WAITING_FOR_HUMAN` |
| `[x]` completed                   | `SUCCEEDED`         |
| `[S]` skipped                     | `SKIPPED`           |
| the turn fails                    | `FAILED`            |

Acceptance criteria:

- [ ] Every row of the mapping table has a test.
- [ ] After a turn, the pipeline bar, the phase diagram and the stage list show AI-DLC's phases and stages with their states. The scope badge shows AI-DLC's scope.
- [ ] The intents list shows the native intent's current phase and stage.
- [ ] A stage awaiting approval links to the open gate.
- [ ] Only the sync step writes stage rows for a native intent.
- [ ] Running the sync twice gives the same rows. Deleting the rows and syncing again restores them.
- [ ] The native loop never reads stage rows to decide what runs next.
- [ ] A state file that cannot be parsed writes no rows and adds a warning to the timeline. The turn still succeeds, and the intent shows without a stage breakdown.
- [ ] No background job treats a native `RUNNING` row as orphaned.
- [ ] `docs/concepts/execution.md` records that stage rows of native intents are a projection.
- [ ] Platform intents are unaffected.

### PR 16: Artifacts and graph

- **Scope:** after each turn, AI-DLC's documents in the primary repository are ingested through the existing graph writer and `lambda/shared/artifact-extractors.js`.
- **Check first:** which AI-DLC document paths map to which artifact types. `artifactPath` in `native-workspace-projector.js` has the mapping in the other direction.

Acceptance criteria:

- [ ] Documents AI-DLC wrote appear as artifacts in Work and Graph, with content identical to the file.
- [ ] A changed document becomes a new version of the same artifact, not a duplicate.
- [ ] Items and relationships are derived by the existing extractors. A derivation failure does not fail the turn.
- [ ] Only known document paths are ingested. Nothing outside the repositories is read.
- [ ] Reading artifacts follows the same authorization as for platform intents.

### PR 17: Delivery at the end

- **Scope:** on `done`, the runtime commits and pushes, and the orchestrator opens the pull request with the step platform intents use.
- **Note:** this PR delivers once, at the end, for every native intent, whatever its PR strategy says. PR 18 adds the delivery per unit for `pr-per-unit` (D33).

Acceptance criteria:

- [ ] The platform neither commits nor pushes before completion. PR 18 changes this for `pr-per-unit`.
- [ ] At completion, each repository with changes gets one push and one pull request against its base branch. The link appears on the intent as for platform intents.
- [ ] The commit contains everything Git does not ignore: code, AI-DLC's records and AI-DLC's framework files.
- [ ] Nothing from outside the repositories is committed, in particular not the conversation store.
- [ ] A push or pull-request failure loses no work and leaves the intent succeeded. The intent shows the failed delivery, and the existing delivery retry works.
- [ ] No changes means no empty commit and no pull request. The timeline says so.
- [ ] A tracker issue linked to the intent is updated at completion, and notifications are sent, as for platform intents.

### PR 18: Delivery per unit

Added by D33. For a native intent with the PR strategy `pr-per-unit`.

- **Scope:** at the end of a turn, the runtime reads from AI-DLC's records which units are finished. For every unit that is newly finished, the engine commits and pushes, and the orchestrator opens the unit's pull request, in durable steps after the turn. What is left is delivered at the end by PR 17. With `intent-pr` nothing changes.
- **Check first:** which of AI-DLC's records shows that a unit is finished, at which turn end it appears, and what else is in the working tree by then.
- **Reference:** `commitAndPushAll` and `pushBranch` in `lambda/agentcore/git-engine.js` take a directory and a branch, and need no unit or stage rows. The source-control operations `create-pr`, `set-pr-draft` and `pr-status` take a repository and a branch. The platform's unit pull requests (`ensureDraftPullRequests` and `integrateUnitPullRequests` in `lambda/v2-orchestrator/section.js`) are bound to lanes and their rows and cannot be called from the native loop.

Known so far, read from the AI-DLC 2.11.5 sources on 2026-11-27 and not yet tried in the image:

- **Where units are listed.** A `yaml` block in `unit-of-work-dependency.md` names every unit and what it depends on. A scope without units generation has no units.
- **From 2.11.0 on.** A new workflow builds one unit after the other in the one working tree and asks for approval at the end of each unit. The approval is an audit record: `GATE_APPROVED` with `Gate Scope: unit-end` and the unit's name. A later `GATE_REJECTED` for that unit takes it back. `aidlc-state.md` does not show it.
- **Before 2.11.0.** A stage runs for every unit before the next stage starts, and no unit is approved on its own. Such an intent gives no signal per unit.
- **The approval probably arrives one turn late.** This is concluded from the protocol, not observed. AI-DLC writes the approval when the next turn starts, and that turn goes on into the next unit. The turn end that shows unit 1 approved then already holds the start of unit 2.
- **Delivered units can change.** A later unit, or a loop back from Build and Test, can change files of a unit that was delivered before.
- **No Git by AI-DLC.** On this path AI-DLC neither commits nor pushes nor opens pull requests.

How the platform does it today, for comparison:

- **One branch and one checkout per unit.** The branch starts from the intent branch. The engine commits and pushes at the end of every stage.
- **The unit's pull request targets the intent branch.** It stays a draft until it is the unit's turn to integrate. A person merges it, and units that depend on it wait for that merge.
- **The intent's own pull request** against the base branch follows at the end, for both strategies.

Native has one working tree and builds units in a row, so the units stack on each other instead of starting from a merged intent branch.

To settle with the plan owner when this PR starts:

- **Branch and base of a unit's pull request.** Either a stack, where each unit's branch targets the branch of the unit before it. Or the platform's shape, where every unit targets the intent branch and the next unit waits for the merge.
- **Waiting for the merge.** Whether the loop goes on to the next unit while a unit's pull request is open.
- **What a unit's commit holds.** Either everything in the working tree at the turn end that shows the approval, which includes the start of the next unit. Or a local commit taken when AI-DLC asks for the approval, pushed once the approval is recorded.
- **Several units finished in one turn.** This happens when AI-DLC approves units itself. Their changes are then in one working tree and cannot be told apart, so one pull request would cover all of them.
- **A delivered unit that changes later.** Where those changes go. A pushed unit branch is not rewritten.
- **Draft or ready.** If the native pull requests need no draft state, D32's refusal can be dropped for native.
- **Where the unit pull requests show.** A native intent has no lanes (T5).

Acceptance criteria:

- [ ] With `intent-pr`, delivery is exactly as in PR 17. Nothing is committed or pushed before completion.
- [ ] With `pr-per-unit`, a turn end that shows a newly finished unit leads to one commit and one push for each repository with changes, and to a pull request that names the unit.
- [ ] A turn end that shows no newly finished unit pushes nothing.
- [ ] A unit is delivered once. A double answer, a replay of the durable execution and a resumed turn create no second commit, push or pull request.
- [ ] The CLI never pushes. The push runs after the turn, with the engine's credentials.
- [ ] The commit contains everything Git does not ignore, and nothing from outside the repositories, as in PR 17.
- [ ] At completion, everything not yet delivered is delivered as in PR 17. Nothing is delivered twice and nothing is left out.
- [ ] An intent without units, or without a signal per unit in its records, is delivered once at the end. No AI-DLC version is checked (D14).
- [ ] A failed push or pull request for a unit fails neither the turn nor the intent and loses no work. The intent shows the failure, and the next delivery makes up for it.
- [ ] Cancel, a failed turn and Resume keep the units already delivered. The next delivery continues after them.
- [ ] The unit pull requests appear on the intent with their links.
- [ ] A new runtime command is refused without a valid grant for that execution, and for an execution that is not native.
- [ ] For platform intents, step names and order are unchanged, and `pr-per-unit` works as before. Existing tests pass unmodified.

Verify: `npx vitest run --project=agentcore --project=v2-orchestrator --project=intents`. Dev journey: an intent with at least two units in a space set to `pr-per-unit`. One pull request appears after each approved unit, and the rest at completion.

### PR 19: Several repositories with a primary

- **Check first:** how AI-DLC expects additional repositories to be laid out relative to the primary one (`/aidlc intent add-repo`, `set-repos`).
- **Changed by D21:** a native draft holds every repository of the space since PR 1, so the PRs before this one already check out and deliver several repositories. What is left here is making AI-DLC itself aware of the repositories beside the primary one. The picker for the primary repository moved to PR 2.

Acceptance criteria:

- [x] Creating a native intent with several repositories requires `primaryRepo`, one of them. Otherwise 400. Met by PR 1.
- [ ] Prepare installs AI-DLC in the primary repository and registers the others with AI-DLC's own command. The checkout of all repositories is PR 7.
- [ ] Delivery pushes and opens a pull request for every repository with changes.
- [x] The primary repository cannot change after Start. Met by PR 1: it is set at creation and no route changes it. Changing it on a draft is T13.
- [ ] Single-repository native intents behave as before.

### PR 20: Update AI-DLC on a running intent

- **If plugins are taken in (T18):** the update also resolves the plugin sources again and composes them over the new AI-DLC. AI-DLC's guide asks for a plugin sync after every engine refresh.

Acceptance criteria:

- [ ] A member can trigger the update while the intent waits for a reply. It is refused during a turn.
- [ ] The update resolves the space's source at that moment. The same commit reports "already up to date" and changes nothing.
- [ ] A different commit is packaged, copied over the project with AI-DLC's own refresh, and recorded on the intent. The timeline shows old commit, new commit and the member.
- [ ] Without this action, an intent never changes its commit: not when the space setting changes, and not when the source gets a new release.
- [ ] A failed update is shown with a retry. No turn runs on a half-updated workspace.
- [ ] The next turn works, and the stage sync shows the new version's plan.
- [ ] A non-member cannot trigger it. With the flag off it is refused.

---

## E. Release

### PR 21: Managed environments

- **Check first:** whether the Instances backend accepts an EFS access point.

Acceptance criteria:

- [ ] Storage deployed and the environment's runtime in VPC mode: new environment revisions get the mount, and a native intent runs in a space that uses the environment.
- [ ] Storage absent, or network mode `PUBLIC`: the runtime is created with exactly today's parameters. Start is refused with `native_storage_unavailable`, and the draft page says why.
- [ ] Existing environment revisions are not modified.
- [ ] `terraform/tests/managed-environments.tftest.hcl` covers the added permissions.

### PR 22: Cleanup on deletion

Acceptance criteria:

- [ ] A native intent keeps its workspace after it ends, until the intent is deleted.
- [ ] Deleting a native intent stops a running turn and removes its workspace.
- [ ] Deleting a space removes the space's directory, including the AI-DLC cache.
- [ ] If the workspace cannot be removed, the deletion reports the failure and can be repeated. No workspace is left behind without its intent.
- [ ] Removal validates its path and cannot delete outside the mount.

### PR 23: Admin switch and documentation

Acceptance criteria:

- [ ] An Admin card switches the flag through `PUT /agents/settings`, like `StageSkippingCard.tsx`. Only platform admins can use it.
- [ ] A parity review walks through every feature and every space and Admin setting of platform intents, and records whether each applies to native. Every gap is in "Open topics".
- [ ] `docs/using-the-platform/` describes creating, answering, updating AI-DLC and delivery for native intents.
- [ ] A short `docs/concepts/native-execution.md` describes this design. The installation docs describe `enable_native_workspace_storage`.
- [ ] The full journey passes in dev with a real model: create, start, structured answers, stage progress, artifacts, update, completion, pull request.
- [ ] Switching the flag off afterwards hides native and leaves existing native intents readable.

---

## Checks to do first

Each is the first task of its PR. A negative result changes that PR and is recorded here.

| PR  | Question                                                                                       |
| --- | ---------------------------------------------------------------------------------------------- |
| 3   | Does AgentCore accept session storage and an EFS access point on one runtime?                  |
| 6   | Can the sandbox runtime re-allow one directory inside a denied tree?                           |
| 8   | Does AI-DLC's packaging script need network access? How long does it take?                     |
| 9   | How does AI-DLC ask questions when Claude Code runs without a terminal?                        |
| 15  | Is the format of `aidlc-state.md` stable across the versions customers will use?               |
| 18  | Which AI-DLC record shows a finished unit, at which turn end, and what is in the tree by then? |
| 19  | How does AI-DLC expect several repositories to be laid out?                                    |
| 21  | Does the Instances backend accept an EFS access point?                                         |

## Sign-offs

The plan owner signs off:

- **Every merge** into `main`.
- **Every Terraform plan** before it is applied. `./scripts/deploy-terraform.sh dev --phase plan` saves the plan for review, and `--phase apply` then applies exactly that plan. PRs 1, 3 and 21 change Terraform; other PRs may add permissions.
- **Switching on** the storage variable and the flag, per environment.
- **The release**, which is PR 23.

## Open topics

Work that is postponed, so it can be followed. Whoever works on a PR, person or agent, adds a row here in that PR whenever something is left out, found missing or put off.

| #   | Topic                                                                                                                                                                                                                                                                | When                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| T1  | Output and token usage per stage; a pipeline bar that moves during a turn                                                                                                                                                                                            | After release                     |
| T2  | Codex, OpenCode and Kiro, one PR each                                                                                                                                                                                                                                | After release                     |
| T3  | Stage actions for native: rewind, revise, repair, recompose, compose                                                                                                                                                                                                 | After release                     |
| T4  | Quorum edit, artifact verification, unit feedback and workspace export for native                                                                                                                                                                                    | After release                     |
| T5  | Units as separate lanes that run in parallel. Native builds units one after the other and shows one row per stage. The pull request per unit moved into the release (D33, PR 18).                                                                                    | After release                     |
| T6  | Messages to the agent outside a question                                                                                                                                                                                                                             | After release                     |
| T7  | Sensor results and stage review views. AI-DLC runs its own checks; the views stay empty.                                                                                                                                                                             | After release                     |
| T8  | Exact stage start and end times, from AI-DLC's `runtime-graph.json`                                                                                                                                                                                                  | After release                     |
| T9  | A check of AI-DLC release signatures. The recorded commit identifies the version instead.                                                                                                                                                                            | Not planned                       |
| T10 | Further parity gaps                                                                                                                                                                                                                                                  | Found by the parity review, PR 23 |
| T11 | Sparse checkout for native intents. Refused with 400 since PR 1 (D25).                                                                                                                                                                                               | Parity review, PR 23              |
| T12 | `compose` on a native draft still runs the composer when called through the API directly.                                                                                                                                                                            | PR 14                             |
| T13 | Changing the primary repository of a native draft. It is set at creation only. A PATCH that carries `primaryRepo` is ignored, not refused.                                                                                                                           | PR 19                             |
| T14 | Several repositories reach PRs 7 to 18 before PR 19 has checked AI-DLC's layout (D21). First finding, 2026-11-27: the AI-DLC 2.11.5 guide puts several repositories beside one `aidlc/` directory with the records, not inside one of them. That does not match D10. | Checked in PR 7 and PR 19         |
| T15 | The orchestrator's `quorum-edit`, `cleanup-branches` and `retry-delivery` events return before the native check (D27). No native intent can reach them while it stays a draft.                                                                                       | PR 11                             |
| T16 | `POST /delivery` and `POST /derive` are not in PR 14's list. On a native draft, `delivery` is refused only because no workflow resolves, and `derive` runs as on a platform draft.                                                                                   | PR 14; delivery retry in PR 17    |
| T17 | Unit branches and open unit pull requests of a native intent that is cancelled, failed or deleted.                                                                                                                                                                   | Parity review, PR 23              |
| T18 | AI-DLC plugins in native workspaces ([#916](https://github.com/aws-samples/sample-collaborative-ai-dlc/issues/916)): plugin sources per space, composed by prepare and pinned on the intent. Whether it is in the first release is open. Notes below.                | Decided when PR 4 starts          |
| T19 | A free-text model on the native draft. The picker offers only the models the runtime reports (D43); the space settings fall back to a text field when the runtime reports none.                                                                                      | Parity review, PR 23              |
| T20 | The frontend type `Intent` declares `workflowId` as a string. A native intent has `null`. `RecomposePanel.tsx` (two calls) and `IntentContext.tsx` (one) pass it on as a string.                                                                                     | PR 10                             |
| T21 | The models of the other CLIs on the native draft page. PATCH already accepts them (D44); the page shows Claude Code only.                                                                                                                                            | T2                                |
| T22 | The intents list, the sidebar and the dashboard do not mark a native intent.                                                                                                                                                                                         | PR 10                             |
| T23 | One shared model picker. The native draft has the fourth copy of the select, after the space settings, the Admin defaults and the tier table. The free-text fallback of T19 would go there.                                                                          | After release                     |

Criteria kept for T1:

- [ ] Output and token usage produced during a turn carry the stage that was current at that moment.
- [ ] A stage's detail view shows its own output and usage.
- [ ] The pipeline bar moves during a turn, not only at its end.

Notes kept for T18. The request is [#916](https://github.com/aws-samples/sample-collaborative-ai-dlc/issues/916). What is said about AI-DLC is read from its 2.11.5 sources (`docs/reference/18-plugin-mechanism.md`) on 2026-11-27 and not tried in the image.

- **What a plugin is.** AI-DLC's own way to customise the method without a fork. A plugin is a Git repository that adds stages, agents, scopes, sensors and knowledge, and adds to core stages. It is composed into an installed project, not into the AI-DLC source.
- **What is asked.** A space names plugin sources, each a repository and a ref, under the rules of the AI-DLC source (D5; a URL containing credentials is rejected). Prepare clones them and composes them after the install. The intent records each plugin's commit beside the AI-DLC commit (D7). An update of AI-DLC resolves and composes them again.
- **What it touches.** The space setting (PR 4). The install step, its cache and the record on the intent (PR 8). The update (PR 20). Deciding before PR 4 keeps the setting and the record from changing shape later.
- **How AI-DLC composes.** With the `aidlc` binary, `aidlc engine plugin sync`. In an install without the binary, which is what the packaging script gives (D6), the same step is `bun <harness-dir>/tools/aidlc-plugin.ts sync`. A repository that holds the authored plugin is built first, with `aidlc-plugin-build.ts <plugin root> <harness> <out>`. Sync checks no remote registry.
- **Checked by the issue's author.** On 2.11.4, with the binary and no Bun on `PATH`: a plugin built and composed for Kiro and for Claude Code, and doctor reported no problems. The path through the packaging script is not checked.
- **To check in PR 8, if plugins are taken in.** The compose step on the plan's install path, in the real image and inside the workspace scope. Where a plugin goes for Claude Code: AI-DLC documents Claude Code's own plugin store with a hook at session start, and a folder inside the project for Kiro only. How a failed compose is noticed: sync exits 0 for a plugin it holds back, for example when its base plugin is missing, and reports it in its `--json` output and in doctor.
- **Plugin code runs in the runtime.** A plugin can ship sensor scripts, doctor checks and commands. They need the workspace scope, like the packaging script of the AI-DLC source.
- **Composed files are committed.** What compose writes into the harness directory is part of the primary repository and of its commit (D10).
- **A base plugin is not fetched.** A plugin may build on one other plugin. AI-DLC does not fetch it, so the space has to name it as well.

## Not planned

- Anything from the branch's control plane: its tables, queues, Lambdas and per-intent runtimes.
- Moving intents that were created on the branch.
