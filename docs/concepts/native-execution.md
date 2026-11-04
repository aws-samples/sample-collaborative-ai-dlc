# Native execution

Native execution brings an AI-DLC methodology package into the shared Intent
workspace. A coding harness runs the methodology in a dedicated workspace while
project members review results, discuss proposals, answer questions and follow
progress together.

AI-DLC decides the workflow steps and required human gates. The platform manages
access, execution, accepted answers, published results and collaboration. Native
and the [platform execution backend](execution.md) share the Intent experience;
each backend retains its own execution commands.

!!! note "Feature status"

    Native execution is under development. Shared interaction, publications,
    history and workspace recovery are implemented, but the complete deployed
    journey is not yet qualified. Verified workflow completion and platform Git
    delivery are unfinished. The single checklist at the end of this page tracks
    the work needed for an integrated release.

## Working with a native intent

A native intent starts with a request, a methodology package and one connected
application repository. The methodology source and application repository serve
different purposes: the package supplies the development process; the application
repository supplies the code to work on.

In the current creation flow, a project owner configures a workflow source in
**Space settings → Agent**, imports a package, and makes it available for native
draft creation. A member selects the package and harness, enters the request and
prepares the workspace. Preparing a workspace does not start agent work. The
saved request can be corrected before **Start**.

Kiro is temporarily unavailable for new native executions while AI-DLC input
and authentication qualification is pending. Creation shows the disabled Kiro choice
and its reason, and a prepared Kiro draft cannot Start through either the
application or a direct API request. Claude Code, Codex and OpenCode remain
selectable for development. Existing Kiro configuration and history remain
readable; other platform Kiro behavior is unchanged.

Start captures the request revision, package, application source commit, harness,
model selection, credential scope and execution image. Later project settings
changes do not silently change that execution. Credential rotation within the
captured scope is supported; changing the source of credentials requires a new
configuration.

The shared Intent workspace provides the current response and questions, activity,
discussions, files, graph navigation and revision history. Native intents also
appear in the project, dashboard and sidebar. Integrating source selection into
the normal **New intent** entry remains part of the completion checklist.

## Questions, decisions and collaboration

When AI-DLC needs input, it publishes its response and, where supported, a
structured question form. Members can edit the answer together before submitting
it. Available questions from the current workflow step can appear together;
summary confirmations and required approvals remain separate interactions.
Grouping is a presentation choice. AI-DLC's interaction-mode question remains
unless the member has already expressed a preference in their retained request
or answers; platform instructions are not evidence of a human selection.

The platform records an accepted answer against the exact question and revision
that the member saw. Competing or stale submissions cannot replace it. A retry
of an uncertain submission checks the same request instead of creating another
answer. Accepted answers remain part of the intent's history.

Answer acceptance, delivery to the agent and application of a workflow decision
are separate observations. A successful submission does not by itself establish
that AI-DLC applied an approval or completed a stage. Missing delivery information
is shown as uncertain or unavailable.

If a structured form cannot be captured, the response remains available for
inspection and an eligible turn can accept a written reply. The platform does not
invent missing options, answer questions automatically or advance a human gate.
Current forms support up to 32 questions and 16 options per question, with written
answers where required. Unsupported forms must remain explicit rather than lose
questions or choices.

Shared answer drafts use the platform's real-time collaboration service. Accepted
answers are durable separately from those drafts. Unsubmitted native drafts are
not guaranteed to survive a collaboration-server restart or expiry after all
members disconnect.

Members can discuss a published revision and request Quorum assistance. Quorum
provides advice through the discussion service. Its response does not submit an
answer or approve the native workflow. See [Discussions](../using-the-platform/discussions.md)
and [Real-time collaboration](../using-the-platform/real-time-collaboration.md).

## Files, history and traceability

The running workspace contains mutable project files, generated dependencies and
unfinished edits. At a completed turn boundary, native publishes a verified
revision of its eligible files and response. Each publication identifies exact
file bytes and belongs to the current execution and turn.

Members can inspect current and earlier publications, compare public source
files, download individual files and request a ZIP of a published revision.
Another authorized member can reopen that revision independently of runtime
availability. Files in published revisions are read-only; editing or applying
changes through the platform is not currently supported.

A publication or ZIP contains the admitted public file inventory. It is not a
complete backup of the live workspace or necessarily a complete Git tree.
Unpublished edits and generated dependencies can remain on EFS without appearing
in a download. File modes, excluded entries, submodules and other repository
features need an explicit delivery contract before native can publish code back
to a Git provider.

The graph derives sections, items and relationships from published content and
links them to the exact source revision. It can be rebuilt from publications.
File locations and authored workflow markers do not establish execution progress,
approval or completion. A graph projection problem does not prevent access to
otherwise authorized published files or replies; membership verification still
has to succeed.

## Completion and delivery

Workflow completion must follow the pinned methodology's effective plan,
required checks, review outcomes and human gates. Native does not add a blanket
final approval beyond the selected workflow's requirements.

The current feature records published results and member selections, but it does
not yet verify that the effective plan and required outcomes were applied to the
final result. Completion is therefore shown as **not verified**. An agent stopping,
a successful CLI exit, a published review document or an accepted approval answer
is not sufficient evidence of workflow completion.

Native Git delivery is not implemented. Source checkout, file comparison and
result download do not create commits, branches or pull requests. The remaining
work must bind the deliverable bytes, required workflow evidence, authorized
member and destination, then confirm the provider's result. Tracker updates and
merge handling also need an explicit policy. See the shared
[Git integration guide](../using-the-platform/git-integration.md) for the platform
backend's existing behavior; it does not automatically apply to native intents.

## Persistent workspace recovery

**EFS is the only recovery path for native executions.** The project
workspace survives loss of the runtime process or coding session. It retains
workflow files, generated dependencies and unfinished edits so AI-DLC can
reconcile its own work in a fresh session.

Native turns do not capture, export, upload or restore private CLI recovery
snapshots. Public result publication remains necessary for inspection,
history and delivery. Removing private restore machinery does not remove those
publications or their integrity checks.

When session recovery is needed, the platform must confirm that the previous
process has stopped before admitting another writer. The member then confirms
**Resume in a fresh session**. Native opens the same surviving workspace with a
fresh CLI session and invokes AI-DLC's supported resume entrypoint. AI-DLC checks
its workflow records and incomplete work, then continues or asks for input.

**AI-DLC 2.11.1 recovery starts after workflow creation.** The initial scope or
plan-selection offer has no active workflow and is outside recovery coverage.
After session loss at that point, the application shows **Intake recovery is
unavailable** and does not offer fresh-session resume. Published proposals and
accepted answers remain readable. Native does not route a later resume message
through the earlier offer's answer command or turn it into plan consent.

Eligibility comes from the surviving workspace's active pointers, matching
committed intent registry entry and initialized workflow state. It is checked
when loss is observed and again before a fresh CLI starts. The last publication
alone is insufficient: a workflow may have been created during an interrupted
turn after that publication. Missing, incomplete or ambiguous workflow records
make recovery unavailable; this structural observation does not establish
approval, completion or permission to skip AI-DLC's reconciliation.

Resume confirmation does not approve a workflow gate or replay an earlier answer.
Previously delivered, uncertain and undelivered answers remain distinct. The
member reviews any retained answer against the recovered question and submits
it anew if appropriate. Native must not replace unfinished workspace content with
an older publication.

This recovery model depends on the original EFS workspace being available and
correctly bound to the intent. A missing, replaced or unreadable workspace must
produce an explicit unavailable result. EFS deletion, corruption and disaster
recovery are outside session-resume coverage; backup and retention policy are
separate operational concerns.

**NE-03 implementation:** private exact session restore has been removed after
the completed NE-02 tool proof. This remains a pre-release feature; earlier native
development formats are not a supported compatibility contract. The platform
backend's checkpoint and recovery contracts remain separate. Local validation and
the deployment boundary are recorded below.

## Responsibilities and data flow

| Responsibility                                          | Owner                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| Methodology steps, workflow records and required gates  | The pinned AI-DLC engine and coding harness                |
| Access, accepted commands and answers, execution state  | The platform's native authority                            |
| Dispatch, status observation, cancellation and recovery | Native workers operating under current execution ownership |
| Mutable project files and unfinished work               | The EFS workspace with one admitted writer                 |
| Published revisions and accepted-answer history         | Durable platform records and versioned object storage      |
| File relationships and graph navigation                 | A rebuildable projection of admitted publications          |
| Shared drafts and presence                              | The collaboration service                                  |
| Discussion assistance                                   | The discussion service and advisory Quorum execution       |

```mermaid
flowchart TB
  UI["Shared Intent workspace"]
  COLLAB["Collaborative drafts and discussions"]
  AUTH["Native authority"]
  STATE[("Durable execution and answer state")]
  WORKER["Execution workers"]
  RUNTIME["AI-DLC and coding harness"]
  EFS[("Persistent EFS workspace")]
  RESULTS[("Versioned publications")]
  GRAPH["Derived graph"]
  UI <--> COLLAB
  UI -->|commands and reads| AUTH
  AUTH <--> STATE
  STATE -->|committed work| WORKER
  WORKER <-->|dispatch and observations| RUNTIME
  RUNTIME <--> EFS
  RUNTIME -->|candidate results| RESULTS
  RESULTS -->|verify before admission| WORKER
  WORKER -->|current-owner observations| AUTH
  RESULTS -->|admitted revisions| GRAPH
  AUTH -->|activity and history| UI
```

DynamoDB execution state is authoritative for native control. Workers cannot
replace accepted commands or answers based on local runtime state. Conditional
writes and writer ownership prevent duplicate or stale work from becoming the
current execution. The runtime has no direct native control-table or graph-write
permission.

Application WebSocket notifications indicate that durable activity is available;
authorized reads provide the content. Cursor-based replay and polling repair
missed notifications. Collaborative document synchronization is a separate
transport and does not accept execution commands.

### Package integrity

A workflow package is imported from an authorized source and pinned to verified
release bytes, materialization and object versions. Importing a package does not
grant continuing access to its source or to the application repository. Start
rechecks the relevant permissions and captures the selected configuration.

Package storage is restricted to its publishing worker. Its protection includes
conditional object creation, versioning, copy/delete restrictions, multipart
upload behavior and lifecycle policy. A source adapter or package version label
alone does not establish that the installer, methodology protocol and harness
combination is qualified.

Application repository credentials belong to trusted platform operations. They
are supplied for the authorized checkout and removed before methodology and
harness commands run. Files, diagnostics and download paths still require
explicit credential exclusions and current member access.

## Support matrix and settings

The current implementation runs serial turns against one application repository.
CLI availability, package import and local adapter tests do not establish a
qualified deployed combination. Release support must name the tested package,
harness, model, provider and image.

### Selected release contract

The initial serial release targets **AI-DLC 2.11.1**, **all four harnesses** and
**all three application repository providers** below. These scope decisions were
confirmed on 2026-10-26. Each advertised combination must pass qualification
before release; Kiro is a required row even while its qualification is blocked.
The temporary native Kiro admission restriction was approved on 2026-10-27.
Full Kiro instruction-channel, input and authentication qualification belongs
to NE-18 and must pass before this restriction is removed for release.

| Scope              | Initial release requirement                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Methodology        | AI-DLC 2.11.1, imported from the authorized methodology source and pinned to verified package bytes and materialization. Other versions and forks require their own qualification before being advertised.                                                        |
| Claude Code        | AWS Bedrock with the resolved project/platform model selection captured at Start.                                                                                                                                                                                 |
| Codex              | AWS Bedrock with the resolved OpenAI model selection captured at Start.                                                                                                                                                                                           |
| OpenCode           | AWS Bedrock with the resolved model selection captured at Start.                                                                                                                                                                                                  |
| Kiro               | Kiro's managed provider with the captured supported model selector. Its actual workflow and EFS resume journey must be qualified before release.                                                                                                                  |
| Application source | GitHub.com, GitLab.com and Bitbucket Cloud; one connected repository per execution, with its exact source commit captured.                                                                                                                                        |
| Inputs             | Written requests, attachments and tracker imports. Attachments and tracker imports are release requirements implemented under NE-09; current native requests accept the written prompt and repository/package content.                                            |
| Settings and tools | Existing model selection and credential-scope resolution, plus repository/package instructions and tools in the dedicated native runtime. Platform-managed environments, custom MCP server selections and uploaded custom rules are outside this initial release. |
| Advanced features  | Graph enrichment, optional debug archives, artifact edit/apply, Quorum edits, parallel units, per-unit delivery, multiple repositories and cross-engine migration are outside this release.                                                                       |

The first application acceptance path is **AI-DLC 2.11.1 → Claude Code → GitHub**,
using the existing dev configuration. Record the actual resolved Bedrock model,
credential source, region, harness version, package/materialization identifiers,
application commit and immutable execution-image digest before qualification.
Use that combination first for the recovery proof in NE-02 and the complete
journey in NE-19. Those records identify the tested combination; a settings
default or model placeholder is not evidence of which model executed it.

Every additional release row must likewise identify its model/provider selection
and execution image. Qualification of one model does not qualify every model
accepted by that harness. An unset or automatic selector must be recorded as
provider routing, not described as an immutable underlying model version.
The other harness/provider rows remain required until their evidence is complete;
passing the first path does not remove them from the release scope.

The shared native settings notice appears during draft creation and in the
Intent configuration view. It describes this target and the current input limits
without enabling unfinished input paths or claiming deployed qualification.
The normal **New intent** backend/default decision remains part of NE-08.

### Current implementation

| Area                        | Current behavior and limit                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coding harnesses            | Claude Code, Codex and OpenCode remain selectable for development. Kiro is visibly temporarily unavailable for new native executions, with authoritative Start rejection and an explicit runtime guard. All four harnesses still require release qualification; Kiro's full input and authentication path remains NE-18 work. |
| Methodology sources         | Import adapters cover GitHub.com, GitLab.com and Bitbucket Cloud with their supported source bindings. Installer and provenance constraints require separate qualification; importing from a provider is not a claim of full workflow support.                                                                                |
| Application source          | Exactly one connected GitHub, GitLab or Bitbucket repository. Source resolution captures the default branch and exact commit. CodeCommit, multiple repositories, submodule and LFS materialization are not supported by this path.                                                                                            |
| Package and harness         | Selected for the native draft and pinned for execution. Repository and package instructions remain part of the workspace.                                                                                                                                                                                                     |
| Models                      | Start captures the resolved project/platform model selection. An unset selection or automatic routing is not an immutable provider-model version.                                                                                                                                                                             |
| Credentials                 | The starting member's effective credential scope is captured. A responding member does not replace it. Rotation within that scope is allowed; revocation does not silently fall back to another scope.                                                                                                                        |
| Environments and tools      | Native uses its dedicated runtime. Platform-managed environments, custom MCP server selections and uploaded custom rules do not currently apply. Repository/package configuration can still supply instructions and tools.                                                                                                    |
| Platform execution controls | Agent-tier assignments, v2 stage scheduling, platform sensors, parallelism, rewind/recompose and per-unit PR strategies do not control native methodology execution.                                                                                                                                                          |
| Optional features           | Native graph enrichment and debug archive capture are off. Platform preferences do not enable them for native runs.                                                                                                                                                                                                           |

The Intent configuration view shows captured settings rather than current defaults.
Unsupported settings need to remain visible as limitations wherever users choose
or inspect native execution. The selected package determines its methodology
agents and reviewers; the platform should not duplicate that workflow model.

Artifact edit/apply, Quorum edits, parallel units, per-unit delivery,
multi-repository execution and cross-engine migration are outside the serial
integration target. Optional enrichment and debug archives also remain outside
that target unless explicitly selected for release. Their absence must not be
presented as an implemented capability or become an implicit release blocker.

<a id="recovery-compatibility-and-operation"></a>

## Recovery and operation

Cancellation requests stop the current execution; a requested stop and a
confirmed stop are different states. Recovery requires confirmation that the
previous writer has stopped. Status refresh, elapsed time or a missing response
cannot establish that fact. Published revisions and accepted decisions are
independent of whether a process is currently running.

Operators can close admission for new work while keeping services available for
current runs. Deploy matching frontend, authority, worker and runtime contracts
together. The transition to EFS-only recovery can discard compatibility with
native development runs; it must preserve the existing platform backend and the
integrity of newly accepted native work.

Repair workers rediscover committed work after missed notifications. Operational
acceptance must establish repair delay at the intended scale, usable alerts and
an incident owner. Normal member actions should be diagnosable through activity,
status, history and explicit error messages rather than private runtime logs.

Archive, replacement-run and resource-cleanup behavior is not yet defined.
Stopping a runtime is separate from deleting its workspace or publications, and
the UI currently prevents deletion of a space containing native intents. These
lifecycle actions need clear permissions, retention and user-visible outcomes.

For shared deployment and validation procedures, see [Setup](../getting-started/setup.md)
and [Testing](../development/testing.md). The checklist below distinguishes an
implemented capability from proof that it works through the deployed user path.

### First-path EFS resume qualification

**Current scope, corrected by the user on 2026-11-03:** NE-02 qualifies the
native execution tool. Generated application files and command results are
opaque fixture data. Verify that the platform accepts, stores, exposes and
preserves those bytes with the correct execution, publication and access
identities. Generated-game correctness, source-quality review, independent
application test/build qualification and browser playability are not completion
gates. A complete game is unnecessary. Errors in generated content are not
platform defects unless the tool violates its own transport, persistence,
authorization or recovery contract. This scope supersedes the game-quality and
playability requirements in the dated historical observations below; those
observations retain their original outcomes. The tool's regression tests and
genuine workflow human gates remain required.

NE-02 uses separate fresh qualification intents in the existing dev-enabled space,
with AI-DLC 2.11.1, Claude Code and a connected GitHub application repository.
Deploy the same candidate's frontend, authority, workers and runtime before
testing. Record the candidate commit and deployed versions, exact Bedrock model,
credential source, region, immutable runtime-image digest, harness version,
package/materialization identifiers and application source commit. Verify these
against the accepted execution configuration before exercising recovery; a
Terraform default or mutable image tag is insufficient.

1. Start through the application, select a plan as a real member, and verify that
   AI-DLC has created its workflow before reaching a real workflow question.
   The initial scope/plan-selection offer is not a recoverable boundary for
   2.11.1. Record the created workflow, interaction and publication identifiers
   and any accepted answer's delivery status. Let the runtime remain idle beyond its 900-second session timeout,
   then submit the next real member answer through the application. Ordinary
   application reads do not detect expiry or keep the runtime alive. The next
   dispatch must detect the lost session before sending that answer to the
   harness, retain its acceptance and expose recovery through normal status reads.
2. In a separate intent, interrupt its runtime during an active tool after it has
   created unfinished edits and dependency links. Preserve its EFS workspace.
   Ordinary intent cancellation is a terminal user command and does not substitute
   for unexpected runtime loss in this scenario.
3. For both cases, require confirmed predecessor stop and a member's **Resume in
   a fresh session** action through the browser. Trace the accepted public request
   to the authority, worker and runtime. Confirm the same workspace identity and
   a different CLI session identity, with no concurrent predecessor writer.
4. Verify AI-DLC resumes against the surviving edits and dependencies, exposes
   real command results, admits a new publication and reaches its next real
   question. Compare retained file and dependency identities and verify result
   delivery through the application; do not assess generated application quality
   or require its tests/build to pass.
   Previously accepted answers must retain their delivery classification and
   history; recovery itself must not replay an answer or approve a gate. For the
   expired waiting session, inspect the original revision's
   `answer.resumeRetention.delivery: "undelivered"`, unchanged acceptance and
   member, and absent delivery time/resulting publication. The current interaction's
   generic delivery status alone cannot establish this history. Capture evidence
   that the turn used no private recovery capture, export, import or restore.
5. Separately lose a session at the initial plan-selection offer. Confirm that the
   browser explains that intake recovery is unavailable, the recovery API refuses
   the action, and no fresh CLI starts. Its proposal and any accepted answer must
   remain in history, without plan consent or automatic answer replay.
6. Exercise missing and incorrectly bound workspaces using isolated qualification
   resources. The browser must show that resume is unavailable, with no replacement
   workspace, model turn or admitted publication. Preserve existing dev workspaces
   and earlier failed intents. Start these faults from a created workflow so the
   intake restriction does not mask a workspace-binding failure.

**Local readiness, 2026-10-26:** the frontend recovery service and authenticated
API wrapper now run against the real public router, execution API and authority
store in regression tests. A lost response preserves the confirmation and command
identities and produces one authority transaction; denied membership produces no
dispatch or state change. A further process-loss regression reproduced an
acknowledged fresh-session resume becoming terminally failed if its runtime died
before publication. The worker now recognizes the current resume episode, turn
and writer as in-flight work and uses the existing fenced, confirmed-stop recovery
path. The real HTTP/executor fixture reaches a third writer generation while
preserving unfinished work and accepted-answer history without replay. All 1,398
native-runtime-control tests pass, including stale ownership, cancellation and
unconfirmed-stop cases. Fixture authentication, persistence and inert subprocesses
do not establish deployed browser, harness or EFS qualification.

The operator fixture is `scripts/native-recovery-qualification.mjs`. Its local
`barrier-command` action prints a bounded, foreground Bash command for Claude to
run after real implementation edits and dependency installation. The operator
`stop` action verifies that this command is an active Claude child before stopping
the exact accepted runtime session. Capture changed-file and dependency-link
hashes before stopping, compare the changes with the preceding publication, and
use `inspect --marker-sha256` after the resumed run publishes to compare retained
evidence. An old marker alone does not prove an active interrupted tool.
Prepare the scoped user-run stop command first. Start the expiring barrier only
after the operator is ready, and never reuse the expired October 27 command.

The `missing-project` and `wrong-project` actions require an isolated intent at a
recoverable boundary with a confirmed predecessor stop. They preserve the
original project in a nonce-scoped quarantine and stop their diagnostic session
before returning; they do not modify authority records or delete EFS data. All
operator actions require explicit account, region, resource and writer identities,
and a separately authorized operator profile. `solution-read` is rejected.
The 27 focused helper tests and all 300 release-script tests pass; these checks
do not establish live fault qualification.

**Dev qualification preparation, 2026-10-26:** deployment of `010ce5d5` and
the subsequent `fbda6296` worker correction was confirmed. The frontend entry
asset and deployed API, authority and execution-worker archives match their local
deployment artifacts byte for byte; the worker correction keeps the same runtime
image. The signed-in application imported the selected package, prepared a fresh
qualification intent and accepted Start through the public API. The accepted
execution matches the package, model and image pins recorded before Start:

| Pin                     | Recorded value                                                              |
| ----------------------- | --------------------------------------------------------------------------- |
| Region                  | `us-east-1`                                                                 |
| Harness                 | Claude Code `2.1.296`, verified in the exact image with networking disabled |
| Effective model setting | `global.anthropic.claude-sonnet-5-5`, from the space override               |
| Credential source       | Platform Bedrock credentials, captured by the accepted Start                |
| Runtime image digest    | `sha256:ef179ee0335bffe0184b376abc9768306f4602952b26dc8c9ca7ca6c552068b9`   |
| AI-DLC release          | `v2.11.1`                                                                   |
| Methodology commit      | `895a35d86d20336d9b7bc4aedc9440e4a12c83ab`                                  |
| Package identity        | `sha256:577eced0d4425aba7cd4fdaec100315363e104d28fa47f1aec141aac606dfb56`   |
| Materialization         | `sha256:be88b2f8c1240dfb86ad4a75e9d3104931f65c35d789b572127028b0631d0386`   |
| Application repository  | `JWThewes/flappy-bird` on GitHub                                            |
| Application commit      | `d99d2511c43f07ff2451e7e13f5a8f45b16dfce2`                                  |
| Application branch      | `ai-dlc/initial-game-1776942523258--task-project-scaffold`                  |

The accepted execution captures the space's model selection, which differs from
the platform fallback. Its runtime uses the prepared EFS access point and a
dedicated execution endpoint. The initial AI-DLC scope/plan-selection offer was
published before the waiting-session expiry test. After more than 900 seconds of inactivity, a
browser reply was accepted and the worker detected the lost session before
dispatching it. The application exposed a confirmed predecessor stop and accepted
the member's explicit fresh-session confirmation. Writer generation 2 reused the
same execution, configuration and EFS binding, used a different CLI session, and
admitted publication 2. History retained the original answer as undelivered with
its identity, text, author and acceptance time unchanged, and no delivery time,
resulting publication or approval. The observed recovery used no private checkpoint
capture or restore.

This is partial proof: publication 2 reported `next does not take --on-instruction
where` from the pinned workflow's resume command and contained no workflow
question. The pinned engine reads the complete AI-DLC user message, including the
previously appended platform guidance; even clean CLI arguments reproduced the
failure. Moving guidance outside that message exposed the independent intake
limit: an exact resume returns **No workflow state found** before an active intent
exists. The selected release therefore limits recovery to created workflows.
The offered question's request-answer route is not a supported fallback: a later
resume message can satisfy that route's input check and produce a workflow-create
instruction without a plan choice.

The two publications preserved the complete file inventory and application
source; five engine hook-health timestamps changed. Publication admission and
these retention checks do not qualify workflow recovery. Platform transport
guidance must use a separate harness instruction channel while the resume user
message remains the literal supported entrypoint. The interrupted-tool case is
prepared but not started: the pinned application commit contains an empty Phaser
scene, so its implementation/build/test fixture needs a source-baseline decision.
The missing/wrong-workspace cases also remain unqualified. NE-02 stays open.

**Recovery candidate, 2026-10-27:** the local candidate requires a created workflow
observed in the surviving EFS workspace, including its active pointers, committed
intent registry and initialized state. It checks this state before fresh-session
admission and again immediately before the CLI starts. Current workspace state
can establish creation after an older intake publication; publication alone
cannot establish recovery eligibility. Missing or unrecognized state leaves
recovery unavailable. Accepted answers, delivery classifications and immutable
publications remain intact, including interrupted-resume and lost-acknowledgement
paths.

The AI-DLC user request and resume entrypoint now remain literal. Platform
transport guidance uses the harness instruction channel and supplies no human
answer, interaction-mode selection or workflow consent. The earlier exact-image,
network-disabled Claude hook check used literal `/aidlc --resume` with zero model
tokens; it remains an offline hook check, not live recovery proof.

The approved temporary Kiro restriction uses native capability/status responses,
the existing creation/configuration UI, and the authenticated Start authority.
It rejects a new Kiro Start before configuration capture or dispatch, including
direct requests and forged availability overrides. Already admitted
configurations and readable work are preserved, and the runtime retains
`native_execution_transport_kiro_unqualified`. This does not qualify Kiro or
remove it from the four-harness release requirement.

Local validation of this candidate on Node **24.21.0**:

| Check                                                                                        | Result                                                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm test -- --maxWorkers=4`                                                                 | **11,544 passed, 10 skipped**; 390 files passed                              |
| `npx vitest run --project=native-runtime-control --maxWorkers=4`                             | **1,437 passed** across 52 controller files                                  |
| Seven focused recovery suites through `vitest.native-foundation.config.js`                   | **284 passed**, including runtime, authority and fence                       |
| `npm --prefix frontend test -- --maxWorkers=4`                                               | **2,104 passed** across 150 files                                            |
| Five focused native creation, interaction, execution and service suites                      | **417 passed**                                                               |
| `npm --prefix frontend run build`; `npm run build -w native-runtime-control`                 | Frontend and all eight controller bundles built                              |
| `npm run architecture:check`; `npm run dep:check`                                            | 413 production modules, zero violations; zero errors, 17 dependency warnings |
| `npm run lint -- --ignore-pattern '.worktrees/**'`; `npm run secretlint -- '!.worktrees/**'` | Zero lint errors, 82 warnings; secret scan passed                            |
| `npm run format:check -- . '!.worktrees/**'`; `git diff --check`                             | Passed                                                                       |
| `uv sync --group docs --locked --offline`; `uv run --no-sync zensical build`                 | Passed using a local evidence-directory UV cache                             |

These suites overlap; their counts are separate results, not an aggregate.
The full backend suite used local Docker test services and inert test credentials.
The first backend run found two capability-response assertions that needed the
new field; both were corrected before the successful full rerun. The architecture
check also prompted local extraction of recovery-result and record validation,
followed by the successful controller/full reruns. The frontend build retains its
bundle-size advisory. No deployed browser journey, newly built runtime image,
credentialed provider call or live recovery fault was exercised in this stage.
The earlier source-hash comparison matched all 31 recorded candidate files at
stage entry; earlier passes remain historical evidence. Exact commands, source
hashes and local logs are recorded under
`.native-evidence/ne02-2026-10-27-candidate/`.

Deploy this candidate's frontend, API/authority, workers **and a newly built
runtime image** before the next proof. `scripts/deploy-terraform.sh` builds the
source-derived AgentCore image and wires its digest into native services;
`scripts/deploy-frontend.sh` then builds and uploads the frontend. Generate a
fresh candidate-specific plan with `--phase plan --plan-file`, review it, and
apply that same `--plan-file` path with `--phase apply --skip-seed`. Reusing an old
image or deploying only backend archives cannot validate the transport and
pre-spawn recovery corrections.

At this candidate handoff, live acceptance remained pending for created-workflow waiting-session expiry,
interruption during an active tool with retained edits/dependencies and real
build/tests, the next genuine workflow question, visible intake rejection,
missing/wrong EFS workspace rejection, and exact deployed/configuration/image
alignment. The application fixture choice is still pending separately and does
not block this local candidate. Do not start NE-03 until the actual NE-02 live
proof passes.

**Dev deployment and live qualification, 2026-10-27:** the user deployed
`526837eb8394735e6b365bdfbcda249af84c5e3f` with
`scripts/deploy-terraform.sh dev --phase all --skip-seed` and
`scripts/deploy-frontend.sh dev`. Scoped reads using `solution-read` verified
account `746558295630`, region `us-east-1`, the served frontend entry and all
521 assets, all nine native Lambda archives and bundled entrypoints, and the
five authority aliases at version **15** against the candidate bytes. The
browser's loaded chunks were included in that comparison.

The deployed runtime image is
`sha256:074c50086bee10ca4d086fa3df0a9f87251a684bfa34df6ec67cf08cd65f6eeb`,
with source-derived tag `cc2d6c57451852b2`. All five changed runtime production
files match the candidate inside that exact image. Its installed harness is
**Claude Code 2.1.296**, with image Node **24.19.0**. That image inspection used
disabled networking and no model calls; the fresh browser executions below
made the authorized real model calls.

Both fresh Claude Starts captured **AI-DLC 2.11.1**,
`global.anthropic.claude-sonnet-5-5` from the space override, platform Bedrock
credentials, `efs-workspace-v1`, and the verified image digest. The fresh
package job is `ae854a6a-c445-464d-b08f-0f5451af857e`, with package
`sha256:577eced0d4425aba7cd4fdaec100315363e104d28fa47f1aec141aac606dfb56`
and materialization
`sha256:be88b2f8c1240dfb86ad4a75e9d3104931f65c35d789b572127028b0631d0386`.
The current methodology source binding and imported package provenance match
the accepted configurations. The connected application uses GitHub OAuth for
`JWThewes/flappy-bird`; both executions resolved branch
`ai-dlc/initial-game-1776942523258--task-project-scaffold` to
`d99d2511c43f07ff2451e7e13f5a8f45b16dfce2`. Their actual runtime version,
endpoint, 900-second idle timeout and EFS access-point/mount configurations
match their accepted authority records.

The temporary Kiro behavior **passes deployed checks**. Creation visibly
disables Kiro and explains its temporary unavailability. Fresh Kiro draft
`a09241ef-2f80-4de2-ba00-0597f930c116` was created and prepared through the
public API to exercise bypass of that UI. Its configuration explains the
restriction, Start is disabled, and a valid direct Start request returned
**409 `NATIVE_EXECUTION_KIRO_UNAVAILABLE`**. A consistent authority read
confirmed no execution record. This exercised no Kiro model work and does
not qualify Kiro for release.

The waiting scenario is **blocked on the pending application fixture decision**.
Fresh intent `a3603caa-8c60-4d8e-ba0f-18605f92e773` published
`8c29e19314bcfcca1e902c22963c9d919bfd8524ddca6ce14c52ebae795715e1`
from CLI session `6a89dea9-a923-417e-b57c-2788651ea74a`. Its actual question
asks how to handle the missing source baseline: `index.html` contains an
empty Phaser scene, with no bird, pipes, score, flap/restart inputs,
`package.json` or test tooling. The reply remains unanswered. No plan was
selected and no created workflow was verified, so this is not a created-workflow
recovery proof. The separate fixture choice must be resolved before continuing it.

Fresh intake intent `616beab2-4f20-4e7d-b988-35aab343eea1` reached the
initial express-plan offer, with publication
`655d9c5fc9c41240ad88c8d353dfa11b00d26bd0703d85da24f0aa02907c6221`
and CLI session `b9753320-74ee-4985-bc6c-370b572deccc`. Its natural-expiry
intake rejection **passes**. After **954.585 seconds** from the recorded idle
baseline, the member submitted the existing instruction to keep the source
baseline decision open, selecting no plan option. The browser received **202**.
Dispatch detected the lost session before sending the reply to the harness.
Current EFS state reported `workflowResumeState: "not_created"`; the authority
recorded `INTAKE_UNAVAILABLE`, `canRecover: false`, and confirmed predecessor
stop at `2026-10-27T10:14:26.689Z`.

The browser visibly explains that AI-DLC 2.11.1 requires a created workflow
and offers no fresh-session resume action. A valid direct recovery request
using the current recovery ID and `confirmWorkspaceResume: true` returned
**409 `NATIVE_EXECUTION_CONFLICT`**, leaving the authority revision unchanged.
The original publication's API and actual browser history preserve answer
`8f3a7e1f-77e1-481f-a473-dddace526048`, its author, exact bytes and acceptance
time `2026-10-27T10:14:23.222Z`. Its original `deliveryStatus: "pending"` is
unchanged, with no delivery time, resulting publication or recorded approval.
The same EFS binding, configuration, writer generation **1** and original
publication remain. Scoped lifecycle evidence shows only the initial CLI
launch, no continuation/resume dispatch, and no private checkpoint capture
or restore.

| Remaining NE-02 proof                                                      | Status and prerequisite                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Created-workflow waiting expiry, fresh CLI and next real workflow question | **BLOCKED** on the pending application fixture decision; the source-baseline question remains unanswered.       |
| Post-resume `answer.resumeRetention.delivery: "undelivered"`               | **NOT RUN**; intake denial preserves the answer but admits no resume episode.                                   |
| Active-tool interruption, retained edits/dependencies and real build/tests | **BLOCKED** on the fixture decision and separately authorized operator credentials or user execution.           |
| Missing/wrong EFS workspace rejection                                      | **BLOCKED** on isolated, recoverable created-workflow resources and operator authorization; no faults were run. |

No operator fault, deployment or change to historical intents was performed
during this stage. No implementation correction was needed, and the candidate's
backend/frontend suites were not repeated. Redacted evidence and documentation
validation results are under `.native-evidence/ne02-2026-10-27-live/`;
`pin-comparison.json` records the deployment/configuration comparisons,
`intake-recovery-proof.json` records the completed negative proof, and
`waiting-blocker.json` retains the exact unanswered source-baseline question.
NE-02 remains unchecked; NE-03 must wait for the remaining live proof.

**Approved game fixture and fresh qualification, 2026-10-27:** the user resolved
the source-baseline decision: build a minimal game and tests on the pinned empty
scaffold. The approved scope is one playable Phaser scene with simple shapes,
flap controls, obstacles/collision, score, game-over/restart, and keyboard-accessible
pause/resume through `P` and a visible control. Pause must preserve the run and
score. Add the smallest suitable package/build/test setup, deterministic gameplay
and pause/resume/restart tests, controls documentation and an actual browser
playability check. Keep Phaser **3.60.0**, the version in the scaffold. Application
changes belong to the native workspaces and their publications; no GitHub push
or PR delivery is requested.

Fresh requests explicitly acknowledge the intentionally empty baseline. The
earlier waiting and intake intents remain unchanged. This stage uses the deployed
implementation `526837eb8394735e6b365bdfbcda249af84c5e3f`, with documentation
head `cb0392871097f006e30d15696801ff154d313ffe`. Each new Start was checked against
the same immutable runtime image, AI-DLC 2.11.1 package/materialization, Claude
model and platform Bedrock scope recorded above. All four executions resolved
the approved application branch to
`d99d2511c43f07ff2451e7e13f5a8f45b16dfce2`; scoped AWS reads verified their separate
runtime endpoints, EFS bindings and 900-second idle timeouts.

| Scenario                          | Fresh native intent                    |
| --------------------------------- | -------------------------------------- |
| Created-workflow waiting recovery | `5dcf330b-1ce8-47c5-972b-9bd5d4b9315b` |
| Interrupted active tool           | `26b5b329-9c15-421d-9fc6-69f11a714c43` |
| Missing EFS project               | `f3cc998d-e457-4e4c-948c-985a2da1eb39` |
| Incorrectly bound EFS project     | `33ab1cb2-8f74-4c41-aff2-71c27b3cb8fe` |

Each express plan was explicitly selected through the application, preserving
its six approval gates. Current stage evidence is recorded separately under
`.native-evidence/ne02-2026-10-27-game/`; `accepted-pin-comparison.json` records
the four accepted-configuration/resource comparisons. The previous
`.native-evidence/ne02-2026-10-27-live/` evidence remains unchanged.

The created-workflow waiting recovery **passes its recovery checks**. The
requirements approval question in publication
`c07099e6b6da43642e489c8b6a9dcc62ddaab94032b1c9a674572a864282b8ac`
was left idle for **974.635 seconds** after the recorded baseline, with no runtime
keepalives. The actual browser approval was accepted at
`2026-10-27T13:03:02.818Z` as answer
`c6e9fd82-7448-4660-90bb-e31ff00cdcd3`. Dispatch detected session loss before
delivery, observed a created workflow in EFS, and confirmed the predecessor stop
at `2026-10-27T13:03:05.951Z`. The member then explicitly confirmed
**Resume in a fresh session** through the browser.

Writer generation **2** retained binding
`750fc226-5c11-4ca7-84e7-c0d685e0bc72`, EFS access point
`fsap-03451764da3b9a46d`, configuration and runtime target. CLI identity changed
from `28b1b8dc-7f1e-4c55-b088-6368d45715fd` to
`f741550b-167a-4a6d-8f59-d2a6e07c380c`. New publication
`6c12d45367e9dcf153d587e1270e4a1c7b7ea6225201918da9624fdf848dd0f7`
contains the real requirements approval question. The active pointers, committed
intent registry, initialized state, answered requirements questions and
requirements document all survived byte-for-byte; the requirements gate
remained open.

The original revision's answer retained its ID, actor, acceptance time and bytes
both before and after the new publication. Its
`answer.resumeRetention.delivery` is **`undelivered`**, with no delivery
timestamp, resulting publication or recorded approval. The recovery request
contained only its request ID, recovery ID and explicit workspace-resume
confirmation. Lifecycle evidence and metadata-only listing of the exact attempt's
private recovery prefix show no checkpoint capture, export, import or restore.
The original answer was not replayed. After reviewing the surviving requirements,
the member submitted a distinct approval of the new question at
`2026-10-27T13:08:09.818Z`; this starts implementation without treating recovery
confirmation as consent. `waiting-created-recovery-proof.json` and the original
answer history captures record this proof.

After that distinct approval, the native harness implemented the game in its
workspace. Member-visible tool results record **17 passing tests** in
`tests/rules.test.js` and a successful **Vite 7.3.7 production build** (10 modules,
4.83 seconds). An initial score-boundary test failed; the harness adjusted its
setup and reran all 17 tests. Its Chromium playability attempt could not launch
because the runtime lacks `libglib-2.0.so.0`. These are actual native test/build
results, but the final application files have not passed publication review,
and an actual browser playability check remains **NOT RUN**.

The implementation turn then **failed publication** with
`native_execution_output_result`. Its content-free diagnostic records
`result_mismatch` at result record **176**, with **3** assistant text blocks and
**1** observed query boundary. The runtime rejected the result at
`2026-10-27T13:22:19.217Z`; runtime stop was confirmed at
`2026-10-27T13:24:36.775Z`. Publication
`6c12d45367e9dcf153d587e1270e4a1c7b7ea6225201918da9624fdf848dd0f7`
remains the last admitted revision. It contains the recovered requirements
question, not the game result. The failed execution and its history are preserved.
`waiting-native-validation-observed.json`, `waiting-game-output-rejection.json`
and `waiting-output-rejection-lifecycle.json` record these separate boundaries.

Inspection of static executable code in the exact deployed Claude 2.1.296 image
shows that its engine can queue completed parent-query results while background
work runs, then emit those results in order after later assistant messages.
An inert fixture of that producer sequence reproduces the deployed parser's
`result_mismatch`: it compared every result only with the latest response.
This identifies a supported sequence the parser rejected; it does not claim
that private live transcript bodies were read or reconstructed.

The bounded runtime correction validates deferred results against ordered
assistant responses from the current invocation. The final observed response
must still have a successful terminal result before publication; failed,
incomplete, reversed, duplicate terminal and foreign-session results remain rejected.
The existing text/query limits, credential checks and silent-notification
handling remain enforced. Executor-level tests cover both successful publication
and refusal when a later result is absent or failed, without private checkpoint
operations. This correction requires a newly built runtime image and fresh
deployed qualification; its local tests do not establish a live pass.

The interrupted-tool workflow followed its approved qualification procedure:
install real dependencies, leave genuine game edits unfinished, then enter the
existing helper's foreground barrier before the separately executed scoped stop.
The native harness installed Phaser **3.60.0** and wrote a deterministic game
core with **15 passing tests**. Input routing, the Phaser scene and final
build/browser validation were still unfinished. The **150-second** barrier
expired normally without an operator stop. Publication
`9ce6bb50f85c87557daa12ce8601e5f63556747d116be53adcad57c2cdbbef86`
preserves that partial work and asks whether to retry with a fresh nonce or
finish implementation. This question remains unanswered, and the old stop
command is stale. No interruption, dependency-link retention or fresh-session
reconciliation is claimed. A retry needs a new live foreground barrier with
genuine unpublished work; the helper requires at least **45 seconds** remaining
when it inspects the barrier.

The two isolated workspace-negative cases have created workflows and confirmed
predecessor stops after natural expiry. Their prepared commands remain scoped
to the exact intent, attempt, writer and nonce in `missing-operator-command.json`
and `wrong-operator-command.json`. The user chose to execute these helpers, which
quarantine each original project and stop their diagnostic session. No operator
profile was authorized for the agent; `solution-read` remains read-only.
Their result files and subsequent browser rejection still need verification.

| NE-02 check at this stage                                                      | Status                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Deployed candidate/configuration/image alignment                               | **PASS** for deployed `526837eb`; the parser correction is not deployed.                    |
| Temporary Kiro unavailability and intake-expiry rejection                      | **PASS**, retained from the preceding deployment stage.                                     |
| Created-workflow waiting expiry, fresh CLI, preserved answer and next question | **PASS**, with the exact identities and retention evidence above.                           |
| Native game tests and production build after resume                            | **PASS** for the observed commands; final source/publication review remains open.           |
| Game result publication                                                        | **FAIL**, with a locally reproduced parser correction awaiting deployment.                  |
| Actual game browser playability                                                | **NOT RUN**; native Chromium could not launch and no game result was admitted for download. |
| Interrupted active tool and retained dependency links                          | **BLOCKED**; the barrier expired without the separately executed stop.                      |
| Missing/wrong EFS workspace rejection                                          | **BLOCKED** pending the user-run helper results and browser checks.                         |

**Local correction validation, Node 24.21.0:** the 163 focused parser/executor
tests pass. The full AgentCore project passes **3,165 tests**, with **10 skipped**
for Bun-dependent and Linux-only coverage on this host. All **43** controller
caller checks pass; the nine-test workspace journey file was rerun with
loopback access after the sandbox denied two local HTTP listeners. The 22 native
wiring tests, six architecture tests, architecture check, dependency check,
lint, formatting, secret scan and documentation build pass. Lint reports
82 warnings and the dependency check reports 17 warnings, with no errors.
The full backend and frontend suites were not repeated for this runtime-only
correction. Logs and source hashes are recorded in this stage's
`repair-validation.json` and `repair-image-source.json`; the latter identifies
the new image's expected source-derived tag, not a deployed digest.

NE-02 remains unchecked. Preserve these runs and deploy the runtime correction
before starting a fresh, matching positive proof. NE-03 and full Kiro
qualification remain in their existing sequence.

**Workspace-fault follow-up, 2026-11-02:** the user ran the prepared handoff after
a machine reboot. It stopped at the first helper: `missing-operator-result.json`
reports `ok: false`, `runtime_response_invalid`, and
`diagnosticStop.confirmed: true`, without a workspace receipt. Its original
1,331 bytes remain unchanged, SHA-256
`f02e94345522b8fdc2fba793d1ac0a0e6e059793ccd0426d47667a295b3e7061`.
The script's exit-on-error behavior prevented the missing-result verifier and
wrong-project command from running. Neither fault has a successful verified
operator result.

Scoped reads with `solution-read` reverified account `746558295630`,
`us-east-1`, both accepted runtime version **2** endpoints, their EFS access
points and the original immutable image
`sha256:074c50086bee10ca4d086fa3df0a9f87251a684bfa34df6ec67cf08cd65f6eeb`.
The API, authority, execution worker, provisioner and wakeup package hashes and
image settings still match deployed `526837eb`; the execution-authority alias
remains version **15**. All 272 runtime source hashes still match the locally
validated parser correction `3280c8b4`. Its expected image tag
`d2dff54e22d80b4f` remains a source-derived build identity, not a deployed digest.

The missing-case runtime log records command request
`ff81f1fe-8353-4881-ba9c-1517ca3871ac` at `08:05:32.500Z`.
The logged command matches the original fixed **20,655-byte** helper command
exactly. The same diagnostic log stream records `SIGTERM` at
`08:05:33.511Z`, corroborating the helper's checked stop acknowledgement.
These observations establish receipt of the command and diagnostic stop, not
the outcome of the rename or quarantine. The old helper discarded which
response-validation check failed and returned no filesystem observation.
The exact response-contract mismatch and the first mutation's outcome remain
unknown; the command must not simply be rerun.

Both authority records are unchanged from their October 27 expiry evidence:

| Case            | Intent                                 | Preserved boundary                                                                                        |
| --------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Missing project | `f3cc998d-e457-4e4c-948c-985a2da1eb39` | Revision **313**, writer **1**, publication **2**, accepted answer `89de5291-d7d0-48f0-aa62-7fae7a6ebe36` |
| Wrong project   | `33ab1cb2-8f74-4c41-aff2-71c27b3cb8fe` | Revision **470**, writer **1**, publication **2**, accepted answer `167f809d-46bb-4724-888e-c52037835307` |

Both remain `RECOVERY_REQUIRED` with the same created-workflow recovery episode,
confirmed predecessor stop, session and EFS binding. Publication, interaction,
accepted member, acceptance time, answer hashes and the original `pending`
delivery classification are unchanged. No new writer or publication is recorded.
This is preservation evidence, not the waiting case's separate retained,
undelivered-answer proof.

The local operator helper now records bounded response metadata and failure
phase without retaining raw stdout, stderr, headers or SDK exceptions. It
explicitly requests the documented binary event-stream response format while
keeping acknowledgement, session, completion, scope and exit checks enforced.
This transport change is not yet a live fix for the unidentified mismatch.
The new `inspect-workspace` action requires a stopped, created workflow and
checks the recorded owner, project inode and original nonce's quarantine.
It reports intact, missing, replacement or partial-quarantine observations
without moving, deleting or repairing project files. Like the existing fault
helpers, it bootstraps only `native-status` and confirms its diagnostic stop.
Only user execution or a separately authorized operator profile may run it;
`solution-read` remains rejected.

The signed-in dev browser was reopened after the reboot. No browser recovery
was submitted against an unverified fault. Missing-workspace mutation status
remains **UNKNOWN**, the wrong-workspace fault is **NOT RUN**, and both browser
rejection proofs remain **BLOCKED** on verified filesystem observations.
The exact, guarded inspection handoff and fresh evidence are under
`.native-evidence/ne02-2026-11-02-workspace-faults/`. The handoff preserves the
failed result and writes distinct inspection receipts; an inspection is not a
replacement success receipt for the failed mutation. A read-only control uses
the previous response-format request so its diagnostics can be compared with
the explicit event-stream request. Each diagnostic stop must be confirmed before
the handoff starts another session for that intent.

**Local helper validation, Node 24.21.0:** all **42** focused helper tests pass.
The full release-script run passes **313 of 315** tests. Its local HTTP fixture
passes separately with loopback access after the sandbox's `EPERM`; the release
metadata check passes against a byte-identical snapshot of all **46** tracked
release inputs after the root check also scanned unrelated `.worktrees`
manifests. Those worktrees remain untouched, and the full root run is not
reported as green. Lint and dependency checks report their existing **82** and
**17** warnings with no errors; the architecture check reports no violations.
Formatting, the secret scan and the documentation build pass. The inspection
receipt verifier passes **27** synthetic checks; these establish no live outcome.
No runtime, frontend or application source changed in this follow-up. The
earlier parser correction still requires user deployment, and game publication,
browser playability, interrupted-tool recovery and both workspace rejections
remain open. NE-02 stays unchecked.

**Inspection receipts and contract correction, 2026-11-02:** the user ran the
inspection handoff from `1128a1bd`. All three diagnostic stops are confirmed,
but neither workspace inspection passed. The five new result/verifier files and
the original failed mutation receipt remain byte-for-byte unchanged.

| Inspection               | Actual command response                                                                                       | Qualification consequence                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Missing, implicit Accept | Request `162b81f0-a4ee-4d1c-bee7-75df589acffa`: verified event stream, exit **1**, `workspace_invalid`.       | The command rejected a workspace invariant; the first mutation's outcome remains unknown. |
| Missing, explicit Accept | Request `eb2d77ad-2176-408d-82c7-b6d6ca91da24`: identical **154-byte** stdout and failure.                    | Explicit Accept did not resolve this failure.                                             |
| Wrong, explicit Accept   | Request `e7dff25d-f893-4977-8859-f21ed77a54e5`: exit **0**, **569-byte** JSON, rejected at report projection. | Command completion alone did not establish a valid inspection receipt.                    |

The two missing-case stdout hashes are both
`21f7371b0c9b0a4ea5092cc455bb77ecc4989fddb31b9a8df450bf26f44a5515`.
The wrong-case stdout hash is
`fb8c7205a92a701b4442817385f99f226e3faf708932722dc0219f8b83d37068`.
Scoped runtime logs match all three **22,586-byte** generated commands exactly.
Their respective diagnostic streams record `SIGTERM` at `09:02:06.446Z`,
`09:02:27.835Z` and `09:02:36.008Z`. Neither the retained responses nor these logs
contain the actual inode values or the missing command's failed invariant.
The wrong response's discarded JSON cannot be recovered from the retained hash.
The missing receipt's generic `quarantined: false` describes that inspection's
local mutation flag; it does not establish that the earlier fault left the
original project in place.

The executable-command investigation reproduced a concrete inode contract
defect. The native executor persists `String(lstat(..., { bigint: true }).ino)`,
which can be negative when Node exposes the file ID through `BigInt64Array`.
The operator helper accepted only unsigned digits. A signed project inode
therefore returned `workspace_invalid` inside the generated command; a signed
root or machine inode reached the JSON response and was rejected as
`runtime_response_invalid`. The real shell command, embedded functions,
serialization and streamed consumer reproduced both failure shapes. All three
unsigned layout controls passed before the repair; all twelve signed layout
cases failed. These reproductions identify the code defect, but do not recover
the missing live invariant, identify the wrong response's particular inode
field, or establish either live project's current location.

The helper and response projector now validate canonical full-width inode
strings without numeric coercion or changing recorded identities. Comparisons
remain exact: adjacent large IDs and unsigned aliases of recorded signed IDs
are rejected. Owner, configuration, package, epoch, writer, NFS, predecessor-stop
and no-active-harness checks remain enforced. Failed inspections identify the
specific validation check and fixed subject, with bounded observed/recorded
inode metadata and allowlisted filesystem error codes. Report projection records
the field it rejects. Arbitrary paths, stdout, stderr, private records and SDK
exceptions are not returned. Inspection failures no longer expose a
`quarantined` mutation flag.

All **79** focused tests pass on Node **24.21.0**. Generated-command coverage uses
real temporary files, permissions, links, renames and readback, with simulated
NFS mount/process metadata and signed file IDs; it is not live EFS proof. It
covers original, quarantined-missing and replacement projects, guard failures,
the actual operator consumer and diagnostic cleanup. The separate terminal
verifier passes **46** checks using generated serialized reports across five
filesystem layouts, denied receipts and the preserved live failures. These
synthetic results never qualify a workspace fault.

The full release-script run passes **350 of 352** tests. The same sandbox
loopback failure passes when rerun with loopback access; the metadata check
passes against the unchanged **46** tracked release inputs after the root run
also scanned unrelated `.worktrees` manifests. The full root run remains
explicitly not green. Lint, dependency, architecture, formatting and secret
checks pass. No runtime or frontend source changed.

Current scoped reads still show authority revisions **313** and **470**, writer
**1**, the same publications, accepted answers, EFS bindings and confirmed stops.
The five deployment owners and execution-authority alias still match deployed
`526837eb` and image
`sha256:074c50086bee10ca4d086fa3df0a9f87251a684bfa34df6ec67cf08cd65f6eeb`.
Fresh evidence and a guarded, two-inspection handoff are under
`.native-evidence/ne02-2026-11-02-inspection-contract/`. It preserves all failed
receipts, uses the original nonce-scoped quarantines, writes distinct output
files, and repeats neither fault nor the resolved Accept comparison. The
inspection runs from the corrected checkout without redeploying the runtime.
User execution remains necessary because no operator profile is authorized for
the agent. No browser recovery is submitted while filesystem state is unknown.
The missing mutation remains **UNKNOWN**, the wrong mutation **NOT RUN**, and
both browser rejection proofs **BLOCKED**. Waiting recovery retains its earlier
pass; parser deployment, game publication/playability and a fresh active-tool
proof remain open. NE-02 stays unchecked.

**Verified inspections and browser recovery attempt, 2026-11-02:** both corrected
inspections from `a7c4ddf2` now pass every verifier check, with confirmed diagnostic
stops. They establish the filesystem state independently of the earlier failed
receipts, which remain unchanged.

| Isolated intent                                | Verified filesystem observation                                                                     | Remaining qualification                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Missing `f3cc998d-e457-4e4c-948c-985a2da1eb39` | Project absent; original inode `-6973646241848332581` preserved in the original nonce's quarantine. | Browser attempt **FAIL**: recovery remains in `FENCING` before workspace validation. |
| Wrong `33ab1cb2-8f74-4c41-aff2-71c27b3cb8fe`   | Original project inode `5919596651590142328` still present; no quarantine or replacement.           | Wrong-project fault and browser rejection **NOT RUN**.                               |

The missing inspection's root is `1538196158438670172`, machine inode is
`-3605233117112043272`, and quarantine inode is `8140747515712229876`.
The quarantined project's inode exactly matches the recorded original.
The wrong inspection's root is `-4931017981954711920`; its project and machine
inodes are positive. Its **569-byte** stdout SHA-256,
`fb8c7205a92a701b4442817385f99f226e3faf708932722dc0219f8b83d37068`,
exactly matches the previously rejected response. This confirms the signed-root
projection defect with live evidence. The missing project's recorded signed
inode also establishes why the later unsigned inspection validator rejected
that identity. The original missing mutation receipt remains failed; its
discarded response bytes are not recovered or replaced by a fabricated receipt.
The independent successful inspection now proves that the original was
quarantined and remains preserved.

Before the browser action, scoped `solution-read` checks reconfirmed account
`746558295630`, region `us-east-1`, authority revisions **313 / 470**, writer
**1**, resource/configuration pins and predecessor-stop evidence. All five
deployment owners still match implementation `526837eb`; the immutable runtime
image remains
`sha256:074c50086bee10ca4d086fa3df0a9f87251a684bfa34df6ec67cf08cd65f6eeb`.
Neither the approved application source pin nor the accepted configuration was
changed.

The signed-in browser submitted exactly one explicit fresh-session confirmation
for the missing intent. The public recovery POST returned **202** at
`2026-11-02T10:08:31.606Z`, request
`5c6d6d6e-3ee0-4df2-bfd6-a0523a526bc7`, recovery episode
`8587ede1-0565-412a-8822-f6ef2701e9e5`. At the authoritative read at
`11:01:16.721Z`, revision **328** was still `RECOVERING / FENCING`, with actual
writer **1**. The browser continued displaying “Resuming in a fresh session”;
it did not display the required missing-workspace rejection. A later scoped read
at `12:05:20.761Z` still showed `FENCING`, revision **344**, writer **1** and the
same publication. Scoped runtime lifecycle reads through `12:05:32.884Z` found
no new turn.

The before/after comparison finds identical canonical hashes for all **67**
pre-existing immutable records. Only the recovery event and
the answer-retention observation were added. Both publication records, the
output cursor, accepted responses and the exact S3 fence version/bytes remain
unchanged. Publication
`b8e6edd41cc2d5599e2c19b624b19d6eb05a108a9da935e6c3ae688e462a9894`,
CLI identity `347e5f42-5c6a-4020-8935-c773de24cf7f`, AWS session
`588f4912-f5cc-433d-9d18-b90fd2298dfc` and EFS binding
`abf4667b-b37e-49e2-a02b-de4da8e17644` remain the predecessors. No new writer,
publication or runtime turn was observed. No private checkpoint is recorded.
These safety observations do not substitute for the missing browser rejection.

The original revision visibly retains answer
`89de5291-d7d0-48f0-aa62-7fae7a6ebe36`, actor
`e4787488-c071-709b-50c7-f2cd87682d0b`, accepted at
`2026-10-27T12:55:32.904Z`. Its immutable text hash and acceptance identity are
unchanged. The new retention fact records `delivery: undelivered`; the historical
view says it was not sent again, with no delivery timestamp, resulting
publication or recorded approval. No new answer or workflow consent was sent.

The deployed retry log retains only a generic code, without the execution scope,
failing control operation or SDK error type. Scoped logs cannot establish the
cause of this stalled recovery. A bounded local correction now records
allowlisted operation/error/status metadata and the existing scope hash for
failures during authority reads, authorization, fencing and predecessor stop.
It preserves the original errors and every ownership/stop check; a
`ResourceNotFoundException` is still not positive stop evidence. This is a
diagnostic correction, not a claimed live repair of the unidentified failure.

The final owning-project command, `npm test -- --project=native-runtime-control`,
passes **1,450** tests on Node **24.21.0** with local Gremlin and DynamoDB
containers. Earlier logs retain the sandbox loopback failures and the
standalone configuration's missing-DynamoDB-endpoint failure with dummy test
credentials. The final root-project run supplies the correct local endpoints.
Lint passes with the existing **82** warnings, dependency checks with **17**
warnings, and architecture checks with **0** violations. The secret scan passes;
unrelated `.worktrees` are excluded from the scoped lint/secret checks.

Fresh evidence is under
`.native-evidence/ne02-2026-11-02-workspace-rejection/`, including the token-free
public request capture, actual UI screenshots and authority/fence comparisons.
The single user-run handoff is
`handoff/run-wrong-workspace-fault.sh` in that directory. It pins the reviewed
checkout, original command and successful inspection hashes, rechecks the
unchanged wrong-case authority at revision **470**, preserves the original in
the nonce-scoped quarantine, creates only the intended empty replacement and
verifies its diagnostic stop. It writes fresh result filenames and never repeats
the missing fault. **63** local checks exercise its real generated command,
streamed consumer, signed metadata, preserved files, authority guards and
terminal verifier; a successful inspection cannot be labeled a successful fault.
These are synthetic filesystem/SDK checks, not live fault qualification.

The user runs that one wrong-project action with their existing dev operator
profile. It requires no deployment. The parser correction `3280c8b4` and the new
control diagnostics remain undeployed; deployment and renewed live verification
are subsequent work. Waiting recovery, temporary Kiro unavailability and intake
rejection retain their earlier passes. Missing/wrong browser rejection, game
publication/playability and fresh active-tool recovery remain open. The expired
October 27 active-tool stop command must not be reused. NE-02 stays unchecked.

**Verified wrong-project fault and browser attempt, 2026-11-02:** the user ran the
single guarded wrong-project handoff. Its receipt and terminal verifier pass
every check. The original project inode `5919596651590142328` is preserved in
`.ne02-quarantine-957535fc-5e38-43ad-985b-af115f6cead6/project`; the empty replacement
has the different inode `-7351887095847076373`. Root, machine, workspace record,
configuration, attempt, writer and nonce match the successful inspection and
prepared command. The diagnostic stop is confirmed with token
`e8b8eaa5-29ce-433a-a975-bd041d61f573`. The new receipt's SHA-256 is
`1d93b9727d2bfba2b2908790885c0e6eea7aec11810d0b349aa9de5b84fb3d8b`.
All earlier receipts, including the failed missing mutation, remain unchanged.
The agent independently verified this receipt without invoking any operator
action.

Scoped reads reconfirmed the account, region, runtime endpoint, accepted image,
EFS access point and stopped writer before the browser action. All **67**
authority records and the S3 fence matched the preceding wrong-case handoff.
The signed-in browser then submitted exactly one explicit fresh-session
confirmation for `33ab1cb2-8f74-4c41-aff2-71c27b3cb8fe`. Its public recovery POST
returned **202** at `2026-11-02T13:11:35.415Z`, request
`f5744c21-2e24-43af-9050-105964ad6448`, recovery episode
`c87b2c44-fd08-4a07-8ef9-4beec42b1297`. No answer or workflow approval was sent.

The wrong-workspace browser qualification is **FAIL**. At `13:15:22.751Z`,
authority revision **473** was still `RECOVERING / FENCING`, with actual writer
**1**; the planned writer **2** was not admitted. The browser displayed
“Resuming in a fresh session” instead of the required workspace rejection.
Scoped lifecycle reads through `13:15:25.308Z` found no new runtime turn.
The missing case also remained in `FENCING`, revision **361**, writer **1**, at
`13:15:27.605Z`. Both filesystem faults are established, but neither browser
rejection has passed. No additional fault or recovery retry was performed.

For the wrong case, all **66** pre-existing records other than the mutable
`EXECUTION` record have identical canonical hashes. Only the expected recovery
event and answer-retention fact were added; no record was deleted. Both
publications, the output cursor, accepted responses, S3 fence bytes/version and
predecessor-stop evidence remain unchanged. The retained publication is
`24b6d3c1a8c25c1dde39ad9e542efe1964d58949365709cc173cda802c006be6`,
CLI identity `327a7b7d-b62e-4a4e-923c-0b6313ea3b8d`, AWS session
`f71491ca-9c59-444a-afa1-2e4b98e17091` and EFS binding
`c5193bbe-843d-47e2-ad99-ded5933c60b1`. No new writer, publication or CLI identity
was observed; no private checkpoint is recorded.

The original revision visibly retains answer
`167f809d-46bb-4724-888e-c52037835307`, actor
`e4787488-c071-709b-50c7-f2cd87682d0b`, accepted at
`2026-10-27T12:55:36.769Z`. Its immutable response, text hash and acceptance facts
are unchanged. The original dispatch classification was `pending`; the new
retention fact is `delivery: undelivered`, without a delivery timestamp,
resulting publication or recorded approval. Recovery intentionally clears the
mutable pending-response/dispatch pointers while preserving this ledger.
That removal prevents automatic replay; it does not delete the accepted answer.
The original-revision browser card explicitly says the answer was not sent again.

Fresh package metadata still matches the five previously verified deployment
owners from `526837eb`, with runtime digest
`sha256:074c50086bee10ca4d086fa3df0a9f87251a684bfa34df6ec67cf08cd65f6eeb`.
The parser repair `3280c8b4` and control diagnostics `ef69e016` remain undeployed.
The generic deployed retry log still does not establish the failing operation.
The next dependency is user deployment of that candidate's backend and fresh
runtime image, followed by deployed alignment and scoped failure diagnosis.
A backend-only deployment retaining the old image cannot qualify the parser
repair. Existing executions retain their accepted pins; renewed positive game
qualification must accept the newly verified image digest.

Evidence is under `.native-evidence/ne02-2026-11-02-wrong-rejection/`, including
the fault-receipt reconciliation, token-free public request/response metadata,
actual browser screenshots and before/after authority comparisons. **17**
checks of those captured records pass; they establish preservation, not the
missing browser rejection. Local evaluation of the actual Terraform source-hash
expressions verifies all **272** runtime source hashes against the parser
candidate and still yields tag `d2dff54e22d80b4f`. This is a source-derived tag,
not a built or deployed digest. The documentation-only follow-up does not repeat
unaffected application suites. Markdown formatting, the scoped secret scan,
`git diff --check`, evidence-script syntax, `uv sync --group docs --locked` and
`uv run --no-sync zensical build` pass. Waiting recovery, temporary Kiro
unavailability and intake rejection retain their prior passes. Missing/wrong
rejection, game publication/playability and fresh active-tool recovery remain
open; NE-02 stays unchecked.

**Verified deployment and confirmed-stop repair, 2026-11-02:** the user deployed
`d0529c735d6c52e57b07ada90d35d44eec44f219`. Scoped `solution-read` reads first
reconfirmed account `746558295630` and region `us-east-1`. All **522** deployed
frontend files, including the entry document, match the local deployment
output. All entries in the **six** native Lambda packages match a fresh build
of that candidate; the **five** authority aliases also match. The new base
runtime image is source tag `d2dff54e22d80b4f`, immutable digest
`sha256:534ccfd547671cee197ae10e3700fccd4b9ec51cc16d099f7cdafddbab568a2b`.
The deployed image pins agree. A network-disabled, read-only check of that
exact image verifies **267** shipped source modules and Claude Code
**2.1.296**, with zero model calls or CLI sessions. The parser repair and scoped
controller diagnostics are now deployed; this image inspection is not a new
game-publication or recovery proof.

Both existing fault intents correctly retain their accepted runtime image
`sha256:074c50086bee10ca4d086fa3df0a9f87251a684bfa34df6ec67cf08cd65f6eeb`,
runtime endpoint, EFS access point, configuration and application source pins.
The current image policy permits these referenced recovery executions without
retargeting them to the new base image. Fresh positive qualification must use
the newly verified image.

The deployed diagnostics establish why both browser recovery confirmations
stall: the controller repeats `StopRuntimeSession` despite an authoritative
positive stop for the exact predecessor writer and session. That repeated
operation returns **HTTP 404** before workspace validation. The missing case
records request `2bda201d-9ea0-40a5-ad7a-bd66e9eb87d3` at
`2026-11-02T13:34:08.315Z`; the wrong case records
`3f51da5d-887a-4076-9d13-d3849597460e` at `2026-11-02T13:34:59.139Z`.
The allowlisted diagnostic reports the service error name as `unknown`;
private provider response bodies were not collected. The exact provider reason
beyond the stop operation and HTTP status is therefore unverified.

At `13:39:22Z`, the missing and wrong cases remain `RECOVERING / FENCING`,
authority revisions **368** and **479**, actual writer **1**. All **69** missing
and **68** wrong records other than mutable `EXECUTION` match their preceding
authority snapshots; fence bytes and versions also match. Accepted answers,
retention facts, publications, predecessor-stop evidence and source/session
identities are unchanged. No new writer, publication or checkpoint is observed.
The earlier missing-project inspection and wrong-project fault receipt still
establish the isolated filesystem faults and preserved quarantines. No fault,
inspection, recovery confirmation or model turn was initiated in this follow-up.
The browser rejection checks remain **FAIL: stalled before workspace validation**.

The focused controller repair reuses the validated stop confirmation only for
the same EFS predecessor generation, session and prepared runtime, after fencing
and fresh ownership checks. A missing, unconfirmed, wrong-session or different
generation stop still needs an exact positive response; an HTTP 404 never
becomes stop evidence. Checkpoint recovery retains its existing stop requirement.
The real public recovery API, store, supervisor and Stop adapter reproduce the
six-day delayed-confirmation failure for both writer generations **1** and **2**.
Both regression cases fail against the deployed implementation and pass with
the repair. Cancellation and lease takeover after fencing still prevent the old
worker from advancing.

The cancellation regression also exposed an invalid authority transition:
cancelling during `FENCING` retained a resume command for a successor writer that
was never admitted. The store now removes only that proposed command during
cancellation. Its accepted-answer ledger, publications and positive predecessor
stop remain intact; a command for an already admitted writer is preserved.
This is local regression evidence, not a live cancellation result.

Final local validation passes **178** focused tests and all **1,460** controller
tests in **52** files with
`npm test -- --project=native-runtime-control --maxWorkers=4`. An earlier full
run recorded **1,459** passes and one five-second DynamoDB Local test timeout;
that failed log is preserved. The final run uses the existing timeout and all
tests. All eight native controller bundles build. Lint, module boundaries and
native architecture checks pass, with their existing warnings recorded.
Formatting, the scoped secret scan, `git diff --check`,
`uv sync --group docs --locked` and `uv run --no-sync zensical build` also pass.

Evidence is under `.native-evidence/ne02-2026-11-02-deployed-d0529c73/`, including
deployed byte comparisons, installed-image hashes, scoped diagnostics, authority
comparisons, the failing reproductions and final validation logs. The next
dependency is user deployment of the controller repair, followed by verification
of the queued recoveries and their visible workspace rejections. Frontend and
runtime source are unchanged by this repair; the verified new base image remains
the deployment target. Do not repeat either filesystem fault or the already
accepted recovery confirmations. Waiting recovery, temporary Kiro unavailability
and intake rejection retain their earlier passes. Fresh game publication,
playability and active-tool recovery remain open; the expired October 27 barrier
is unusable. NE-02 remains unchecked and NE-03 must wait.

**Interrupted controller deployment and ECR helper diagnosis, 2026-11-02:** the
user ran the `bfdc4d65` handoff. Terraform apply failed while configuring private
ECR authentication for the AgentCore and Yjs Docker providers. The failed plan
`terraform/ne02-2026-11-02-stop-bfdc4d65e3ba.tfplan` remains preserved with SHA-256
`f4d12310fee4bc0a7301d1f42590cb65634d2d0b7f190c7cf1b466fda678ba17`.
The handoff correctly rejected reuse of that path.

The required `/usr/local/bin/docker-credential-ecr-login` symlink points to
`/Applications/Docker.app/Contents/Resources/bin/docker-credential-ecr-login`,
which is absent. Docker itself is reachable. The locked Docker provider
**3.9.0** replaces credential-helper errors with “couldn't find registry config”
when reading `config_file_content`. Its actual installed binary reproduces the
same error with the missing helper; the same isolated Terraform fixture plans
successfully with a working helper returning synthetic credentials. This test
uses a nonexistent Docker socket with the daemon check disabled, performs no
apply and makes no AWS calls. The original provider diagnostic does not retain
the underlying error, and the time or cause of the helper's removal is unknown.

Fresh `solution-read` evidence confirms all **six** native Lambda packages still
have their previously deployed bytes. The authority, execution worker and
credential packages therefore still lack the `bfdc4d65` repair. The deployed
base image remains
`sha256:534ccfd547671cee197ae10e3700fccd4b9ec51cc16d099f7cdafddbab568a2b`.
Normalized Terraform state comparison shows changes to eight local package-hash
records, with no changed AWS resource attributes in that state comparison.
The partial state also retains **18** deposed local packaging instances; a fresh
plan must reconcile them. No state repair or deployment was run by the agent.

Both fault executions remain `RECOVERING / FENCING`, writer **1**, at revisions
**377** and **484**. All **69** missing-case and **68** wrong-case non-execution
records, fence bytes/version and positive stop confirmations remain unchanged.
No new publication, checkpoint or accepted-answer replay is observed.
The workspace rejection checks remain stalled before validation.

Evidence and a new single-command user handoff are under
`.native-evidence/ne02-2026-11-02-ecr-auth/`. The handoff installs the standalone
Homebrew ECR helper when needed, selects its executable explicitly, checks
private ECR authentication without printing credentials, and runs the reviewed
backend deployment with a fresh plan. Six local preflight cases cover valid,
malformed, empty, wrong-user, expired and missing-helper responses, including
suppression of private output. An initial shell fixture incorrectly rejected
helper input without a newline; its failure is preserved and the corrected
actual-provider control passes. Runtime and frontend source are unchanged.
The nine existing ECR deployment tests, formatting, scoped secret scan,
`git diff --check` and documentation build pass. Existing controller validation
remains applicable; live deployment and all remaining NE-02 qualification
requirements are still pending.

**Saved-plan credentials and interrupted-package cleanup, 2026-11-02:** the
standalone ECR helper is now installed. The subsequent bare `terraform apply`
failed during S3 backend credential resolution. The user-run wrapper's
`AWS_PROFILE=solution` export is scoped to its child process tree and does not
configure a later command entered in the parent terminal. The backend does not
store a profile. No new apply is claimed from this error.

The saved plan
`terraform/ne02-2026-11-02-ecr-7115d5e72c8f.tfplan`, SHA-256
`db2d5e7b583e510434d611457326d0693fd7205e8a3b5024c7b16db1265423d5`,
and its original JSON are preserved. At **15:10 UTC**, `solution-read` confirmed
the plan's lineage and state serial **1383** still match the remote state.
Actual authority, execution and credential package bytes still match the
previous deployment, so the controller stop repair remains undeployed.

Replaying the ordinary plan inspector against that exact JSON reproduced another
blocker before apply: it rejected **18 deposed local packaging instances** as
native service removals. Every one has a retained current instance at the same
address, and this plan deletes no AWS resource. The focused inspector repair
allows cleanup only for the three existing package-helper type/name pairs, with
a nonempty deposed identifier and a matching managed current instance that
survives. Whole-helper removal, missing or different current instances, resident
service deletion, storage deletion and runtime-image retention remain guarded.
The unchanged saved plan now passes the repaired inspector.

The **33** focused tests pass, including the separate authenticated apply script,
deposed cleanup and its rejection controls. The full release suite reports
**356 passed / 1 failed**: its release-metadata scan enters the pre-existing
untracked `.worktrees/` checkouts and rejects their package versions. Those
checkouts remain untouched. Lint and dependency checks pass with existing
warnings; formatting, the changed-file secret scan and documentation build pass.
The broad root secret scan was stopped after **148 seconds** because its scope
includes the unrelated untracked checkouts; it is not recorded as a pass.
Existing controller/runtime tests are not repeated for this deployment-tooling-only
change.

Evidence and the single user-run apply handoff are under
`.native-evidence/ne02-2026-11-02-apply-credentials/`. The handoff sets the
operator profile and region for the complete process tree, selects the installed
ECR helper, preserves the original plan/JSON and applies an identical plan copy
through `scripts/deploy-terraform.sh --phase apply --skip-seed`. Terraform still
checks the saved plan against locked current state. Frontend and runtime source
are unchanged. No agent deployment, operator fault or new recovery confirmation
was performed; deployment and the remaining live NE-02 checks are still pending.

**Verified controller deployment and opaque resume rejection, 2026-11-02:**
the user deployed `f0ca575cae75441b1400d043c1ab0fc42965714b`.
Fresh `solution-read` evidence verifies account **746558295630**, region
**us-east-1**, all **eight** distinct native bundles across **nine** Lambda
functions, and all five authority aliases at version **17**. Every downloaded ZIP
entry matches the reviewed build. The frontend entry, main bundle and native
creation/service bundles still match the earlier **522-file** deployment proof.
The base runtime image remains
`sha256:534ccfd547671cee197ae10e3700fccd4b9ec51cc16d099f7cdafddbab568a2b`;
the earlier installed-image and Claude **2.1.296** verification remains applicable.
Both fault executions retain their accepted
`sha256:074c50086bee10ca4d086fa3df0a9f87251a684bfa34df6ec67cf08cd65f6eeb`
image, model, package, application commit and EFS bindings. Their executable
endpoints remain ready at runtime version **2**.

The stop repair advances the existing confirmations from `FENCING` to
`RESTORING`, with writer generation **2** reserved and its fence active. The
missing intent adds event `native-400` at **15:19:53.534 UTC**; the wrong intent
adds `native-507` at **15:21:07.457 UTC**. All **69** and **68** prior records
outside `EXECUTION`, respectively, retain their canonical hashes. The original
publication, accepted answer, retention classification and predecessor stop proof
remain unchanged. Reserving generation 2 is not evidence of a new CLI admission.

Both browser status refreshes still show **“Resuming in a fresh session”**.
Their public GET responses report `RECOVERING`; neither workspace rejection has
passed. Scoped execution logs now report `RuntimeClientError`, HTTP **424**, on
`native-resume`, followed by the existing short retry decision. The correct
executable runtime log groups contain boot telemetry and no new harness lifecycle
boundary in the inspected window. Runtime request IDs, selected log metadata,
browser receipts/screenshots and before/after authority hashes are preserved
under `.native-evidence/ne02-2026-11-02-deployed-f0ca575c/`. These reads do not
recover the original SDK error body or prove its hidden runtime rejection code.

A local reproduction composes the real runtime server and filesystem checks, an
AgentCore HTTP error envelope, the actual SDK deserializer, public recovery API,
conditional authority and fence. A missing project and a replacement project
both return runtime HTTP **409** with `native_execution_workspace_invalid`.
When that JSON is replaced by an opaque SDK error, both tests remain
`RECOVERING`, reproducing the observed stall. The two failing controls are
preserved separately from passing repair validation. This establishes the local
contract defect; the exact hidden cause of the live 424 remains unverified until
the repaired controller obtains a current workspace observation.

The focused controller repair uses the existing `native-status` operation to
read the positively stopped predecessor after an opaque resume error. It accepts
only a cold response with the exact predecessor identity, writer, publication and
interaction as evidence for a **negative** verdict. Its workflow observation is
computed from current EFS state. An unavailable workflow blocks recovery;
verified intake blocks it as intake. A created workflow, unreadable response,
foreign identity or stale boundary never acknowledges a successor or grants
recovery. The read does not ingest the predecessor's activity, replay its answer,
read a private checkpoint or change the pinned image. Authority is rechecked
around the read; the ordinary fence and confirmed-stop path still closes any
runtime opened during diagnosis.

Validation passes **239 focused tests** and the owning
`npx vitest run --project=native-runtime-control` suite:
**1,477 tests across 52 files**. Coverage includes both real filesystem faults
through HTTP/SDK, preserved work and answers, no new runtime owner or model turn,
foreign/stale observations, a cancellation race, and a lost acknowledgement
after a real inert subprocess turn without replay. All eight deployment bundles
build. Lint, the changed-file secret scan and architecture/dependency checks
pass; dependency warnings remain **17**, with zero errors. Formatting and the
documentation build are recorded with the final candidate evidence.

The repair is **local and undeployed** at this boundary. Its single user handoff,
`handoff/deploy-workspace-observation.sh` in that evidence directory, selects
profile `solution`, verifies the existing ECR helper and uses
`scripts/deploy-terraform.sh dev --phase all --skip-seed` with a fresh
candidate-specific plan. The preserved plans and inspection receipts remain
unchanged. No frontend deployment, image change, repeated workspace fault or
additional recovery confirmation is needed. The queued recoveries must be
verified again after the controller deployment. Missing/wrong browser rejection
remain **FAIL** at the observed stall; repaired live rejection, game
publication/playability and active-tool recovery remain open. NE-02 stays
unchecked, and the expired October 27 active-tool stop command remains unusable.

**Verified missing/wrong-workspace rejections, 2026-11-03:** the user deployed
`8ffd126762b7e9a292d01523d1feb748c2a056b3`. Fresh `solution-read`
inspection confirms account **746558295630**, region **us-east-1**, and every
downloaded package entry across **nine** native Lambda functions against the
reviewed candidate. Execution and cancellation both contain the corrected
`execution-worker.mjs`, SHA-256
`90727c1e6946eb3479beb56c307ef71280d1de993c7ea321a738e24bf5892013`.
All five authority aliases now select version **18**, with unchanged authority
bytes. The base runtime digest remains
`sha256:534ccfd547671cee197ae10e3700fccd4b9ec51cc16d099f7cdafddbab568a2b`.
The frontend entry and previously verified chunks are unchanged. Both fault
executions retain their accepted `074c5008…` image, executable endpoint version
**2**, EFS bindings, configuration, package, model and application source pin.

The two already queued recovery confirmations now finish with
`RECOVERY_REQUIRED`, reason `WORKFLOW_STATE_UNAVAILABLE`,
`workflowResumeState=unavailable` and `canRecover=false`. Scoped diagnostics show
the opaque resume error followed by a cold predecessor status response:
generation **1**, publication sequence **2**, `recovered=true`, and no identity
mismatch. The controller then closes generation **2** and confirms its runtime
stop. Each corresponding runtime logs `SIGTERM` with `busy=false` within a
second of that confirmation. Generation 2 was reserved before this deployment;
these checks did not admit another writer, publication or CLI/model turn.

| Scenario and preserved intent                  | Backend and browser result | Confirmed stop, UTC | Public GET request ID                  |
| ---------------------------------------------- | -------------------------- | ------------------- | -------------------------------------- |
| Missing `f3cc998d-e457-4e4c-948c-985a2da1eb39` | **PASS**                   | 07:15:06.059        | `89303d84-e117-4c4e-b673-6729c08a3fcf` |
| Wrong `33ab1cb2-8f74-4c41-aff2-71c27b3cb8fe`   | **PASS**                   | 07:15:06.442        | `27a05279-0b1e-42de-8ccb-a3fb02c8f1e9` |

Both actual browser status refreshes return HTTP **200** with recovery disabled.
Both pages visibly explain that recovery is unavailable because an existing
workflow could not be verified, while published work and accepted answers remain
available. Neither offers “Resume in a fresh session.” No recovery confirmation,
workspace fault, saved answer or operator diagnostic command was submitted during
this verification.

All **70** and **69** existing records outside `EXECUTION`, respectively, retain
their pre-deployment canonical hashes. Each intent adds only its recovery-required
lifecycle event (`native-15106` and `native-14655`). Both publication-2 identities,
original CLI identities, answer authors, acceptance times and answer text hashes
remain unchanged. The original retained answers still have delivery
**undelivered**, with no delivery timestamp, resulting publication or recorded
engine approval. The browser shows those retained answers in their original
revisions. No new output or publication record, queued reply or private checkpoint
appears. The fences remain closed throughout the browser checks.

The evidence, screenshots, public response metadata, stop corroboration and
**36 passing evidence assertions per scenario** are under
`.native-evidence/ne02-2026-11-03-deployed-8ffd1267/`. The prior **141-file**
manifest, its five candidate source hashes and ten external references were
verified before editing this tracker. The failed original missing-project
receipt remains failed; the later successful inspection establishes its absent
project and preserved original quarantine. The successful wrong-project receipt
and both quarantines remain preserved. No fault or inspection was repeated.
The raw body behind the SDK 424 remains unavailable; the current EFS observation
establishes the negative verdict. Provider billing and quarantine file bytes
were not independently re-audited in this stage.

No additional operator action or deployment is needed for these two rejection
checks. This stage changes documentation only; the previously recorded controller
tests remain applicable. Documentation formatting and site-build validation are
recorded with its evidence. Created-workflow waiting recovery, intake rejection
and temporary Kiro unavailability retain their prior passes. Result publication
through the application and a fresh interrupted-active-tool recovery proof remain
open. Generated-output quality and playability are excluded by the corrected
scope above. NE-02 stays unchecked, NE-03 has not started, and the expired October 27 stop
command must not be reused.

**Tool-only fixture scope, 2026-11-03:** the user's correction arrived after
draft `cd022952-432a-4574-8e79-ca9cb11b08a0` was created and its isolated
workspace requested. A consistent authority read found no execution record,
CLI writer or publication. No generated-game model work had started.
The prepared draft was reused with an explicit prompt amendment through the
application before Start. The reduced fixture requests only small draft files
and a real dependency installation, then a member/operator readiness question.
It does not start an expiring barrier or request game-quality verification.
The original draft request and preparation receipts are preserved under
`.native-evidence/ne02-2026-11-03-game-positive/`; subsequent tool qualification
is recorded separately under
`.native-evidence/ne02-2026-11-03-tool-recovery/`.

Pre-Start reads reconfirmed the nine deployed controller package hashes,
five authority aliases, unchanged frontend assets and runtime image
`sha256:534ccfd547671cee197ae10e3700fccd4b9ec51cc16d099f7cdafddbab568a2b`
against implementation `8ffd126762b7e9a292d01523d1feb748c2a056b3`.
Start accepted amended prompt revision **1**, AI-DLC **2.11.1**, Claude Code,
the existing platform Bedrock/model scope and application source
`d99d2511c43f07ff2451e7e13f5a8f45b16dfce2`. The accepted attempt is
`bab30bfb-a158-486f-b12c-9b6df147e5ad`, runtime session
`6b241d97-23d9-47b5-8e58-94934098a08b`, EFS binding
`84cc90a6-eb79-4b33-9b60-e731a9809102`, writer **1**. All four admitted
publications identify CLI session `8a240037-b848-4114-ad42-67372ee8cdf0`.

**Opaque result publication passes for this execution.** Sequences **1–4**
admitted publications `79b36712…64202`, `7a8810cb…4d2`, `64bc2680…b827`
and `220186c6…bc73`, containing **24**, **41**, **48** and **58** files
respectively. The production
publication reader verified every immutable object version, byte length,
digest and execution identity without evaluating or running the generated
content. The signed-in application's first three publication inventories
match storage metadata, and its retrieved file has the same bytes/hash. Anonymous requests
for that publication, interaction and file each returned **401**; a separate
nonmember account was not exercised. The original publication and all its
file versions still matched after sequence 3 was admitted.

The express plan was selected through the real member interaction. Its
accepted answer and the subsequent routine fixture choices have distinct
command IDs, actor/acceptance metadata and delivered-history records. Sequence
2 exposed the real requirements question for created workflow
`261103-phaser-fixture-scaffold`. The actual requirements gate was then
approved for the minimal fixture only. The authority read at that stage showed
**AWAITING_USER**, sequence **4**, writer **1**, no private recovery checkpoint,
and readiness interaction
`e6ebb2d1f2cc63619f400ddbcf64094fd3ef56c6266de280432fd5af681a029c`.
The application visibly asked whether the member/operator was ready for the
interruption step; this question was unanswered at that stage.
Controller `CALL_FAILED`/`EBUSY` observations
delayed admission and dispatch; existing retries progressed without repeated
Start or answer submissions. The underlying SDK error cause is not established.

At that handoff, the active-tool interruption remained **NOT RUN**. No operator
readiness, barrier or stop had occurred. The admitted fixture provided the preceding
publication; the unpublished edit and actual dependency links still require
direct workspace inspection during the live interruption. The local terminal
handoff waits for operator readiness, verifies a fresh live barrier and a
changed `src/draft.js` byte identity, and stops only the exact pinned execution.
It then waits for application recovery and reads the same workspace to compare
retained file bytes, dependency links and the new CLI/writer identities.
It does not submit answers, start model work, bootstrap a diagnostic session,
or perform a second stop. A temporary computer-control
`cgWindowNotFound` failure prevented actions at the requirements gate. Access
was restored after reconnecting the tool, and the buffered token-free browser
receipts were exported without a capture error.
The user-run handoff is `handoff/run-active-tool-stop.sh` under the current
evidence directory. It pins the reviewed commit, exact publication and resource
identities, and refuses changed state or existing output files. Its readiness
window is 15 minutes; the barrier itself is not started until the member has
explicitly confirmed readiness and lasts at most 150 seconds. Natural session
expiry does not authorize a different writer or reuse of a failed handoff.
No deployment, repeated workspace fault or generated-output quality check is
required. NE-02 remains unchecked.

Local validation for this scope/evidence update: **79 existing qualification
helper tests** and **26 handoff contract checks** pass. The handoff tests use
real temporary file bytes, Git differences, dependency symlinks and a child
process, with simulated AWS responses, Linux process metadata and signed NFS
inode IDs; they are not a live stop/recovery pass. They reject changed pins
between inspection and stop, an expired/dead barrier, already-published work
and ambiguous stop results, as well as changed retained bytes, reused CLI
identity, unexpected writer generations and a retained response on recovery.
Syntax checks for the evidence helpers, secret
checks, canonical-document formatting and the documentation site build pass.
No application test/build or playability qualification was performed.

**Expired operator readiness, 2026-11-03:** the user ran the reviewed terminal
observer, but no barrier answer was submitted before its initial 15-minute
deadline at **08:57:19.083 UTC**. It returned
`readiness_wait_expired` / `qualificationStatus: NOT_RUN`. Its inspection log
is empty, and no inspection or stop receipt exists. All original output bytes
remain preserved. A consistent authority comparison before the next browser
action found the same writer, publication and turn; all **13** immutable
publication, interaction and accepted-answer/request records still matched.
This was a coordination timeout, not an interrupted-tool recovery result.

The next member action was **Not yet**, through the actual readiness question.
The API accepted command `d0c27e9a-6464-4da1-898a-23945e0760d3` at
**09:04:53.276 UTC**. Dispatch detected natural session loss before delivery,
and the controller confirmed writer 1's predecessor stopped. The member then
explicitly confirmed **Resume in a fresh session** through the browser
(recovery `cbecd3f4-2ecf-4918-87ca-fe9fa4f38968`). Writer **2** was admitted
against the same accepted configuration and EFS binding. This refresh does
not qualify an active-tool interruption.

The refreshed CLI is `0019fe5c-00ce-4c03-8cac-684820772501`. It produced
publication `d54f882046f128e143ac5bc0e7edeacbb20b8195f0bce9de4dda11f4972a43eb`
(sequence **5**, **59** verified opaque files) and readiness interaction
`4193aea11ba9acf2f1a9d9218cfba87eb08f7688deeee248811cbb17a1bcd2ed`.
The application exposes that new question. The original revision still
shows the accepted **Not yet** answer, its original member and acceptance
time, and an explicit retained/undelivered notice. Authority retains the
matching immutable answer and `delivery: undelivered` observation; writer 2
has no response pointer to replay. The EFS fence is active for writer 2,
and writer 1's stop confirmation precedes recovery.

The replacement local handoff under
`.native-evidence/ne02-2026-11-03-active-readiness/handoff/` removes the initial
coordination countdown. While the reviewed question remains unanswered, it
only reads authority; it does not inspect a runtime, start model work or stop
a session. Its 15-minute observation deadline starts only after the exact
barrier answer is accepted after operator readiness. The actual foreground
barrier still lasts at most **150 seconds**, and a stop still requires at least
**45 seconds** remaining, a live Claude descendant, the exact reviewed writer,
an unpublished edit and verified dependency links. Old answers, changed pins,
an expired/dead marker or an uncertain stop result fail closed. The agent
must remain active to observe the user's terminal readiness and submit the
separate member answer. The expired handoff and its nonce are not reused.
The new packet pins writer **2**, publication **5** and nonce
`162d653d-1e44-4fc0-b232-03547c3a23e2`; its read-only preflight against the
actual authority passes. No barrier or operator stop has started.

The revised handoff's **28 contract checks** pass. An initial local test used
inconsistent simulated and real barrier clocks; the test clock was corrected,
then all checks passed. This is local handoff validation, not a live stop.
Syntax and secret checks, canonical-document formatting and the documentation
site build also pass.
New receipts and comparisons are kept separately under
`.native-evidence/ne02-2026-11-03-active-readiness/`. No deployment or repeated
workspace fault is required. Generated-output quality remains outside the
completion verdict, and NE-02 remains unchecked.

**Accepted-answer observer repair, 2026-11-03:** the replacement observer became
ready at **09:17:25.206 UTC**. The member sent the separately reviewed barrier
answer through the application at **09:18:03.893 UTC**, command
`9b069c13-3edb-454c-a52e-de398983a894`. The observer then failed before any runtime
inspection or stop. Its original failure receipt, empty inspection log and
reviewed sources remain preserved. The process exited; the authority still has
writer **2** and only the earlier writer **1** stop confirmation.

The local handoff incorrectly required `response.text` on the execution pointer.
The production store deliberately keeps `textSha256` there and stores the text
in the immutable response record. A scoped read of both actual records reproduced
the rejected invariant: the pointer has no text, and its hash matches the
immutable answer and the exact submitted **3,254-byte** member answer. The old
failure receipt itself contains only a generic error; this diagnosis comes from
the reproduced caller contract, not invented exception details.

The corrected handoff pins the hash of the complete reviewed member answer,
including its nonce and command. Preparation, terminal preflight and observation
use that same contract. Named failure invariants retain only value types, never
answer bodies or arbitrary SDK errors. **28** generated-command/consumer checks
and **11** public-API/store/serialization checks pass. The latter use the existing
repository execution fixture and production codecs, with local AWS transports;
they are not live interruption proof. Initial integration-test setup failures
were corrected without changing production acceptance guards and are retained
with the final logs.

Meanwhile, turn **6** finished without an operator stop and admitted publication
`635f714c0238d1a58d9d5b4c2c97c9c96ed603c8824278a4c7f538ee8369ae66`
with **61** verified opaque files and the same CLI. The member application exposes
interaction `fb4929871574b97da3a0a1dcb61dce407d082354d1c3e86981bdab39518e5ca4`.
Its structured form is absent; its published response and free-text reply field
show the real choice to retry the barrier, continue Code Generation or leave
the work unchanged. The response reports that the previous barrier ran its full
150 seconds. No live barrier inspection exists for that attempt, so it remains
**NOT RUN** for active-tool recovery.

The fresh packet under
`.native-evidence/ne02-2026-11-03-active-answer-contract/handoff/` pins writer **2**,
publication **6** and nonce `56ba01dc-2cbd-4e62-a521-0ada621edf6b`. The current
authority preflight passes. Its **3,474-byte** member answer is prepared but has
not been submitted; only after user-terminal readiness will it select the real
retry option, request one small unpublished fixture edit and run the fresh
barrier. Both earlier nonces are retired. The same stop, fence, process, EFS,
dependency-link and post-recovery preservation guards remain required.
No production change or deployment is needed for this local handoff repair.
Generated-output quality remains excluded and NE-02 stays unchecked.

**Completed tool recovery proof, 2026-11-03:** the corrected observer and actual
member path now pass the interrupted-tool acceptance. Together with the preserved
created-workflow waiting, intake and workspace-rejection proofs, this completes
**NE-02 for the native execution tool**. It makes no assertion about generated
application correctness, tests/build or playability. The earlier expired observer,
failed observer and failed mutation receipts retain their original outcomes.

The user ran the reviewed observer with `solution`; the agent used `solution-read`
only for scoped AWS reads. After verifying the live observer's readiness, the
member submitted the fresh **3,474-byte** answer through the browser at
**09:33:19.367 UTC**. Its command is
`cfc15189-f99b-4ed8-8845-249127e23057`, and its complete text SHA-256 is
`31299c8b9851148c692e7cd32b81c7fb8f19fe087437d3e60902b7b817b45c0c`.
The nonce was `56ba01dc-2cbd-4e62-a521-0ada621edf6b`, for intent
`cd022952-432a-4574-8e79-ca9cb11b08a0`, attempt
`bab30bfb-a158-486f-b12c-9b6df147e5ad` and writer **2**.
The accepted answer hash matched the reviewed packet and immutable authority.

The observer found the new foreground barrier as a live Claude descendant,
with a new unpublished edit and installed dependency links. Its one stop
completed at **09:34:54.564 UTC**, before the **09:37:15.971 UTC** barrier deadline.
The controller confirmed the predecessor stop at **09:35:00.000 UTC** and fenced
writer **2**. The actual browser offered recovery; the member confirmed **Resume
in a fresh session** at **09:35:30.555 UTC**. The accepted recovery ID is
`f8ce7f0b-8ba2-45a7-8907-a977ec74bfa2`, public request ID
`699d4c83-59ef-4e1b-bfec-bae8e50ca4c0` and HTTP request ID
`fc6e316c-99d7-4ab6-9408-54a3d6203fd2`. That request contained confirmation and
identifiers only. Writer **3** became authoritative after the confirmed stop,
without a response pointer or automatic answer replay.

The fresh CLI is `a45076cf-30d6-4687-9c94-4bd71b2203bf`; the stopped CLI was
`0019fe5c-00ce-4c03-8cac-684820772501`. Both use binding
`84cc90a6-eb79-4b33-9b60-e731a9809102`, runtime session
`6b241d97-23d9-47b5-8e58-94934098a08b`, EFS `fs-0dbff85b86169efdc` and access point
`fsap-056d12e9bf18b7b37`. The post-recovery inspection matched the original root,
project and machine inodes, workspace record and barrier marker. It also matched
the unfinished **412-byte** file, all **four** dependency symlinks and the
**one** hardlinked target. The file hash is
`1a6093c96177d055634b63ebbf1c33f9371af5c044d34337fc3ce5910e51d1b6`;
the dependency-link hash is
`fab36d8a680c1504538e5f13bc37c36968b61c9125467861f525d711b1d11479`.
The user observer performed the retained-work read at the new question, exited
normally and issued no bootstrap or second stop.

The runtime published revision **7** at **09:38:55.185 UTC**; authority admission
completed at **09:39:01.084 UTC**. Its publication is
`8f57928f01e6ac080bc8089f0e0fc6eb92b4b590ca5ba655c7b4c5ad81e7de97`
and interaction is
`b2b5a8c218eca23567809320edcf578e2c4c3cd6128b44c5b5c72e6b99541d3a`.
The production readers verified all **62** opaque files and the interaction
against their immutable storage versions, byte counts, hashes and identities.
The signed-in member saw the matching inventory, fetched the exact retained
412-byte file, and saw a real Code Generation question about the surviving
unfinished work. The reply field remained empty with **Submit Answer** disabled.
Anonymous publication, interaction and file reads each returned **401**.
No separate signed-in nonmember account was available; denied membership remains
covered by the existing public-API regression tests.

Revision **6** still exposes the original answer ID, member, acceptance time and
text hash. Its original delivery time is **09:33:23.148 UTC**, and
`answer.resumeRetention.delivery` remains **`delivered`**. The browser explicitly
says it was retained and not sent again. There is no resulting publication
assigned to that interrupted answer and no recorded application, rejection or
approval. All **29** earlier immutable publication/answer/request records remain
unchanged. The earlier waiting answer
`d0c27e9a-6464-4da1-898a-23945e0760d3` also remains **`undelivered`**, without a
delivery or resulting-publication record. The active-tool answer's delivered
classification does not substitute for that waiting-session evidence.

The accepted configuration and all observed writers retain AI-DLC **2.11.1**,
Claude Code **2.1.296**, model `global.anthropic.claude-sonnet-5-5`, platform Bedrock
credentials and source commit `d99d2511c43f07ff2451e7e13f5a8f45b16dfce2`.
Configuration SHA-256 remains
`3c92dd4556e7afedd931be395045abde08dc1be568b44bd9e552d15a15f0acab`.
The deployed implementation remains
`8ffd126762b7e9a292d01523d1feb748c2a056b3`, with runtime image
`sha256:534ccfd547671cee197ae10e3700fccd4b9ec51cc16d099f7cdafddbab568a2b`.
The authority has no private checkpoint, and the fresh turn's scoped lifecycle
evidence contains no checkpoint capture, upload, download or restore. The
legacy private-checkpoint wording still visible below the file inventory is not
runtime evidence; obsolete recovery copy belongs with NE-03 removal.

Evidence is under `.native-evidence/ne02-2026-11-03-active-answer-contract/`.
`active-tool-completion-proof.json` passes **54** combined checks.
`independent-retained-inspection-verification.json` reproduces the user's **14**
mechanical retention checks from the original receipts; those receipts correctly
retain `qualificationStatus: "NOT_RUN"` because they do not themselves prove the
member path. `prior-stage-verification.json` verifies preserved evidence and
combines the earlier scenario results without repeating faults. The **28**
handoff and **11** production-caller tests recorded above remain applicable to
unchanged source. Documentation formatting, local links, evidence syntax/secret
checks and the documentation build pass. No production implementation changed
in this completion stage; full backend/frontend/release suites were not rerun.

The fixture remains **AWAITING_USER** at the unanswered revision 7 question, with
no active model turn. Its workspace and history are preserved, as are both
quarantined fault originals. No deployment, repeated fault or further operator
action is required. **NE-03 has not started.** Full Kiro qualification remains
NE-18, and all four harnesses remain required for release.

### NE-03 implementation — 2026-11-03

The local candidate removes the native private CLI snapshot/restore stack. The
runtime no longer captures a CLI home or session database, exports/imports a CLI
session, uploads/downloads a private checkpoint, or replaces the project with an
exact filesystem restore. `session-recovery-files.js`, the private checkpoint
store/codec, dependency-link and executable-link restore planners, and their
exclusive tests and qualification fixtures are deleted. Public dependency
visibility still uses `node-dependencies-v1`, now owned by
`native-project-files.js`.

Start, reply and resume require the explicit `efs-workspace-v1` pin, command
schema 2 and writer generation. The runtime has no `native-recover` command;
missing/unknown modes, obsolete commands and invalid writer requests are rejected
before executor construction. The controller no longer admits private checkpoint
receipts, auto-selects an exact restore, or retains checkpoint pointers. Legacy
native fence readers, the recovery compatibility manifest, and old installed CLI
archive/restore qualifications are removed. The EFS fence uses schema 3 without
a checkpoint field. Both the public router and authority require
`confirmWorkspaceResume: true`; confirmation admits one fresh session and never
replays an accepted answer. The internal `RESTORING` phase and `RESTORE_FAILED`
reason remain names for the existing EFS admission/retry transitions; they do not
invoke filesystem or CLI restoration. New audit facts and UI copy describe fresh
sessions; recorded historical events are unchanged.

The following paths remain intentional:

- Public result snapshots, immutable versioned publications, public file
  verification, interaction/answer history, comparison and export. Their
  `native_snapshot_*` errors describe public file capture only.
- Pinned methodology-package archive materialization, including its cold-cache
  `restore` operation. It installs the attested package; it does not restore user
  work or a CLI session.
- Shared platform workflow checkpoints and CLI stores used by platform execution
  and ordinary live-session replies. Native repair checkpoints track scan progress.
  Diagnostic/debug archives and bounded initialization/probe observations remain
  separate from recovery authority.
- EFS workspace identity/configuration pins, current-workflow observation,
  predecessor stop evidence, writer fencing, and immutable retained answers.
  Negative assertions against the retired private prefix remain as regression
  controls; no implementation reads or writes that prefix.

Terraform removes the native runtime boundary's private-checkpoint grant and the
execution worker's private-checkpoint read grant. Public publication, execution
fence, EFS and package permissions remain. No npm package or container dependency
was exclusive to the deleted implementation: Node built-ins, Python, CLI drivers
and SDK packages still have shared/current callers. Lockfiles and the Dockerfile
therefore do not change. Installed qualification now targets the surviving EFS
protocol and retains installed failure/cancellation checks; Kiro qualification
remains deferred to NE-18.

Implementation commit `ce718ec8450743ce19a46d304036772996042564` follows the verified
starting commit `a6ebc303cbdd167e3ff2c768368805b11584de8a` on
`feat/native-aidlc-execution`. Logs, source hashes, the isolated release-test
manifest and the final checkout identity are recorded in
`.native-evidence/ne03-2026-11-03-removal/`. Local validation used Node **24.21.0**,
npm **11.19.0** and Terraform **1.17.0**:

| Check                        | Command or scope                                                                                                                                                                                                                  | Result                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Full backend                 | `node --no-experimental-webstorage node_modules/vitest/vitest.mjs run --maxWorkers=4`, with the root Docker/Testcontainers setup                                                                                                  | **11,086 passed, 8 skipped**; 382 files passed, 1 skipped     |
| Full frontend                | `npm --prefix frontend test -- --maxWorkers=4`                                                                                                                                                                                    | **2,099 passed** across 150 files                             |
| Frontend build               | `npm --prefix frontend run build`                                                                                                                                                                                                 | **Passed**, including TypeScript                              |
| Release tooling              | `node --test --test-concurrency=4 scripts/test/*.test.mjs` in an isolated, hashed copy of tracked source                                                                                                                          | **358 passed**                                                |
| Code checks                  | `npm run lint -- --ignore-pattern '.worktrees/**'`, `npm run dep:check`, `npm run sdk:check`                                                                                                                                      | **Passed**; no lint/dependency errors, 16 dependency warnings |
| Formatting and secrets       | `oxfmt --check` on changed files; `secretlint --secretlintignore .gitignore --no-glob` on all 1,705 existing tracked files; `git diff --cached --check`                                                                           | **Passed**                                                    |
| Native architecture          | `node scripts/native-architecture.mjs`                                                                                                                                                                                            | **409 production modules, 0 violations**                      |
| Packaging                    | Bundle all eight native controller entry points with the owning package's esbuild settings; stage the packaged qualification sources and import both EFS protocol entry points                                                    | **Passed**; local bundles/imports only                        |
| Terraform                    | `terraform -chdir=terraform fmt -check -recursive`; isolated `TF_DATA_DIR`, temporary local backend override, `init -backend=false -lockfile=readonly`, `validate -no-tests`; `test -filter=tests/native-architecture.tftest.hcl` | **Passed**; 2 mocked infrastructure tests; override removed   |
| Native IAM/deployment wiring | `python3 -m unittest discover -s terraform/modules/compute/native-runs/tests`                                                                                                                                                     | **22 passed**                                                 |
| Source and documentation     | Changed JavaScript syntax, local Markdown link targets, `uv sync --group docs`, `uv run zensical build`                                                                                                                           | **Passed**                                                    |

The regression suites cover Start/reply/resume boundaries, explicit member
confirmation, obsolete/unknown request rejection, unavailable workflow/workspace
cases, predecessor stop and writer fencing, lost acknowledgements, retained
answers without replay, public file verification, history/download/export and
shared platform consumers. Existing lint, SDK, provider-deprecation and frontend
bundle-size warnings remain recorded. The skipped tests are not counted as proof.

The direct checkout release run encountered the pre-existing metadata scanner
errors in `.worktrees/native-resume-confirmation/package.json` and
`.worktrees/ne02-fault-qualification/package.json`. The isolated full release run
preserves those unrelated worktrees and tests the tracked source; its manifest
records the exact bytes. The subsequent recovery REST test-fixture correction
is covered by the final full backend run, and the retained dependency fixture's
only subsequent change is its comment. Earlier fixture/runner and cached-backend
initialization failures are recorded separately from the passing final checks.
Commit hooks were not rerun; the checks above were executed explicitly.

At this implementation boundary, the change had not been installed in a newly
built runtime image, deployed, or exercised against a live model. Local mocked
infrastructure tests and bundles do not prove deployed IAM, installed CLI or EFS
behavior. The subsequent installed-image checks are recorded below.
The NE-02 deployed commit `8ffd126762b7e9a292d01523d1feb748c2a056b3` and image
`sha256:534ccfd547671cee197ae10e3700fccd4b9ec51cc16d099f7cdafddbab568a2b`
remain historical proof of NE-02, not proof of these deletions.

Deployment must coordinate the frontend, authority/API, worker, native runtime
image and tightened Terraform policies. Use matching new native runs after that
rollout; there is no migration or compatibility path for earlier development
executions. Existing records, EFS workspaces and cloud objects are not deleted or
rewritten. Admission/deployment and any fresh live qualification are operator
handoff work, outside this local implementation. Generated content remains opaque
fixture data; application quality and workflow approval are not inferred from
these tests. NE-04 turn-ownership work is not part of this change.

### NE-03 installed-image qualification — 2026-11-03

The ARM64 runtime image was built locally from a tracked-source archive of
`c5cd18516216aee3aaa4ab63d85211d2bfa760d6`, with the existing dev
`ENABLE_NATIVE_INTERACTION_PROBE=true` build argument. Its immutable local image
identity is
`sha256:d3d0805e5ac809800b08aacfe5cdc34c5e28030bdc4152e2409d9e0bd5d6689c`.
No source files were mounted over the packaged runtime during qualification.
All **268 packaged production files** matched the candidate hashes before each
of the four container checks, and the four removed private recovery modules
were absent. The controller used a separately bundled candidate adapter with
in-memory AWS ports.

Fresh fixture preparation and verification passed for the attested **AI-DLC
2.11.1** release, **32** frozen OpenCode dependency packages and the locked Linux
ARM64 test binding. Host tooling used Node **24.21.0**; the image retains its
Dockerfile-pinned Node **24.19.0**. The existing installed runner completed with
`--installed-only --packaged-image --cli claude,codex,opencode`, the immutable
image above and those fresh asset/cache/binding directories.

| Installed check     | Result                                                    |
| ------------------- | --------------------------------------------------------- |
| Linux regressions   | **155 passed** across 4 files                             |
| Claude Code 2.1.296 | **PASS**; 3 CLI sessions and 11 admitted publications     |
| Codex 0.162.1       | **PASS**; 2 CLI sessions and 10 admitted publications     |
| OpenCode 1.19.0     | **PASS**; 2 CLI sessions and 7 admitted publications      |
| Kiro                | **NOT RUN**; full qualification remains deferred to NE-18 |

Each selected CLI passed installed failure, incomplete-output, descendant
cancellation and login-shell dispatch checks, plus its existing workflow and
fresh-session transport fixture. Claude exercised the three-choice plan gate,
replacement sessions and retained workspace. Codex also exercised the fixture's
dependency rebuild and reconciliation question. The current OpenCode fixture
does not exercise those two branches; its pass covers its recorded transport
and gate checks. These results do not expand the advertised release matrix.
Generated content is opaque fixture data; no generated application's quality
or playability was qualified.

The containers used **disabled networking**, a deterministic local provider and
disposable Linux directories. This is installed CLI/package and runtime protocol
evidence, not an AWS EFS mount, deployed IAM, real-provider or browser result.
There were no implementation fixes or repeated host backend/frontend suites in
this stage. Exact build/fixture/matrix commands, timestamps, source hashes and
results are under
`.native-evidence/ne03-2026-11-03-image-qualification/`, including
`qualification-summary.json` and `installed-matrix-result-1.json`.

Deployment remains user-executed. The single handoff is
`handoff/run-ne03-deploy.sh` in that evidence directory. It checks the final
candidate commit, clean tracked tree, qualified image, evidence and local
configuration hashes; selects the existing `solution` profile, dev account and
`us-east-1`; and verifies the installed ECR credential helper without printing
credentials. It runs the ordinary Terraform deployment with a new preserved
plan and `--skip-seed`, then deploys the matching frontend. It refuses a repeated
attempt and retains phase/output receipts for inspection. Its `--check-only`
mode performs local checks before any credential or deployment operation.

Wait for both deployment stages before creating a new native run. The returned
deployment receipt still requires independent comparison of deployed Lambda and
frontend bytes and the actual ECR image, followed by a fresh-run tool check.
The local image ID is not a claim that the eventual registry image is identical.
No deployment, cloud mutation, previous-workspace fault or NE-04 work was
performed during this local qualification.

### NE-03 deployed-byte and installed-image verification — 2026-11-03

The user completed the guarded deployment of
`558f552c59cf0c75cd0307129f2aaba2c365ac95` on
`feat/native-aidlc-execution`. Its terminal receipts record infrastructure and
frontend completion at **12:16:58 UTC**. Independent verification used the
`solution-read` role in account `746558295630`, region `us-east-1`; the deployment
receipt alone was not treated as a pass.

All **nine native Lambda packages** match independently rebuilt candidate
bundles, including cancellation's execution-worker bundle. Service ZIP
checksums agree, functions are active, and their updates succeeded. All **five
authority aliases** select the matching published authority version without
weighted routing. All **523 frontend files** match a separate build from the
candidate, and the deployment's CloudFront invalidation is complete.

ECR tag `a8baca084128c883` resolves to
`sha256:a0d0eb04dfa2cad5f0d1ad0363d610369f732127f0143ca05ec03b73dbe26200`.
Every deployed native image URI/digest pin agrees. This registry image differs
from the earlier local qualification image, so its own installed checks were
run with fresh, verified AI-DLC **2.11.1**, OpenCode dependency and Linux binding
fixtures. The **155 Linux regressions** and existing **Claude Code 2.1.296**,
**Codex 0.162.1** and **OpenCode 1.19.0** installed scopes pass. Each of four
container checks verifies all **268 packaged production source files**; the
four removed private recovery modules are absent. Kiro remains **NOT RUN**
under NE-18. These network-disabled fixtures retain the scope limits described
above, including OpenCode's unexercised reconciliation/dependency-build branches.

The deployed runtime boundary and execution-worker policy have exactly the
expected S3 resources for public publications, pinned packages and cancellation
fences; neither grants access to private recovery bytes. The worker has only its
expected managed VPC execution policy. The preserved Terraform plan has no
S3, DynamoDB or EFS resource deletions; its replacement actions concern image,
local packaging and Terraform coordination resources.

Read-only comparison preserves **348 immutable records** across the earlier
active-tool, missing-workspace and wrong-workspace fixtures, along with all
**10 saved response rows**. Their configuration hashes, attempt/session/writer
identities, turn numbers and publication pointers remain unchanged. The only
changed baseline records are mutable execution pointers whose recorded
version/timestamp updates predate this deployment. This is historical-data
preservation evidence, not a compatibility guarantee for earlier native runs.

**Fresh application run: NOT RUN.** The dev application tab is open, but Chrome
rejects browser execution because **Allow JavaScript from Apple Events** is
disabled. The user has been asked to enable that access or perform the
application check. No fresh intent, model turn, workflow answer, recovery
confirmation or operator fault has been submitted in this verification stage.
Once browser access is available, use one fresh, minimal native intent to
verify the new run's image/EFS pins and actual result admission, member delivery
and export. Keep generated content opaque and preserve genuine human gates.
No repeated deployment or workspace fault is needed.

Exact read-only comparisons, the fresh image qualification, preserved-history
checks, initial browser-access failure and source hashes are under
`.native-evidence/ne03-2026-11-03-deployed-558f552c/`. The registry/package/IAM
checks do not claim a live model or new AgentCore/EFS execution. No production
implementation changed during verification, and NE-04 has not started.

### NE-03 fresh application check and worker connection repair — 2026-11-03

After browser access was enabled, one fresh Claude intent,
`0c886f19-89da-4c1c-927a-b48bed4a634b`, was created and prepared through the
application. Start returned **202** at **13:15:28 UTC**, with request
`bf48b75e-1fcb-49f7-bcb9-35d2713269d7`. The fixture requests one small Markdown
document and explicitly excludes application implementation, builds, playability
and output-quality checks. No workflow answer, recovery confirmation, repeated
Start or operator fault was submitted.

The new execution has attempt `34b956ba-fbbe-4d6c-8cfc-93954acd0314`,
epoch/writer/turn **1**, and configuration hash
`473bde9a4ccce2b0c64f8b70ea13a57f019ae7d49c465abff4394d6abaa1c3f3`.
Twelve independent read-only checks pass for its pinned image, execution endpoint,
role, EFS mount/access point, environment and permissions. It uses the verified
registry image above and `efs-workspace-v1`; its schema-3 fence has no private
checkpoint. The runtime installed AI-DLC **2.11.1**, launched Claude and uploaded
the turn's **24-file, 53,294-byte** public result at **13:21:44 UTC**.

The exact public manifest and every referenced file version pass the production
publication reader's identity, length and hash verification. Its manifest also
references the preserved one-file source baseline, which independently passes.
These initial **29 immutable object reads** established uploaded bytes separately
from authority admission. No generated file was interpreted or executed.
Previous **348 immutable records** and **10 saved response rows** remain unchanged.
Unauthenticated reads of the new intent and publication both return **401**;
additional member-role combinations were not exercised.

**Fresh application delivery: PASS after delayed reconciliation.** Scoped worker
diagnostics first recorded **`EBUSY` at `authority-read`** while the authority
remained `RUNNING` and the browser showed harness setup. An ordinary retry
observed `publication_ready` and completed authority admission at
**13:30:00.938 UTC**, about eight minutes after the upload. This happened with
the original deployed bytes, before any repair deployment, without another
Start, operator action or response replay.

The exact publication is now admitted with its separately verified immutable
interaction. The browser displays `AWAITING_USER`, all three AI-DLC plan choices
and free text, and the same proposal in history. Its first human gate remains
unanswered. Publication `STOPPED` metadata is not treated as workflow completion.
The member-created result archive downloads successfully and contains all
**24** published files plus the platform provenance manifest; every file's bytes,
length and hash match. Individual-file delivery is checked against the same
publication. Signed download capabilities are used without AWS credentials and
are not retained. The first create/prepare observations use UI, resource timing
and authority records; detailed page-context network capture began before Start.

The worker entry point created a new set of SDK clients on every Lambda
invocation. A real SDK transport probe against a loopback authority endpoint
reproduces **64 open connections after 64 warm polls**. The repair retains the
worker and its SDK connection pools for the warm Lambda lifetime while execution
state, authorization, supervisor and graph connection remain scoped to each
queued record. Both execution and cancellation probes now use **one connection
across 64 distinct identities**, without failures or identity leakage. All
**1,374 native controller tests** pass. Lint, formatting, scoped secret checks,
all **409** native architecture modules, local documentation links and the docs
build also pass. This establishes a connection accumulation defect and its local
repair; attributing the observed deployed `EBUSY` failures to that defect still
requires deployment and live confirmation. The successful retry does not prove
the repair or erase the observed delivery delay.

Independent packaging compares all nine native functions with deployed
`558f552c`: only the execution and cancellation bundles change. All **268 runtime
image inputs** retain their existing hashes and produce ECR tag
`a8baca084128c883`; frontend, runtime, shared source, dependencies and Terraform
are unchanged. The repair therefore needs the ordinary controller deployment,
without rebuilding the runtime image or publishing the frontend. The guarded
user-executed handoff is
`.native-evidence/ne03-2026-11-03-fresh-run/handoff/deploy-worker-connections.sh`.
It pins the reviewed commit, source/configuration/evidence hashes, account and
profile, and preserves a new deployment plan and receipts.

At the end of this fresh-run stage, the repair was local and undeployed. The
operator handoff required comparison of actual packages and image pins, then
inspection of this exact execution and retained publication before deciding
whether further tool-only observation was necessary.
Do not answer its human gate, replay a saved response, redrive a queue manually
or repeat a workspace fault. Evidence is under
`.native-evidence/ne03-2026-11-03-fresh-run/`. The selected Claude fresh-run
contracts pass; the worker repair's deployed behavior remains unverified.
Generated-output quality remains outside the verdict; NE-04 has not started.

### NE-03 worker deployment and preserved-result verification — 2026-11-03

The operator's deployment receipt records
`aeb031f43e9e126c7137d07d09fb068523d63c9e` finished at **13:54:13 UTC**.
Independent read-only inspection confirms that all **nine** deployed native
Lambda packages match the candidate's pinned bundle entries and service
checksums. All functions are active with successful updates; the five authority
aliases point to verified version **20**, without weighted routing. Only the
execution and cancellation program bundles differ from deployed `558f552c`;
the inspected function configuration is unchanged.

The existing ECR tag **`a8baca084128c883`** still resolves to
**`sha256:a0d0eb04dfa2cad5f0d1ad0363d610369f732127f0143ca05ec03b73dbe26200`**.
Every function image pin and the existing execution endpoint agree. All **523**
served frontend files still match the independently built baseline. The runtime
and frontend source inputs are unchanged, so no image build, installed-image
requalification or frontend deployment was repeated. The tightened IAM policies
and all **12** existing runtime/image/EFS/role checks pass.

The preserved fixture remains **AWAITING_USER** with its original attempt,
writer, epoch, turn, runtime/CLI session, configuration, publication and
interaction. The production readers verify the same immutable manifest, all
**24** file versions, source baseline and interaction. Its **31** authority keys
are unchanged; all **30** non-execution rows match exactly, including both ready
export records and all **25** immutable history rows. The only changed baseline
row is the mutable execution pointer, whose observed version/timestamp update
predates deployment at **13:36:58 UTC**. No row or fence change occurred during
the browser inspection. The browser's authenticated read returns **200** with
the same publication and interaction; it still renders the original three
choices and free text, with the human gate unanswered. The earlier **348**
immutable records and **10** saved response rows also remain unchanged.

Scoped execution/cancellation-worker and runtime log reads cover
**13:54:13–14:00:28 UTC** after deployment. They contain **zero scoped events**,
including no observed `EBUSY` recurrence. This is a quiet observation window
while the fixture awaits a human reply; it provides neither a live warm-connection
probe nor causal proof for the earlier delivery delay. The successful delivery
before this deployment and the local connection regression remain separate
evidence. No new workflow progress is needed to repeat NE-03's passed tool
contracts.

The requested deployment and preservation checks pass. Evidence and exact
observation limits are under
`.native-evidence/ne03-2026-11-03-deployed-aeb031f4/`. This stage changes
documentation only. No Start, answer, runtime invocation, recovery, queue
redrive, workspace fault or cloud mutation was performed by the verifier.
Generated-output quality remains outside the verdict. No operator action is
required for these checks; **NE-04 has not started**. Kiro remains deferred to
NE-18.

### NE-04 runtime turn ownership — 2026-11-03

Start, reply and EFS resume now create the same explicit turn context after
validating their admission. Preparation, harness execution, public publication,
status persistence, cancellation and activity callbacks receive that context.
The writer retains its identity/configuration/directory pins, installed package,
activity log and terminal cancellation latch. Each turn owns its admitted
payload, report, task, activity handle and continuation input. Completing a turn
releases its payload and transient references; only its public report and the
minimal verified CLI continuation evidence remain.

There is one current-turn pointer and one admission latch. The separate mutable
task, executing flag, owner-directory variable and full copied publication head
are removed. A reply uses the completed report's exact receipt/interaction and
the frozen continuation evidence. The runtime stays busy until the task finishes
status persistence and activity teardown. Start copies its input before the
first asynchronous inspection, and delayed output/diagnostic callbacks retain
their originating turn rather than modifying a later one. `settle()` likewise
waits for and returns the turn it observed.

`native/turn-interaction.js` now owns workflow gate/wait recognition, the bounded
pending-question reader, structured/degraded form decoding and its credential
checks. The executor coordinates these results without implementing their
formats. Supported formats, fallback behavior and wire decoding are unchanged;
NE-07's adapter simplification is separate. Public schema-2 commands, durable
owner/request/status records, exact publication and interaction receipts,
writer fencing, fresh-session EFS checks and retained answers remain intact.
All entrypoints schedule preparation only after durable admission, and the
final cancellation fence still has no asynchronous gap before model spawn.

Local validation uses Node **24.21.0**:

| Check                                                                           | Result                                                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Focused executor, preparation, pending question, runtime HTTP and output suites | **248 passed**, including 7 new regression cases                                               |
| Full AgentCore and native controller suites                                     | **4,418 passed, 8 skipped** across 152 passing files and 1 skipped file                        |
| Previous-executor comparison in an isolated source copy                         | All 3 selected new regressions fail as expected against `c420d1f1`; they pass on the candidate |
| Packaging/qualification and architecture script regressions                     | **28 passed**                                                                                  |
| Native architecture                                                             | **410 production modules, 0 violations**                                                       |
| Lint, formatting, scoped secret checks, dependencies and SDK alignment          | **Passed**; existing repository lint/dependency and Smithy-range warnings remain               |

The new tests cover request mutation during admission, late callbacks crossing
turns, busy status during durable publication persistence, cancellation during
reply preparation/file publication/interaction publication, and cancellation
during fresh-session preparation with preserved workspace bytes and predecessor
status. The existing real local subprocess, HTTP, cancellation/fencing,
duplicate/lost-acknowledgement, history and export tests remain covered. Skipped
tests are not counted as proof. Evidence is under
`.native-evidence/ne04-2026-11-03-turn-ownership/`.

This implementation changes runtime JavaScript and its tests. Frontend and
controller source, public protocols, IAM and dependency versions are unchanged. A new runtime
image is required before deployed NE-04 behavior can be claimed; the previously
verified `aeb031f4` deployment and image remain NE-03 evidence. Image qualification
and deployment observations must be recorded separately. No cloud mutation,
workflow answer, repeated fault or generated-application quality check is part
of this implementation. NE-05 has not started; Kiro remains deferred to NE-18.

### NE-04 packaged runtime validation — 2026-11-03

Implementation commit `ca0db8f8dcfc4464f7c6e7850732b60b952052c1` was built from
a tracked-source archive into the immutable local ARM64 image
`sha256:f32b9a1f3b11947e7c60378d61bbba8d2262f4dfceed228e843335adf8d320e8`.
The image retains Node **24.19.0** and the existing dev interaction-probe build
argument. Its runtime entry points and separate interaction decoder import
successfully. All **269 packaged production files** match the committed
candidate before each of the four qualification containers; production source
is read from the image, with no source overlay.

The installed runner passed **162 Linux regressions** across four files and
the existing installed scopes for **Claude Code 2.1.296**, **Codex 0.162.1** and
**OpenCode 1.19.0**. Each CLI passed failure/incomplete-output, descendant
cancellation, login-shell dispatch and the EFS fresh-session transport fixture.
The qualified transport fixtures admitted 11, 10 and 7 publications respectively.
This does not expand their existing coverage: the OpenCode fixture does not
exercise dependency rebuild or the reconciliation-question branch. **Kiro was
not run**, as defined by NE-18.

These checks use disabled networking, deterministic local providers, disposable
Linux workspaces, the actual packaged runtime and separate controller adapters
with in-memory AWS ports. They verify tool contracts, not generated-application
quality, AWS EFS, deployed IAM, real-provider behavior or browser behavior. The
reused attested **AI-DLC 2.11.1**, locked Linux binding and **32** cached dependency
packages were reverified. The prior **145 NE-02** and **65 NE-03** sealed evidence
files remain unchanged. Source/image identity, commands, logs, comparison
results and exact boundaries are recorded in
`.native-evidence/ne04-2026-11-03-turn-ownership/`.

**At this stage, NE-04 was complete locally and in the installed image; deployment
was pending.** The following section records the subsequent deployed verification.
The runtime source fingerprint produces Terraform image tag **`0a7e090fc869ab30`**.
Deploy the new runtime image and ordinary Terraform image-pin/configuration
updates together; frontend/controller source and IAM are unchanged.
The user-executed handoff is `handoff/run-ne04-deploy.sh` in this stage's evidence
directory. Its local check mode and rejection/syntax checks pass **14 checks**.
It verifies the final branch/commit, clean tracked tree, full runtime source
file set, image, qualification and configuration hashes; uses the existing
`solution` dev profile; and preserves a new plan with `--skip-seed`. No frontend
deployment, workflow answer or repeated workspace fault is needed. A deployment
receipt still requires independent verification of the registry image, deployed
pins and preserved state; the local image ID alone does not prove registry bytes.

### NE-04 deployed image and preservation verification — 2026-11-04

The operator deployed `5e5ad76caf85ad4d82504d3a8008fe4cd67b6e4f`, finishing at
**08:17:29 UTC**. Independent read-only verification confirmed image tag
**`0a7e090fc869ab30`** at registry digest
`sha256:32fc8539bf72d2dfba07c2ba352c12d8f9b7d3470a34fff35b1e822acbcbb33d`.
This is the deployed build's identity, distinct from the earlier local image.
The registry manifest hash and local immutable image identity agree. All
**269 packaged production files** match the committed candidate in each of four
qualification containers. The actual registry image passed **162 Linux tests**
and the existing installed Claude Code **2.1.296**, Codex **0.162.1** and OpenCode
**1.19.0** scopes. These remain offline tool checks with deterministic providers
and in-memory AWS ports; they do not claim a new live workflow or model turn.

All **nine native Lambda packages** match the candidate's unchanged controller
bytes. All five authority aliases select verified version **21**, including its
image configuration. All **33 image pins across 12 Lambda consumers** match the
new digest. The shared AgentCore runtime is **READY** at version **142** with
that image. The **523 frontend files** remain unchanged. The native permission
boundary, public publication grants, and the existing execution's runtime,
EFS access point and role pins also pass their scoped checks.

Intent `0c886f19-89da-4c1c-927a-b48bed4a634b` remains `AWAITING_USER` with its
original attempt, writer, configuration and image. Its original image remains
available in the registry. All **31 authority records**, including **25 immutable
history records** and **two ready export records**, are unchanged. Production
readers verified the original publication's **24 files**, source receipt and
interaction. The earlier **348 immutable records and 10 saved responses** also
remain unchanged. No answer was submitted or replayed.

The existing browser tab initially displayed an access-unavailable state.
Its ordinary **Refresh status** control restored the same publication and
unanswered question. All **19 captured scoped GETs** returned **200**; the
original three choices, free-text alternative and disabled submission button
remain visible. Capture cleanup completed without pending requests or errors,
and a second authority read confirmed no state changes during inspection.

**NE-04 deployment and preservation verification is complete. No operator action
is required.** The verifier performed no deployment, new Start, runtime
invocation, queue redrive or workspace fault. Generated-output quality remains
outside the verdict; Kiro remains deferred to NE-18. The prior **282 sealed
evidence files** remain unchanged. Commands, registry identity, installed checks,
deployed pins and browser/authority receipts are recorded under
`.native-evidence/ne04-2026-11-04-deployed-5e5ad76c/`.
NE-05 had not started at that verification boundary.

### NE-05 controller observations and projection ownership — 2026-11-04

Implementation `4f82d70161999943a090983901fff878a185404e` on
`feat/native-aidlc-execution` separates observation failures from execution
decisions under the existing authority. Unreadable responses cannot establish
that the writer was lost. The observer now returns explicit outcomes:

| Observation                              | Controller behavior                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unreadable runtime status                | Recheck authority and retry status for the same execution. A structured owner rejection or a verified conflicting report still requires recovery.                                                                                                      |
| Uncertain Start or reply acknowledgement | Retain the durable dispatch marker and accepted answer. Read status before another decision; never resend the attempted model command.                                                                                                                 |
| Pending or unavailable activity catch-up | Keep activity separate from the successful status observation. Acknowledge only persisted cursors and wait for terminal closure before admitting publication. A cold journal that positively reports missing closure still requires explicit recovery. |
| Lost execution ownership                 | Return `ownership_lost` and leave a wakeup for the current authority. Do not adopt another lease, repeat cancellation cleanup or commit a stale publication/activity batch.                                                                            |
| Unavailable authority                    | Return `authority_unavailable`, retaining the existing lease and delivery marker until authority can be read and claimed again.                                                                                                                        |
| Pending graph projection                 | Claim and acknowledge the independent `PROJECTION` row. Pending graph work cannot make a waiting or stopped execution runnable.                                                                                                                        |

These outcomes and allowlisted diagnostics belong to the controller; public
execution states and member request shapes are unchanged. The obsolete
execution `projected()` mutation is deleted. Projection fixtures now use the
actual projection owner, including takeover, cancellation, lost acknowledgement
and concurrent reply cases. Projection writes condition on their own version,
lease and source binding; an ambiguous acknowledgement succeeds only for the
exact committed progress record. Public publication history can still project
after cancellation while current membership and source authorization hold.
Stored publication metadata and existing public-history projection readers
remain separate from dispatch authority.

Local validation passes **1,404 controller tests** and **3,044 AgentCore tests
with 8 skipped**. The controller run includes the new **DynamoDB Local**
projection/accepted-answer race, existing graph integration, SDK/HTTP observation,
EFS recovery, member gates, publication, history and export coverage. Seven
new uncertainty cases failed against the original controller and now pass.
The broader run also identified one remaining test expecting a thrown lease-loss
error; it now checks the explicit outcome, and the entire controller project
passes again. **12 packaging/deployment and architecture regressions**, lint,
formatting, scoped secret checks, dependency/SDK checks, the architecture check
and documentation build pass. Commit hooks retain their existing advisory
dependency-audit findings; dependencies were not changed.

All **nine** controller packages build from **104** source inputs. Compared with
the verified NE-04 deployment, bundle bytes change for **authority, execution,
cancellation and credentials**. The other five packages remain byte-identical.
The **269 runtime source files**, Terraform image tag `0a7e090fc869ab30`,
frontend, infrastructure and deployment inputs are unchanged. The image baseline
is the previously verified registry digest
`sha256:32fc8539bf72d2dfba07c2ba352c12d8f9b7d3470a34fff35b1e822acbcbb33d`;
no new installed-image qualification is claimed. The prior **95 sealed NE-04
evidence files**, **329 committed source references** and **18 external
references** verify unchanged.

**NE-05 is complete locally; controller deployment and independent deployed
verification remain pending.** The operator handoff pins the reviewed checkout,
commit, bundle inputs and validation, preserves a fresh Terraform plan and
refuses a repeated attempt. Its command is:

```bash
bash /Users/jwthewes/development/sample-collaborative-ai-dlc/.native-evidence/ne05-2026-11-04-controller-transitions/handoff/deploy-controller.sh
```

The handoff uses profile `solution` for the dev deployment. It does not require
a frontend deployment, runtime-image change or another workspace fault. After
the operator reports completion, verify deployed controller bytes and aliases,
existing image pins, scoped diagnostics and the preserved publication/history/
unanswered gate. This local stage performs no cloud mutation or fresh live flow
and makes no new deployed/browser claim. Generated-output quality remains outside
the verdict; Kiro remains deferred to NE-18, and NE-06 has not started.
Evidence and exact validation commands are under
`.native-evidence/ne05-2026-11-04-controller-transitions/`.

## Integration and simplification checklist

This is the single work list for completing the serial native feature. Each item
includes its completion condition. Existing capabilities are described above;
only their remaining integration, simplification or qualification appears here.
Work starts with the EFS path and removal of obsolete recovery support, then
closes the product journey and release acceptance. No item requires compatibility
with previous native development executions.

- [x] **NE-01 — Define the release support contract.** Name the supported packages,
      harness/model combinations, application providers, inputs and settings for
      the serial journey. Select one complete combination for the first end-to-end
      acceptance, then qualify every combination advertised for release. **Done
      when:** creation, configuration and documentation agree on what is supported;
      optional and advanced features have an explicit scope rather than an open-ended
      prerequisite for release. **Completed 2026-10-26:** the selected contract above
      records all four harnesses, all three application providers, required attachment
      and tracker inputs, and the first acceptance path. Creation and configuration
      share the same notice about current support and release requirements. The 206 focused creation,
      configuration and Intent tests, frontend build, lint, formatting and secret
      checks pass. Deployed qualification remains open in the items below.
- [x] **NE-02 — Prove EFS resume through the actual application.** Deploy the matching
      runtime, recovery API, worker and UI corrections and exercise browser → public REST API →
      authority → worker → runtime. Cover waiting-session expiry after workflow creation and an interrupted
      tool, confirmed predecessor stop, member confirmation, the same EFS workspace,
      a fresh CLI session, unfinished edits, dependency links, real command results
      and the next real workflow question. **Done when:** result data is admitted,
      stored and exposed through the application with correct identity and access,
      without private recovery operations or automatic answer replay; intake,
      unavailable workflow state, and a missing or wrong workspace block resume visibly.
      Generated-application correctness, independent test/build qualification and
      playability are outside this verdict. **Completed 2026-11-03:** the dated tool
      proof above records the actual member recovery, fenced predecessor, retained
      EFS edits/dependencies, new CLI, admitted publication, real next question and
      preserved answers without replay. The earlier waiting, intake and isolated
      missing/wrong-workspace proofs remain preserved; generated-output quality
      is explicitly excluded.
- [x] **NE-03 — Delete the exact native snapshot/restore stack.** After NE-02, remove
      private CLI checkpoint capture, export/import, upload/download and exact
      filesystem/database restore; remove legacy native commands, mode fallbacks,
      decoders, compatibility manifests/branches and obsolete qualification
      fixtures. Remove native-only private-checkpoint permissions and packaging
      dependencies that no longer have a caller. Do not refactor the old restore
      planner or build a migration path for development runs. **Done when:** one
      EFS recovery path remains, no runtime turn depends on a private snapshot,
      publication/history/export still work, and shared platform behavior is intact.
      **Completed 2026-11-03:** the implementation and validation record
      above remove the private stack and its exclusive callers/permissions; the
      full backend/frontend, isolated release, packaging and Terraform checks pass.
      The subsequent packaged-image qualification passes 155 Linux regressions
      and the existing Claude/Codex/OpenCode installed scopes. Coordinated deployment
      of `558f552c` is independently verified, including the actual registry image's
      installed checks, tightened IAM and frontend bytes. The fresh Claude
      application run verifies Start, runtime/EFS pins, immutable admission,
      unanswered human-gate delivery, history and export. The subsequent worker
      connection repair `aeb031f4` is independently verified as deployed, with
      the same image/frontend and preserved publication/history/answers. Its
      scoped post-deployment window is quiet; live warm-connection behavior and
      causality for the earlier observation delay are not claimed. NE-02's
      deployed bytes are not reused as proof of this change.
- [x] **NE-04 — Simplify runtime turn ownership.** Give preparation, harness execution,
      publication and cancellation an explicit per-turn context. Separate interaction
      decoding from execution coordination and remove state made redundant by
      NE-03. **Done when:** start, reply and resume use the same clear phase
      boundaries without duplicated mutable state; cancellation and durable
      acceptance-before-spawn remain covered.
      **Completed locally and in the installed image 2026-11-03:** one explicit
      turn context owns all three entrypoints; interaction decoding is separate,
      duplicated mutable state is removed, 4,418 host tests and 162 packaged Linux
      regressions pass, and the installed Claude/Codex/OpenCode scopes pass.
      **Deployment and preservation verified 2026-11-04:** the actual registry
      image passes the installed scopes, deployed image pins match, and the
      original publication, history and unanswered gate remain intact. The
      record above distinguishes installed checks from deployed and browser
      observations. Generated-output quality is outside the verdict.
- [x] **NE-05 — Simplify controller transitions and observation failures.** Make status
      reads, activity catch-up, lost ownership and uncertain dispatch produce explicit
      outcomes under the existing execution authority. Remove the obsolete execution
      `projected()` mutation and move its fixtures to the actual projection owner.
      **Done when:** transient reads cannot cause replay or unnecessary recovery,
      stale workers cannot commit, and projection remains independent of dispatch.
      **Completed locally 2026-11-04:** explicit observation and ownership outcomes
      retain dispatch and answer authority; activity catch-up is separate, and
      projection uses its own fenced progress row. The obsolete execution mutation
      is removed and its fixtures use the actual owner. The 4,448 passing host
      tests (8 skipped), DynamoDB Local integration and packaging/static checks
      are recorded above. Controller deployment and deployed preservation checks
      are pending; the existing runtime image and frontend require no change.
- [ ] **NE-06 — Consolidate the public command contract.** Replace concentrated route
      classification with simple route definitions and align frontend requests,
      API validation and runtime command shapes. Keep validation at each trust
      boundary. **Done when:** tests send real frontend-shaped Start, reply, cancel
      and resume requests through the public router, including invalid fields,
      access denial, duplicates and lost responses; no retired native protocol is
      needed to pass them.
- [ ] **NE-07 — Simplify harness output and workflow question adapters.** Select a
      decoder for each harness and a supported methodology interaction contract.
      Remove obsolete parser state and question-format fallbacks; keep AI-DLC as
      the owner of stages, plans and gates. **Done when:** current-step grouped
      questions, scope/compose offers, approval and written replies render exact
      choices for every supported combination, with explicit degraded behavior
      for unsupported output and no wrapper-created workflow engine.
- [ ] **NE-08 — Complete normal intent creation.** Integrate native into the normal
      **New intent** entry, including the backend/default choice, verified package
      selection and application source. Reuse the shared creation and configuration
      components and remove obsolete pilot instructions. **Done when:** a member can
      create, correct and start a native request without discovering a separate
      settings-only path, and competing or uncertain requests keep one identity.
- [ ] **NE-09 — Integrate supported inputs, settings and tools.** Implement the selected
      attachment and tracker-import scope and source selection; capture the inputs and
      effective configuration at Start. Connect supported environment/tool settings
      through their existing owners, and explain intentionally unsupported settings
      consistently. **Done when:** displayed options match actual runtime behavior,
      later edits cannot retarget admitted work, and attachment/source credentials
      and access checks follow the existing platform boundaries. **Selected scope:**
      attachments and tracker imports are required; platform-managed environments,
      custom MCP server selections and uploaded custom rules are excluded from the
      initial release.
- [ ] **NE-10 — Align public file handling and usable results.** Resolve the mismatch
      for credential-shaped files such as `.env` and `.npmrc`, retaining safe templates
      without exposing secrets. Use one explicit public-file policy across capture,
      admission, file views, comparisons, graph extraction and downloads. **Done
      when:** text/binary/empty files and exclusions behave consistently, public
      archives remain obtainable after runtime stop, and a download clearly states
      which workspace content it contains.
- [ ] **NE-11 — Implement verified workflow completion.** Connect evidence of the
      pinned effective plan, applied human decisions and required checks/reviews to
      the exact final result. Resolve the methodology/isolation dependency instead
      of treating mutable harness files or prose as independent approval evidence.
      **Done when:** the UI can report complete, failed or not verified from actual
      outcomes; stopped turns and accepted selections cannot imply success. Follow
      the workflow's own gates without adding blanket final approval.
- [ ] **NE-12 — Implement native Git delivery and tracker policy.** Admit a complete
      Git tree or an exact change set against the pinned source, including modes,
      deletions and excluded-entry rules. Use existing provider/credential owners
      for authorized delivery, stable commit/branch/PR identities and reconciliation
      after lost acknowledgements. Define who publishes, draft/ready behavior,
      review/merge observation and tracker updates. **Done when:** a member can
      deliver the reviewed result and see its confirmed remote identity/status;
      provider failures cannot retarget results, replay an uncertain write or
      block unrelated history access.
- [ ] **NE-13 — Finish shared history, status and traceability integration.** Reuse
      the implemented revision history, decision records, comparisons and graph
      links throughout the shared Intent shell and project/dashboard/sidebar views.
      Keep question/recovery actions prominent and apply native capability guards
      to platform actions. **Done when:** two members can reopen the same revision,
      inspect its decisions and files, navigate from graph items to exact sources,
      and see consistent status without mistaking a stopped turn for completion.
- [ ] **NE-14 — Simplify frontend reads and state acceptance.** Coalesce overlapping
      detail loads and reuse revision/access/session checks. Remove per-item
      discovery detail reads where a protected execution summary or shared request
      can supply the same state. **Done when:** navigation, refresh and polling
      avoid duplicate requests while preserving shared drafts, uncertain submissions,
      current status and isolation across account/project/intent changes.
- [ ] **NE-15 — Reduce activity notification work and complete observability.** Send
      one high-watermark invalidation per committed output batch, retaining durable
      cursor replay and polling. Show acceptance, dispatch, useful output, waiting,
      publication, reviewer/advisory outcomes and recovery failures with honest
      usage/timing attribution. **Done when:** multi-page reconnect, missed hints,
      backpressure and partial reads retain complete accessible history, and normal
      diagnosis does not require private transcripts.
- [ ] **NE-16 — Measure and reduce startup and post-turn latency.** Measure preparation,
      installation, acceptance-to-dispatch, first useful output, harness/tools time
      and publication-to-display separately. Reuse verified installed assets and
      remove duplicate verification/read work where the current trust boundary
      permits it. **Done when:** repeatable cold/warm measurements for the release
      combinations meet agreed responsiveness targets without skipping workflow
      steps, checks, required questions or publication integrity.
- [ ] **NE-17 — Complete cancellation, abandoned work and resource lifecycle.** Define
      archive/restore, replacement intent, space deletion, workspace retention and
      cleanup permissions. A replacement must use an explicit source and fresh
      authorization, with no automatic replay of earlier answers. **Done when:**
      users can stop, inspect, export and close abandoned work; stop confirmation,
      hiding an item and deleting data are distinct; cleanup releases only eligible
      resources and the documented EFS-loss behavior is clear.
- [ ] **NE-18 — Make local qualification exercise the supported product boundaries.**
      Consolidate the reusable runner around installed harnesses, current engine
      commands, public API requests and EFS resume. Remove legacy restore-only
      suites and fix fixture assumptions about paths, permissions and external
      prerequisites. Complete Kiro's instruction-channel, input and authentication
      qualification before removing its temporary native unavailability or claiming
      its full journey. All four harnesses remain release requirements.
      **Done when:** each advertised row reports repeatable pass/fail/blocked
      evidence; missing prerequisites cannot silently become cloud calls or a
      successful qualification, and scripted output is distinguished from a real
      installed workflow.
- [ ] **NE-19 — Qualify the complete two-member journey.** Run create → start → question
      → implementation → required checks/gates → verified completion → downloadable
      result and Git delivery with separate authenticated browser profiles. Include
      competing answers, change requests, historical discussions, Quorum failure/retry,
      reconnect, logout/login, account switching, token expiry and revocation.
      **Done when:** the deployed result and accepted decisions refer to the same
      revisions and users, stale callbacks cannot cross scopes, and advice never
      becomes an accepted answer.
- [ ] **NE-20 — Qualify deployed execution and storage boundaries.** Verify effective
      authority/worker permissions, cross-project runtime/EFS isolation, source
      access changes, image revocation, current-writer admission, publication/package
      overwrite/copy/delete restrictions and multipart/lifecycle behavior. Include
      positive controls, cancellation races and missing acknowledgements. **Done
      when:** the actual role and network paths enforce the contract on the release
      candidate, with no private restore permissions or compatibility paths needed.
- [ ] **NE-21 — Complete operational repair and rollout readiness.** Measure repair
      sweeps and revocation lookup at the intended history size and concurrency;
      exercise expired/lost notifications and queue recovery. Assign incident
      ownership and connect actionable alarms. Deploy matching contracts and verify
      admission shutdown without disabling current-run reads or cancellation.
      **Done when:** agreed repair and response bounds are demonstrated, failures
      reach the intended operator, and the release procedure preserves the selected
      EFS recovery model and existing platform functionality.
- [ ] **NE-22 — Publish the integrated feature and remove development-only scaffolding.**
      Confirm the preceding release items against the same candidate, remove unused
      native paths and obsolete compatibility/probe assets, and update capability
      declarations and architecture checks to the simplified implementation. Add
      this page to documentation navigation, remove its draft exclusion and update
      the linked creation/recovery/settings guides. **Done when:** published guidance
      matches the shipped behavior, supported combinations and recovery limits, and
      the work list accurately records completed release work and any explicitly
      deferred follow-ups.
