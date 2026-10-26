# AI-DLC Release Compatibility

This document describes how AI-DLC catalogs are imported, evaluated, selected,
and resolved at runtime. A release can only be promoted when every behavior it
authors has a runtime handler in this build; the admin tab lists any missing
handlers.

## Release contract

An AI-DLC release is identified by its source commit and importer revision. Its
catalog, source objects, compatibility report, and closure digest are stored as
immutable objects. The registry may add operator state such as visibility,
support state, notes, and channel membership, but it cannot change the bytes an
intent already pinned.

Release compatibility is based on the imported content and runtime handlers,
not version-string comparisons. A release can be importable and structurally
valid without being selectable. Importing a profile never publishes it to users
or changes an existing intent.

## Profile identity and trust

The built-in profiles are pinned to exact upstream commit SHAs. The allowlist
includes the current 2.3.3 baseline and the 2.6.18, 2.7.0, 2.8.2, 2.9.0, and
2.11.0 catalogs. No intermediate release is onboarded: 2.10.0 is not on the
allowlist and registering it is refused as an unknown profile. A custom fork receives a synthesized profile with its own source
identity; an unknown tag or branch is not treated as an official release.

All official profiles use the same source trust tier. Trust establishes whether
the imported source may run; it does not certify that the platform reproduces
every semantic in that source.

A custom fork names the official profile whose frontmatter dialect it uses (for
example `v2.9.0`); that base grants no trust. It is recorded `T0` and
import-only, and it may author its own stages, scopes, agents and sensors. It
becomes runnable only through the explicit admin promotion described under
[Registry, promotion, and channels](#registry-promotion-and-channels), which
applies the same fidelity guard as an official release.

## Immutable storage and import

The seed-blocks import mode fetches the profile's declared source closure,
normalizes known frontmatter dialects, maps blocks, and writes a content-addressed
release bundle to S3. The manifest records the source SHA, importer revision,
catalog digest, object digests, and compatibility evidence. Conditional writes
prevent an import from replacing existing bytes.

The importer revision includes a fingerprint of the block mapper. Mapper keys
and frontmatter normalization are defined for the supported profile set. A
mapping change alters the importer fingerprint and catalog goldens, so it
requires a new importer revision and closure upgrade. Runtime handlers may be
added for fields already recorded in a catalog without changing that catalog.

The 2.3.3 block digest and per-scope plan digests are compatibility contracts.
Optional mapper and plan properties are omitted when the source did not author
them, preserving byte identity for existing 2.3.3 runs.

## Release-aware resolution

When release pinning is enabled, an intent stores its release ID and closure
digest at creation. The runtime verifies the manifest and each object before
loading the pinned catalog. A pinned run therefore resolves from its own
immutable closure rather than from mutable system blocks or the newest upstream
catalog.

The `AIDLC_RELEASE_PINNING` deployment flag defaults to off. When off, new
intents follow the existing platform-default path and do not receive an
implicit release pin. The new-intent page only displays a version selector when
the API confirms that pinning is enabled. If the flag changes while the page is
open, a rejected pin is retried as an unpinned intent and the UI reports the
fallback.

When pinning is enabled but no stable channel is configured, intent creation may
still pin the deployment ref's release. The registry is consulted first: the
closure is pinned only if the matching registry record is registered, visible,
selectable or certified, and its authored behavior passes the runtime promotion
guard. If there is no such record, or it is not eligible, or it authors behavior
this build cannot honour, the intent is created on the existing unpinned path
without reading the manifest. The manifest is read only once a record exists,
because the runtime role has no `s3:ListBucket` and S3 answers a read of a
never-imported ref with 403 rather than 404.

The deployment ref's manifest is addressed by the running build's importer
revision. After an importer revision bump, an eligible record still describes
the previous revision until the release is re-imported and the record upgraded,
and a record whose closure does not match the published manifest is in the same
half-finished state. Both keep the intent unpinned with a
`release_registry_skew` warning instead of failing the create; the revision
check uses the record alone, so the missing new-revision manifest is never
read. An explicitly selected or stable-channel release is pinned by the
record's own importer revision and is not affected.

A configured stable channel is an implicit default and degrades the same way. If
a space has a user block edit the stable release cannot overlay, and the release
itself resolves cleanly without that overlay, the create continues as if no
channel were set instead of failing: it auto-pins the deployment ref's release
when that release can apply the overlay, and otherwise creates the intent
unpinned. An explicitly requested release is strict: it returns the
resolver errors so the caller sees which override conflicts.

A failure to complete that lookup is treated differently. A throttled registry
read, or a denied, missing or corrupt manifest or closure behind an eligible
registry record, means the answer
is unknown rather than "not published", so intent creation returns
`503 release_resolution_failed` and writes nothing. Downgrading an unreadable
manifest to "does not exist" would let a permissions regression silently unpin
every new intent.

Existing intents are not migrated or repinned. Release-aware compose reads use
the intent's stored pin, so reopening an intent does not silently change its
methodology version.

## Compatibility evidence and runtime support

The analyzer reports structural validity, dependency closure, sensor command
compatibility, mapped frontmatter values, and runtime-command fidelity. Each
authored value is classified as `native`, `approximated`, `unsupported`, or
`packaging-only`. The report includes the specific source values that the
current runtime does not honour.

The runtime supports the single-session stage mode, and the per-persona session
mode for pinned `pipeline`, `mob`, and `subagent`-with-supports stages whose
release closure ships `core/aidlc-common/protocols/stage-protocol-ensemble.md`.
It also supports the platform's always-restored workspace behavior. The mapper and analyzer know the complete
frontmatter vocabulary of all five profiles, but knowing a field is not the
same as executing its semantics. Other authored values remain `unsupported`
until the corresponding runtime handler is registered and implemented. This
distinction keeps newer imports inspectable without presenting them as
safe-to-run releases.

The gate handlers cover summary and plan-approval checkpoints, review policy,
both sensor planes, change control, learnings, skeleton selection,
`AGENT.maxTurns`, and the build-and-test loop-back. The persona runtime
dispatches `pipeline` and `mob` stages, and `subagent` stages that declare
supports, in separate serial sessions with role-scoped briefs. A `subagent`
stage gets separate sessions only when its release closure ships
`core/aidlc-common/protocols/stage-protocol-ensemble.md`; without that file a
`subagent` stage with a support stays a single delegated session, which is why
2.3.3 `reverse-engineering` is unchanged. `agent-team` remains unsupported
because it requires concurrent sessions.

The 2.3.3 baseline remains promotable. The 2.6.18, 2.7.0, 2.8.2, and 2.9.0
fixtures have runtime handlers for their authored persona modes and for the
build-and-test loop-back, so `PROTOCOL:build-and-test-loopback` is no longer
`unsupported` — the gap that made the release-promotion guard refuse them. Their
compatibility classification remains field-driven and reflects the supported
runtime semantics rather than profile-version exceptions.

Those fixtures carry no bodies, so they do not show one more condition. From
2.8.2 on, a release's prompts invoke the upstream engine CLI as
`{{INVOKE}} engine <command>`, and the guard reads those invocations out of the
published closure as `BODY:{{INVOKE}}` gaps. It reads them only from what
reaches a prompt: the bodies of the blocks a release library resolves (stages,
agents, sensors, rules, artifacts, knowledge, scopes) and the conductor. The
engine's own sources, hooks and protocols, and the SKILL and TEMPLATE bodies,
ship in the closure and quote engine commands too, but no prompt renders them,
so they are not read as gaps. The 2.6.18 and 2.7.0 prompts invoke no engine
command.

No engine binary exists here. The stage, persona and compose prompts neutralize
the token and append the engine-command annex, a closed list that tells the
agent, per command, what to do instead. A prompt carries the annex when a part
the release authors to INSTRUCT the agent carries the token: the stage body, the
conductor, the persona or the reference knowledge in a stage prompt; the persona
or the reference knowledge in a reviewer or ensemble brief; the composer persona
or its knowledge in the compose prompt. `lambda/shared/annex-reach.js` is the one
definition those builders and the promotion guard share. A command the annex
answers does not hold promotion when EVERY block whose body carries it is one of
those: bodies are content-addressed, so one object can be the body of several
blocks, and coverage for a stage is not coverage for a rule that shares the same
text.

| Command                                                                                                   | Handling               | What the platform does                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrate report`                                                                                      | unsupported, answered  | Records stage lifecycle itself from the turn ending.                                                                                                                                                                                                                                                                    |
| `recompose --add`, `state set-construction-iteration`, `state practices-event`, `state practices-promote` | unsupported, answered  | The agent records a recommendation for the human instead of performing the action.                                                                                                                                                                                                                                      |
| `graph ars`                                                                                               | unsupported, answered  | No composite is computed or shown. Upstream's score is advisory and nothing routes on it; the agent justifies each EXECUTE/SKIP with evidence and never presents a score.                                                                                                                                               |
| `gen scope-table`, `gen stage-table`                                                                      | approximated, answered | Read-only reporting the prompt already carries.                                                                                                                                                                                                                                                                         |
| `workspace detect`, `workspace codekb`, `workspace codekb-scope-diff`                                     | approximated, answered | Read-only reporting. The compose prompt carries the workspace signals the platform detected; a stage reads the compiled context and its working tree. No scope-diff identifier is minted.                                                                                                                               |
| `worktree`, `worktree create`, `worktree merge`, `worktree info`                                          | approximated, answered | A per-unit lane runs on a unit branch the platform creates from the intent branch and checks out before the stage; any other stage runs on the intent branch. The platform merges each unit branch into the intent branch with `--no-ff` after the unit, and the intent branch reaches `main` through its pull request. |
| `graph validate-grid`                                                                                     | approximated, answered | The plan resolver re-validates every compose proposal (strictly when in flight). Not reproduced: the validator summary, `nearest_stock`, the keyword collision check.                                                                                                                                                   |

Any other command, including other subcommands or flags of these families and a
family name on its own (`state`, `orchestrate --next`), gets only the annex's
catch-all (say it is unavailable, never improvise), which leaves the
authored step unperformed, so it still holds promotion. So does an answered
command — including an approximated one, whose platform substitute the agent
only learns from the annex — found in a body whose prompt carries no annex, such
as a rule or a scope. One such consumer is enough: the verdict is the same
whether that body is shared with a stage or authored separately. With these,
2.8.2 and 2.9.0 author nothing this build cannot honour and are promotable. The admin tab lists
exactly what a given import still holds on. A gap list stored by a build that
read other files is re-read from the closure the next time it is listed or
promoted.

`readyForCertification` is derived from the current compatibility report. It is
not a version allowlist, and the report's Boolean is not treated as durable
authorization by itself: the release-promotion guard stores the authored
fidelity gaps and reevaluates them against the handlers in the running build.

2.11.0 promotes exactly as 2.8.2 and 2.9.0 do: an admin may make it
`selectable`, and `certified` — and so eligible for the `stable` channel — if
they decide to. The engine commands below are answered, not reproduced, which is
the same situation 2.8.2 and 2.9.0 are already in; whether that is a claim worth
making is the administrator's call, taken with the table below in hand.

### AI-DLC 2.11.0: handled, approximated, refused

2.11.0 renames Change Control to **Guard Policy** (adding a third value, `off`)
and adds **Plan Approval**, **collaborators** and **`existing_code`** as scope
settings. All four are mapped by the importer, resolved onto the per-stage
policy, and choosable per intent by a project member before the run starts.
Guard Policy `off` means no change-control reopen; **it never removes a human
approval gate**, and that invariant is asserted for every 2.11 scope and stage.

| 2.11 behaviour                                               | Disposition                     | What the platform does                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guard Policy `strict` / `relaxed`                            | approximated                    | The existing change-control gate, unchanged.                                                                                                                                                                                                                                                                                                          |
| Guard Policy `off`                                           | approximated                    | No reopen and no change-control prose. Upstream's `off` also lowers execution fences this platform never had, and its per-fence `Guards Off`/`Guards On` overrides and kill-switch chain are **refused** — there is no per-fence surface.                                                                                                             |
| Plan Approval `on`                                           | approximated                    | The existing outcome-gate approximation.                                                                                                                                                                                                                                                                                                              |
| Plan Approval `off`                                          | approximated                    | No plan gate is offered and the completion ladder requires no plan receipt. The stage's own approval gate is untouched, and the gate carries a notice naming whose choice it was.                                                                                                                                                                     |
| collaborators `off`                                          | native                          | One session: the lead agent produces every declared output. Each withdrawn persona is named on the plan's policy effects.                                                                                                                                                                                                                             |
| collaborators `on`                                           | approximated                    | The existing per-persona blind sessions.                                                                                                                                                                                                                                                                                                              |
| `existing_code`                                              | approximated                    | Becomes the default project type, overridable by a human, and stated in the prompt. Mid-run reclassification is **refused** (see `orchestrate next`).                                                                                                                                                                                                 |
| `sensors`, `learnings`, `summary_confirmation`, `review_cap` | as before                       | Already mapped; only their 2.11 defaults changed. `review_cap` stays a scope ceiling and raising it per intent is refused.                                                                                                                                                                                                                            |
| The composer's settings proposal                             | handled                         | `guardPolicy`, the six `scopeSettings`, `baseScope` and `creationDepth` are parsed and kept; a member accepts them on the compose page and the provenance is recorded. A proposed `settingsChanges` (a change to work in flight) is refused by name.                                                                                                  |
| `engine audit append-raw`                                    | approximated                    | The note is bound to `emit_stage_note`. No upstream audit shard or taxonomy event is written, and the agent may not claim one was.                                                                                                                                                                                                                    |
| `engine config get`                                          | approximated                    | The effective settings and their source are rendered into the prompt. The annex forbids reading a settings, environment or shell file to find them.                                                                                                                                                                                                   |
| `engine now`                                                 | approximated                    | The platform's own event stamps are in the prompt; a timestamp it cannot supply is omitted and said to be unavailable, never fabricated.                                                                                                                                                                                                              |
| `engine config set`                                          | refused                         | Settings belong to the intent and only a human changes them, before the run starts; afterwards the API answers `settings_locked`. The agent records the request.                                                                                                                                                                                      |
| `engine log answer`, `engine log decision`                   | refused (protected checkpoints) | Ordinary questions and summary confirmations bind to `ask_question` / `confirm_summary` where the session has them; where the policy or checkpoint ownership withholds one, the annex says so and defers to the stage's own session. The plan-approval receipt and the approved verification command have no store here and are named as unavailable. |
| `engine orchestrate next`                                    | refused                         | No rescan, no Reverse Engineering re-insertion, no return to the interrupted stage. The agent records a `RECOMMENDED PROJECT TYPE CHANGE` and a human rewinds and recomposes.                                                                                                                                                                         |
| `engine state set-construction-execution`                    | refused                         | Construction scheduling is platform state; the agent records the intended value.                                                                                                                                                                                                                                                                      |
| `engine state set-construction-verification-command`         | refused                         | No approved-command store; the command is a recommendation, never executable authority.                                                                                                                                                                                                                                                               |
| `engine testing-posture restore`                             | refused                         | No approved-bundle restore; the agent says it is unavailable and names what was lost.                                                                                                                                                                                                                                                                 |
| `engine worktree list` / `discard` / `restore` / `purge`     | refused                         | No parked-attempt store. Lanes are branches the platform creates and merges; the agent parks, deletes, restores and purges nothing and never substitutes git.                                                                                                                                                                                         |
| `testing-posture fingerprint --reapprove`                    | retired upstream                | This platform never ran it, and no adapter here revives the retired route.                                                                                                                                                                                                                                                                            |
| `doctor`                                                     | refused                         | No source-boundary diagnostic runs here. The agent reports the failure through its own output and never emits `VALID`/`INVALID`.                                                                                                                                                                                                                      |
| `workspace codekb-scope-diff --check`                        | refused                         | No publication validator runs here. The missing prerequisite is named; no verdict is produced.                                                                                                                                                                                                                                                        |

Every name the guard honours carries a row in the annex, asserted verbatim by
test, and honouring a name requires proof that the answer REACHES the session
that receives the command. Two reaches are distinguished, because the answers
differ in what they need:

- A **refusal** that names a platform channel (record the request, put it in the
  findings) is honoured only where the session receiving the annex also owns
  that channel. A command instructed only from a reviewer's or a support
  persona's knowledge keeps holding promotion.
- An **approximation** whose answer the receiving session performs itself —
  omit an unavailable timestamp, read the settings out of the prompt, record a
  note — is honoured wherever a prompt carries the annex at all, which includes
  that reviewer and support knowledge. A body no prompt builder annexes, such as
  a persona, carries no answer for anyone: `engine now` moved into a persona
  body holds promotion with the command named, which is how a fork is kept from
  inheriting a reach claim the official bodies earned.

The checkpoint mapping is rendered for the session that receives it: tool
registration withholds `confirm_summary` where the policy asks for no summary
confirmation and withholds both checkpoint tools from a session that owns no
checkpoint, so the annex offers only what that session has and otherwise says
the checkpoint cannot be raised there and must be deferred to the stage's own
session.

2.11.0's sensors run as the release declares them, with one bounded
difference:

- **Document-sensor routing and script closures.** 2.11 authors its document
  sensors against an output path and splits their scripts across sibling
  modules. The runner spawns each script on the flag its input schema declares
  and writes the script's pinned import closure beside it before spawning, so
  the traceability, type-check, claim-sources and linter sensors analyse their
  input instead of failing at import. A closure or import the release store
  cannot read is a release-integrity failure: no script is launched and the
  stage is held.
- **Code-sensor budgets.** 2.11 authors 1,200 seconds for the code sensors. The
  runner honours an authored budget up to its 600-second ceiling and within the
  stage deadline, and records which of the two bounded the run, so a sensor cut
  at the ceiling is reported as such. This is the remaining difference: a code
  sensor that needs more than 600 seconds is cut shorter than the release asks.
- **The timestamp-heading exemption.** 2.11 widens its record sensors to the
  knowledge base and exempts a one-line timestamp record from the heading
  floor, and the runner honours that exemption for a catalog that authors it.
  Earlier releases do not, so such a record still reports two missing headings
  there.

What these green tests do **not** prove, stated so the support claim stays
bounded: real model behaviour under the truncated composer knowledge; live human
reply, approval, edit and restore flows; reviewer and support prompts in a real
run; a real ESLint or tsc subprocess in the container image; per-Unit checkpoints
and reopen with finished work retained; and production-equivalent dependency
packaging.

## Registry, promotion, and channels

Registration creates an invisible, structurally-valid record. It does not make
the release selectable. An administrator explicitly changes the support state
and visibility, and channel pointers refer only to eligible records.

Before a release becomes `selectable` or `certified`, the registry verifies the
immutable catalog and source objects, derives authored fidelity gaps, and
checks those values against the runtime capability registry. If any authored
value is still unsupported, the update fails with
`release_capability_unhandled` and returns the unhonoured values. The stable
channel retains its current-platform-baseline exception so the existing 2.3.3
baseline remains available. Other channel updates are subject to the same
runtime-relative guard.

The same guard applies when visibility is enabled for an already-selectable
release and when its closure is upgraded. Before trusting cached or legacy
evidence, the registry verifies the published manifest identity against the
registry row and re-reads bounded, digest-checked catalog objects. An upgrade
that adds behavior the running build cannot honor is refused before new intents
can select it.

A custom fork is promoted the same way. Registration records it `T0`,
import-only and invisible, with its fidelity gaps and the unhonoured subset on
the record. Promoting it to `selectable` or `certified` runs the guard above
over the fork's own closure: if every behavior it authors has a runtime handler,
the record becomes runnable and can then be made visible, pointed at by a
channel, and pinned by new intents; otherwise the promotion is refused with
`release_capability_unhandled` and the record stays import-only. Nothing else
makes a fork runnable, and a fork registered by an earlier build is in the same
state until it is promoted. A fork's intents pin a closure that names the fork,
and the runtime reads that closure only from the fork's own storage prefix; a
custom closure is never executed under an official pin. The runtime also reads
the fork's release record before it loads the closure and refuses the pin with
`release_not_runnable` unless the record is runnable, so a fork pin written by
hand or restored from a backup does not run a fork that was never promoted.

Promoting a fork is a trust decision. Earlier builds kept every fork
import-only until sandboxed execution and IAM isolation existed; this build lets
an admin promote one, and neither of those exists yet. A promoted fork's sensor
scripts, and the `command` each sensor declares (a `runtime: sh` command runs
through `sh -c`), run in the agent runtime with the runtime's own role and no
separate sandbox. That is how a user's script sensor runs too, but the blast
radius is wider: a user's sensor runs only in that user's intents, while a
promoted fork is offered to every project in the deployment. Only a platform
admin can promote a fork, the guard refuses a fork that authors behavior this
build has no handler for, and promotion is not revoked once granted. Promote
only a fork whose sources you would run as your own sensors in every project.

Because the registry reevaluates content evidence against the current handler
registry, adding a handler can make an existing import promotable without
changing its source bytes, importer revision, or closure digest. The registry
API exposes both the original fidelity gaps and the subset this build still
cannot honour; the admin screen explains a refused promotion.

### Enable pinning and promote a release

A deployment of this build can run 2.8.2, 2.9.0, 2.11.0 or an admin-promoted
fork as follows. Every step is explicit; none happens on its own.

1. Turn release pinning on. In the Terraform variables for the deployment, set
   `aidlc_release_pinning = "on"` and apply. The demo deployment workflow reads
   it from the optional `AIDLC_RELEASE_PINNING` GitHub environment variable.
2. Publish the release bytes with the seed-blocks `importRelease` mode, for an
   allowlisted profile or for a custom fork pinned to an exact SHA.
3. In the admin AI-DLC releases tab, register the published release. Check its
   unhonoured values: a release with any cannot be promoted, and the list says
   which behavior this build is missing.
4. Set its support state to `selectable` (or `certified`), then make it
   visible. Each step re-checks the release against this build.
5. Optionally point a channel at it. `stable` makes it the default for new
   intents; it requires `certified` unless the release is the platform baseline.

Existing intents keep the release they were created with. To stop offering a
release, follow [Roll back a channel](#roll-back-a-channel).

## Selection and rollback

With pinning enabled, the intent API resolves the selected release or the stable
channel and stamps that identity onto the intent. Non-admin callers receive only
the release fields needed for selection. The admin release page supports
registration, promotion, visibility changes, channel management, and closure
upgrade while preserving revision checks.

### Roll back a channel

To stop offering a newly promoted release, move the affected channel to a
previously eligible release or clear the channel through the release API. The
change affects future intent selection only; an existing intent continues to
use its stored release ID and closure digest. If the current release must no
longer be selectable, demote it after moving or clearing every channel that
points to it. Channel and release revisions are compare-and-swap guards; retry
with the latest revision if another administrator changed the record.

Do not delete a release closure to roll back selection. The immutable objects
are required by intents already pinned to that release. Keep the closure and
registry record available until those intents no longer need to resolve it.

## Execution gates and policy

The gate layer turns authored release policy into runtime checks. It is active
only for a verified release closure; an unpinned intent continues on the legacy
plan and prompt path.

### Checkpoints and receipts

`confirm_summary` and `request_plan_approval` are author-only MCP tools. Each
parks a human question with fixed answer choices and writes an attempt-scoped
`RECEIPT#` row when approved. Release-mode artifact writes are stamped with the
active authorization. A bounded completion ladder gives a non-compliant stage
one repair turn, then reports a gate finding or a rewind-eligible failure.

Receipts use the existing execution table and remain auditable without deleting
them. Checkpoint prompts use the existing `question` and `validation` gate kinds.

Plan Approval's runtime handler checks authorization at the completion boundary,
so it approximates the upstream pre-write guard rather than providing the same
guarantee. Promotion remains blocked until the current build registers the
outcome-gate handler; once available, stored and legacy records are re-evaluated
from their verified closures without re-import.

The completion ladder persists its per-attempt repair counter before it starts a
repair turn. If that write fails, the stage fails rewindably with the original
checkpoint finding; it does not run an uncounted repair or report success.

### Gate findings and sensors

The shared gate-precondition evaluator combines artifact, checkpoint, review,
and sensor findings and determines whether the gate blocks or allows an override.
The orchestrator presents findings at the validation gate; an allowed override
is recorded with a receipt and timeline event.

`fire_on: write` uses the post-agent changed-file sweep. `fire_on: gate` runs a
separate pass after reviewer repairs, against declared deliverables and their
final bytes. Blocking findings hold the gate when one exists; otherwise the
stage fails with a rewind-eligible reason.

### Scope policy

- `review_cap` lowers or removes reviewer strength; `review_class: advisory`
  runs one terminal review and carries findings to the gate.
- `change_control: relaxed` records changed approved inputs and continues.
  `strict` opens a two-choice question before the next stage proceeds.
  After reconfirmation, the stage does not spawn its CLI until the attempt-scoped
  `change-reconfirm` receipt is persisted. A failed write returns a rewindable
  `FAILED` state; an existing receipt for the same attempt is reused idempotently.
- `learnings: off` withholds the learning-write tools. `on` offers a learning
  question at an existing approval gate; this is an approximation of a separate
  upstream turn. The orchestrator sends the answer through AgentCore's
  `record-learning` command, registered by the HTTP dispatcher.
- `skeleton: off` skips the walking-skeleton ceremony while retaining the
  ordinary approval gate.
- `AGENT.maxTurns` maps to the native OpenCode turn limit; it remains inert on
  CLIs that expose no equivalent.

### Per-intent AI-DLC settings

A scope's Guard Policy, Plan Approval, collaborators and project type can be
overridden for ONE intent. The settings are ordinary draft selection state: they
travel in the same `PATCH /projects/{projectId}/intents/{intentId}` body as
`scope` and `composedGrid`, under the same draft-revision CAS, and are flushed by
the same barrier Start already awaits. There is no separate route and no second
write path.

- Only the settings the pinned release's chosen scope AUTHORS are offered
  (`plan.aidlcSettingsAuthored`). A release that authors none — unpinned, 2.3.3,
  2.8.2, 2.9.0 — offers nothing, stores nothing and resolves exactly the policy
  it resolved before.
- Only DELTAS from that scope's default are stored. A value equal to the default
  is not an override, so it is not persisted; the consequence is that an explicit
  choice which happens to equal the default is not retained across a later scope
  change, the same semantics `composedGrid` already has relative to `scope`.
- The settings are only ever validated against a selection that arrived in the
  same request: a body carrying settings without `scope` or `composedGrid` is
  refused with `400 selection_required_with_settings`.
- A setting the new selection does not author is dropped and named in the
  response, so the UI can say which choice a scope change withdrew. A value
  outside the capability registry's own value set, or of the wrong authored type,
  is refused with `400 aidlc_setting_invalid`.
- Settings are DRAFT-only. A write once the run has started answers
  `409 settings_locked`, which is the platform's half of the dialect annex's
  refusal of a mid-run settings change. No MCP tool can write one.
- Each changed key appends one `v2.intent.settings.changed` timeline event naming
  the authenticated member whose write changed it. The append is best-effort
  after persistence, like the other event appends.
- The recorded overrides reach the run, not only the draft: the orchestrator
  walk, every stage and resume dispatch and both of AgentCore's own stage
  resolutions project them through one shared contract
  (`shared/intent-methodology.js`).
- A stage that would have asked for a plan approval and did not carries an
  advisory gate notice saying whether the pinned release's named scope turns Plan
  Approval off by default or the intent turned it off before the run started. The
  notice names nobody; attribution is on the intent timeline.

### Build-and-test loop-back

Releases that ship the construction protocol (2.6.18 and later) let
build-and-test send the work back to code generation. Upstream does this
autonomously, up to three times per intent. Here the human decides, at the
validation gate build-and-test already has.

The capability is classified `approximated`: the loop-back is offered to a human
at the gate rather than taken autonomously, and scopes that run code generation
per unit get a gate note instead of the option.

- The agent records a recommendation through the `loopBackRecommended` field of
  `emit_stage_note`. The platform writes the reason on the stage's own row; the
  gate reads it and clears it once the gate is answered, so a recommendation is
  offered once. A failed write fails the tool call.
- The gate offers a third option, `loop-back`, when the stage immediately before
  build-and-test (passing over skipped stages) is code generation and the intent
  has used fewer than three loop-backs. The tally lives on the execution META
  row. It is updated in the same transaction as the code-generation reset, keyed
  by the gate id, so a replayed step does not count twice and a rewound run
  starts new ids.
- Choosing it resets code generation and build-and-test. Their attempts are
  bumped, which makes earlier plan-approval and review receipts unreachable.
  Code generation then runs fresh with the agent's reason and the reviewer's
  feedback in its prompt. If a reset fails, code generation is marked `FAILED`
  and the run fails in a rewindable state.
- The answer is recorded as `rejected`, so orchestrator code that predates the
  loop-back reads it as request-changes. The answer API rejects any other
  status for a loop-back, and rejects loop-back on a gate that does not offer it.
- At the cap, and in scopes that run code generation per unit (classic,
  enterprise, feature, mvp, workshop), the gate shows the recommendation and why
  the option is not offered. Those cases use request-changes or rewind.

An answered gate whose durable callback failed to resume can be retried through
the intent's Resume action. Callback-consumption markers and answered gate state
prevent a duplicate resume; an expired callback transitions the intent to a
rewind-recoverable `FAILED` state rather than leaving it indefinitely `WAITING`.

### Construction autonomy

Releases that ship the construction protocol also carry `Construction Autonomy
Mode`: the human's standing permission to complete the remaining construction
stage gates without stopping. The capability is classified `native` — the grant,
its two-value vocabulary, the first-stage carve-out and the halt-and-ask set are
all reproduced.

- The grant is per-intent and two-valued. Absent and `gated` both read as gated;
  only `autonomous` waives anything. It is frozen onto the intent at create by
  the human creating it, or escalated later by an explicit human answer: the
  `grant-autonomy` option, offered at the one construction gate that always stays
  human. The answer API rejects it on a gate that does not offer it. The
  release listing reports `constructionAutonomy` for each release, read from
  the record's stored protocol evidence, so the create page offers the opt-in
  only for a selected release that has it. The non-admin listing never
  re-verifies a closure, so a record whose stored evidence predates the
  protocol entries lists `false` there until an admin listing or a promotion
  re-verifies and caches it. The opt-in is then hidden, never wrongly offered,
  and creating an intent still decides from the release's closure.
- Once given, the grant holds for the rest of the intent, rewinds included,
  until the intent is cancelled. Cancelling clears it and records who withdrew
  it and when on the grant's provenance, so a rewind after a cancel relaunches
  the intent gated. Cancel is only accepted while the intent is parked or
  failed: a waived gate never parks, so an autonomous run can be cancelled once
  it halts at a human gate, a question or a failure. Every gate with a finding
  still halts and asks.
- It lives on its own META attribute, `constructionGateAutonomy`. The
  per-section unit-lane ladder keeps `constructionAutonomyMode`: that question
  asks only about parallel lane batching, and reading it here would waive gates
  the human was never asked about.
- A waived gate is never opened. The approved answer is synthesized and the run
  takes the ordinary approval path, so the durable record is the ordinary
  attempt-scoped `stage-approval` receipt, carrying `autonomous: true` and the
  protocol's marker input. The `v2.gate.auto_approved` timeline event is
  best-effort telemetry on top of that receipt, never the record itself. The
  grant's own provenance — who, when, and whether at create or at a gate — is
  durable too, as `constructionGateAutonomyGrant`.
- The halt-and-ask set is reproduced in full: the plan's first non-skipped
  construction stage with a sequential gate, every Code Generation Plan
  Approval, every fan-out approval, a stage failure, a blocking gate sensor,
  and a loop-back recommendation (offered, at the bound, or with no code
  generation to go back to) all still open a human gate. So does a gate
  with learning candidates waiting for the learnings ritual, and a gate whose
  stage outputs the runner could not observe: "no finding" is only read as
  clean when the outputs were actually checked. On an intent with a grant, each
  construction gate re-reads the intent before deciding, so a deleted intent, a
  cancelled run, or a run taken over by another orchestrator (a rewind relaunch)
  stops the walk instead of approving. An intent without a grant, and every gate
  outside construction, skips that read and keeps its durable history.
- Two deviations, both stricter than upstream: the gate-precondition evaluation
  runs in full on a waived gate, so ANY finding (advisory included) opens the
  human gate; and a terminal adversarial `NOT-READY` blocks a waived gate instead
  of being auto-approved. On a gate the grant does not cover, that same verdict
  stays an advisory finding and `approve` remains on offer, exactly as before.
- Residual: the grant governs only the once-per-workflow sequential gates.
  Per-unit stages inside a parallel section keep their own ceremony — the
  walking-skeleton gate and the section autonomy ladder — so a scope with a unit
  DAG still batches its lane approvals there. In those scopes the gate that
  always stays human is the first sequential construction gate after the lanes
  (for example build-and-test), and that is where `grant-autonomy` is offered.
  Non-construction phases are untouched.
- Residual: a waived gate judges the stage's evidence, not its test results. A
  build-and-test stage that succeeds with failing tests but raises no finding
  and records no loop-back recommendation has clean evidence, so an autonomous
  intent approves it. A blocking results sensor is what turns those failures
  into a halt.

## Persona sessions

Pinned releases that declare `pipeline` or `mob` stages, or `subagent` stages
with supports, dispatch each persona in its own serial session. For `subagent`
this applies only when the release closure ships
`core/aidlc-common/protocols/stage-protocol-ensemble.md`; a closure without that
file keeps a `subagent` stage on one delegated session however many supports it
declares, so 2.3.3 `reverse-engineering` is unaffected. A stage whose plan
resolved no policy also stays on the single-session path, because the validation
gate could not report persona evidence for it.
Each session receives a role-scoped brief:
pipeline links see earlier outputs, support personas see the lead draft without
sibling contributions, and the lead integration sees the collected contributions.
The reviewer remains a separate read-only session.

Contributions are written as persona-scoped artifacts and timeline events. The
platform stamps the contributor identity from the trusted session scope, so one
persona cannot create or overwrite another persona's evidence. A failed support
session is retried once with a reduced brief; if it still produces no evidence,
the run records a gap and continues, and the gap is reported at the validation
gate. An integration that produced no evidence is reported the same way, as
`ensemble_integration_missing`. A timed-out CLI child is killed and its exit
awaited before retry or gap handling.

One failure does not degrade to a gap. If the stage's persona receipt history
cannot be read, no persona session is dispatched and the platform cannot say
whether the declared personas ran, so the validation gate records
`ensemble_evidence_unavailable`: blocking and not overridable. There is no
`override-and-approve` for it, because a waiver would waive something nobody can
describe. Requesting changes re-runs the stage, which re-reads the receipts, so
the run is never stuck; a receipt store that stays unreadable leaves the stage
unapprovable until it recovers. A persona session, retry included, starts
only if a full 45-minute session still fits the stage budget of 6.5 hours; the
budget restarts with each run of the stage, including a resume, and is additionally
bounded by the runtime session's remaining lifetime, because serial stages share
one session. A session that does not fit is recorded as a gap, and a budget that
cut every collaborator, or that cut the integration, blocks the validation gate
overridably. Mob dissent is triaged for at most two
rounds and any maintained objection is shown verbatim at the existing validation
gate. Only the lead session can ask the human: no persona session, the
integrator included, is given `ask_question`, and judgment-class objections are
quoted at the validation gate instead.

`get_team_knowledge` and `record_team_knowledge` use the project's shared
knowledge. Persona identity scopes authorship; it does not create a private
knowledge namespace for each persona. Identity checks apply through supported
tool calls; they are workflow controls, not an isolation boundary against a
compromised AgentCore runtime identity, which remains trusted.

Persona sessions apply to release-pinned intents only; release pinning itself
defaults to `off`. There is no separate switch for them: to stop running
persona sessions, do not pin intents to a release that declares these modes.

`agent-team` remains explicitly unimplemented. Build-and-Test loop-back is a
separate runtime behavior with its own handler; persona sessions do not add a
loop-back gate option.

### Verification

Run the offline compatibility and golden-digest suite after importer or mapper
changes:

```bash
npm run test:aidlc-compatibility
```

The suite reads vendored fixtures and requires no network or cloud credentials.
