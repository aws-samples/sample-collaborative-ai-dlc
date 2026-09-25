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
includes the current 2.3.3 baseline and the 2.6.18, 2.7.0, 2.8.2, and 2.9.0
catalogs. A custom fork receives a synthesized profile with its own source
identity; an unknown tag or branch is not treated as an official release.

All official profiles use the same source trust tier. Trust establishes whether
the imported source may run; it does not certify that the platform reproduces
every semantic in that source.

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

Existing intents are not migrated or repinned. Release-aware compose reads use
the intent's stored pin, so reopening an intent does not silently change its
methodology version.

## Compatibility evidence and runtime support

The analyzer reports structural validity, dependency closure, sensor command
compatibility, mapped frontmatter values, and runtime-command fidelity. Each
authored value is classified as `native`, `approximated`, `unsupported`, or
`packaging-only`. The report includes the specific source values that the
current runtime does not honour.

The runtime supports the single-session stage mode and the platform's
always-restored workspace behavior. The mapper and analyzer know the complete
frontmatter vocabulary of all five profiles, but knowing a field is not the
same as executing its semantics. Other authored values remain `unsupported`
until the corresponding runtime handler is registered and implemented. This
distinction keeps newer imports inspectable without presenting them as
safe-to-run releases.

The gate handlers cover summary and plan-approval checkpoints, review policy,
both sensor planes, change control, learnings, skeleton selection, and
`AGENT.maxTurns`. The persona runtime dispatches `pipeline`, `mob`, and
`subagent` supports in separate serial sessions with role-scoped briefs.
`agent-team` remains unsupported because it requires concurrent sessions.

The 2.3.3 baseline remains promotable. The 2.6.18, 2.7.0, 2.8.2, and 2.9.0
fixtures have runtime handlers for their authored persona modes. Their
compatibility classification remains field-driven and reflects the supported
runtime semantics rather than profile-version exceptions.

`readyForCertification` is derived from the current compatibility report. It is
not a version allowlist, and the report's Boolean is not treated as durable
authorization by itself: the release-promotion guard stores the authored
fidelity gaps and reevaluates them against the handlers in the running build.

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

Because the registry reevaluates content evidence against the current handler
registry, adding a handler can make an existing import promotable without
changing its source bytes, importer revision, or closure digest. The registry
API exposes both the original fidelity gaps and the subset this build still
cannot honour; the admin screen explains a refused promotion.

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

An answered gate whose durable callback failed to resume can be retried through
the intent's Resume action. Callback-consumption markers and answered gate state
prevent a duplicate resume; an expired callback transitions the intent to a
rewind-recoverable `FAILED` state rather than leaving it indefinitely `WAITING`.

## Persona sessions

Pinned releases that declare `pipeline`, `mob`, or `subagent` supports dispatch
each persona in its own serial session. Each session receives a role-scoped brief:
pipeline links see earlier outputs, support personas see the lead draft without
sibling contributions, and the lead integration sees the collected contributions.
The reviewer remains a separate read-only session.

Contributions are written as persona-scoped artifacts and timeline events. The
platform stamps the contributor identity from the trusted session scope, so one
persona cannot create or overwrite another persona's evidence. A failed support
session is retried once with a reduced brief; if it still produces no evidence,
the run records a gap and continues. A timed-out CLI child is killed and its exit
awaited before retry or gap handling. Mob dissent is triaged for at most two
rounds and any maintained objection is shown verbatim at the existing validation
gate. Only the lead can ask the human.

`get_team_knowledge` and `record_team_knowledge` use the project's shared
knowledge. Persona identity scopes authorship; it does not create a private
knowledge namespace for each persona. Identity checks apply through supported
tool calls; they are workflow controls, not an isolation boundary against a
compromised AgentCore runtime identity, which remains trusted.

`V2_ENSEMBLE_SESSIONS` defaults to `on` and affects release-pinned intents only;
release pinning itself defaults to `off`. Setting the ensemble switch to `off`
selects the legacy single-session fallback for pinned ensemble stages.

`agent-team` remains explicitly unimplemented. Build-and-Test loop-back is a
separate runtime behavior; persona sessions do not add a loop-back gate option.

### Verification

Run the offline compatibility and golden-digest suite after importer or mapper
changes:

```bash
npm run test:aidlc-compatibility
```

The suite reads vendored fixtures and requires no network or cloud credentials.
