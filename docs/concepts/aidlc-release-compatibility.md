# AI-DLC Releases in Collaborative AI-DLC

Collaborative AI-DLC can import immutable AI-DLC releases, offer supported
releases for new intents, and pin an intent to the exact closure it will run.
This guide describes the shipped import, registry, selection, runtime, and
operations behavior. Existing intents keep their recorded pin across reseeds
and release changes. A release can be promoted only when every behavior it
authors has a runtime handler in this build; the admin tab lists any missing
handlers.

## Release identity and support states

An AI-DLC release is an immutable, content-addressed profile identified by the
exact source-control commit from which its import was produced. The commit
SHA is the release identity. A human-readable label, release date, upstream
tag, or numeric `workflowVersion` may be useful metadata, but none of them is
the identity and none may substitute for the exact SHA.

The profile records the source repository and ref, the exact SHA resolved at
import time, the importer/schema version, and the complete imported catalog
fingerprint. The fingerprint covers the blocks, workflow definitions, scopes,
rules, sensors, scripts, and other inputs that determine execution. A profile
must be reproducible from its identity and its recorded import evidence; an
import must never silently move an existing profile to a different SHA.

`workflowVersion` is therefore display and compatibility metadata only. A
numeric value such as `2` cannot distinguish two different contents published
under the same number, and it cannot prove that a profile is the one an intent
was created against.

## Profile identity and support state

A profile's support state describes what has been proved about it. These states
are deliberately separate:

| Support state        | Meaning                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `importable`         | The source can be fetched and its declared release inputs can be captured without treating the result as executable.                                                                 |
| `structurally-valid` | The captured catalog passes deterministic schema, reference, graph, and integrity checks.                                                                                            |
| `selectable`         | An admin has made the release available for new intents. It must be runnable, structurally valid, and visible; certification is not required.                                        |
| `certified`          | An admin has recorded a certification decision for the release. This is a support state, not a service-validated runtime-evidence artifact.                                          |
| `existing-only`      | The release may be used to identify and preserve existing intents, but may not be selected for new intents. This is the safe state for historical or otherwise unsupported profiles. |

`selectable` and `certified` are alternative support states; neither implies the
other. A visible, runnable release in either state can be chosen for a new
intent. `stable` is stricter: its target must be certified, except for the
current platform baseline. `importable`, `structurally-valid`, and
`existing-only` releases are not offered for new intents.

Support state applies to the release record as a whole; it is not scoped by
environment or intent scope. The admin decision and release identity are
separate from the numeric `workflowVersion` used by a workflow.

The importer revision includes a fingerprint of the block mapper. Mapper keys
and frontmatter normalization are defined for the supported profile set. A
mapping change alters the importer fingerprint and catalog goldens, so it
requires a new importer revision and closure upgrade. Runtime handlers may be
added for fields already recorded in a catalog without changing that catalog.

## Trust tiers

Trust tiers describe the provenance and review strength behind a profile. They
are evidence about trust, not a replacement for support state.

| Tier                           | Meaning                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T0 — untrusted**             | User-provided, preview, custom, or otherwise unverified content. It may be inspected or imported only under an explicit import policy.                                                      |
| **T1 — source-pinned**         | Content was imported from a recorded source repository and exact SHA, with a complete import manifest and no unresolved identity ambiguity.                                                 |
| **T2 — structurally reviewed** | T1 evidence is present and deterministic structural checks pass for the catalog and its execution references.                                                                               |
| **T3 — certified**             | An authorized administrator recorded the release's certification decision after reviewing its source and compatibility evidence. The service does not validate a runtime-evidence artifact. |

Trust describes provenance, while certification is an administrator-recorded
decision. Custom imports are T0 and non-runnable regardless of how complete
their files appear.

## Compatibility evidence

The immutable manifest records the source SHA, importer revision, closure digest,
catalog, runtime files, content-addressed objects, and compatibility analyzer
results. The release registry stores `fidelityGaps` derived from the verified
closure. Promotion and channel operations re-evaluate those gaps against the
runtime handlers present in the current build.

`readyForCertification` is an automated field-level signal for structural
validity, mapped frontmatter, and modeled values. It is not proof that every
protocol semantic is reproduced and does not validate a runtime-evidence
artifact. The service enforces structural and capability checks; certification
is an administrator's recorded decision.

## Runtime and selection behavior

### Runtime support

The runtime supports the single-session stage mode and the platform's
always-restored workspace behavior. The mapper and analyzer know the complete
frontmatter vocabulary of all five profiles, but knowing a field is not the
same as executing its semantics. Other authored values remain `unsupported`
until the corresponding runtime handler is registered and implemented. The
compatibility report keeps unsupported imports inspectable without presenting
them as safe-to-run releases.

The gate handlers cover summary and plan-approval checkpoints, review policy,
both sensor planes, change control, learnings, skeleton selection, and
`AGENT.maxTurns`. The persona runtime dispatches `pipeline`, `mob`, and
`subagent` supports in separate serial sessions with role-scoped briefs.
`agent-team` remains unsupported because it requires concurrent sessions.

### Before selection

The selector resolves immutable release identities rather than relying on
numeric `workflowVersion`. A visible, runnable release in `selectable` or
`certified` state can be chosen explicitly or through a channel. Only certified
releases, apart from the current platform baseline, can be assigned to `stable`.

### Before runtime

The runtime resolves and verifies the intent's pinned closure and object digests
before using release content. Missing or mismatched closure data fails the stage
rather than falling back to mutable SYSTEM rows.

Existing intents retain their pinned profile. They are not silently repinned
because a newer release is current, a numeric version is reused, or the SYSTEM
catalog is reseeded.

## Registry, promotion, and channels

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

### Custom forks

Custom forks are imported for inspection and remain non-runnable T0 records.

## SYSTEM reseeding and pinned intents

SYSTEM reseeding updates the default methodology catalog. A pinned intent
continues to resolve its immutable release closure, so reseeding does not
overwrite the content or identity that existing intent runs use.

## Immutable release storage

The seed lambda imports an allowlisted release commit as immutable bytes. The
manifest is published last, after its objects and catalog have been read back
and verified.

`lambda/shared/aidlc-release.js` builds a release bundle from a profile and its
fetched `core/**` files, and publishes it under one prefix keyed by the exact
source SHA and the importer revision:

| Key                                            | Contents                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `aidlc-releases/v1/<sha>/i<rev>/manifest.json` | The release manifest, written last as the publication marker.          |
| `aidlc-releases/v1/<sha>/i<rev>/catalog.json`  | The body-free methodology catalog for that commit.                     |
| `aidlc-releases/v1/runtime/sha256/<hash>`      | Content-addressed internal runtime files, shared across releases.      |
| `blocks/bodies/sha256/<hash>`                  | Content-addressed block bodies (the existing content-addressed store). |
| `blocks/scripts/sha256/<hash>`                 | Content-addressed sensor scripts (the existing store).                 |

The importer revision is an integer, separate from the schema version. It is
bumped when importer or adapter semantics change, so re-importing the same
commit under new semantics lands under a new prefix instead of colliding with
bytes produced by an older importer.

The catalog is produced by the block mappers **at import time** and is immutable
afterwards, so a mapper that learns a new field changes nothing for a closure
that is already published. Revision 1 was the initial importer; revision 2 adds
the capability mappers (`reviewClass`, `reviewArtifact`, `summaryConfirmation`,
`fireOn`, `maxTurns`, the per-scope execution policy). A 2.9.0 closure imported
at `i1` therefore authors none of those fields, while the same commit imported at
`i2` authors all of them (27 `summaryConfirmation`, 8 `reviewClass`).

From revision 2 every manifest also records a `mapperFingerprint`
(`lambda/shared/aidlc-release-importer.js`): sha256 over the catalog the running
mappers produce for a fixed probe corpus that authors every field the capability
registry classifies. The fingerprint is pinned per revision in source, and:

- the importer refuses to publish (`release_importer_fingerprint_drift`) when the
  running mappers do not reproduce the pin for the revision it would write, so a
  mapper edit without a revision bump can never land under an existing prefix;
- the importer refuses to build any revision other than its own
  (`release_importer_revision_invalid`) — an older revision's bytes were produced
  by mappers that no longer exist;
- a reader refuses a manifest whose fingerprint disagrees with the pin for its
  revision, a revision-1 manifest that carries one, or a revision-2+ manifest
  without one (`release_manifest_invalid`). A revision newer than the running code
  is accepted on shape alone, so a lambda rollback cannot strand closures a newer
  importer already published; the `closureDigest` still guards their integrity.

A behavioural fingerprint was chosen over a hand-bumped `MAPPER_REVISION`
constant because a constant only works if whoever edits a mapper remembers to
bump it — a stale mapper revision could publish a 2.9.0 closure missing a
capability field. A hash of one catalog's field vocabulary was rejected because
it is a property of one release (2.3.3 authors none of these fields) and misses a mapper that
changes a value without changing a key. The unit suite additionally pins the
catalog digest of every vendored compatibility fixture per revision
(`lambda/shared/test/aidlc-release-importer.test.js`), which covers an upstream
field the probe does not know about yet.

A release is built only from an allowlisted profile whose `upstreamRef` is a
full SHA. Refs, tags, and branches are rejected. The build runs the compatibility
analyzer first and refuses to produce a bundle unless the commit is both
importable and structurally valid, attaching the analyzer diagnostics to the
rejection. The manifest records the profile identity, trust tier, frontmatter
dialect, catalog digest, the sorted object set with per-object digests, the
runtime file list, and the compatibility evidence — and contains no timestamp
or other nondeterministic field. A `closureDigest` over everything else makes
the whole bundle one verifiable identity, so the same input always produces a
byte-identical manifest.

Publication is ordered so that the marker cannot be reached before its
contents:

1. every content object, with `IfNoneMatch`; a `412` is accepted because the
   keys are content-addressed and identical bytes are already stored;
2. the catalog, with `IfNoneMatch`; on `412` the stored bytes are compared
   canonically and a mismatch fails with `release_conflict`;
3. a read-back verification of every object and the catalog against the
   recorded digests; any missing, unreadable, or tampered object fails with
   `release_verification_failed` and the manifest is never written;
4. the manifest, with `IfNoneMatch`. An identical existing manifest reports
   `already-published`; anything else fails with `release_conflict`.

Re-importing a published release is therefore idempotent, and a partially
written release is visibly incomplete rather than silently trusted.

The seed lambda exposes this as an opt-in mode:

```bash
aws lambda invoke \
  --function-name $(terraform output -raw seed_blocks_lambda_name) \
  --payload '{"importRelease":true,"profile":"v2.9.0","dryRun":true}' \
  --cli-binary-format raw-in-base64-out /tmp/out.json
```

The mode accepts a profile id only (never a raw SHA, so the invoke payload is
self-describing), rejects an explicit `ref`, cannot be combined with `reseed`,
and returns before any DynamoDB access.

The seed lambda runs under its own `seed_blocks` IAM role, the only role with
write access to `aidlc-releases/*`. The user-facing building-blocks and
workflows lambdas keep the shared `blocks` role and cannot publish releases.

Import publication does not mutate SYSTEM blocks or write the legacy mutable
runtime/catalog prefixes. Registry selection and runtime resolution use separate
steps described below.

## Release-pinned execution

A pinned execution resolves its workflow plan, methodology library, and runtime
files from the immutable release closure. The orchestrator forwards the intent's
pin to AgentCore; unpinned intents retain the legacy SYSTEM catalog path.

### The execution-level identity

An execution META row may carry one optional field:

```json
"methodologyRelease": {
  "releaseId": "aidlc:<sha>",
  "sourceSha": "<sha>",
  "importerRevision": 2,
  "closureDigest": "<sha256>",
  "catalogKey": "aidlc-releases/v1/<sha>/i2/catalog.json",
  "manifestKey": "aidlc-releases/v1/<sha>/i2/manifest.json"
}
```

The resolver loads the closure named by **this persisted pin** — `sourceSha` plus
`importerRevision` address the manifest, and every other field is re-verified
against it. It never reads the registry, so moving a registry record onto a newer
importer revision's closure cannot change what an existing intent runs.

It is part of the checkpoint projection, so a rewind, repair, or recompose of a
pinned intent resolves the same release as its first start. `aidlcRepoRef` and
`methodologyPins` are unchanged: the former remains the human-facing source ref,
the latter still pins user-tenant block versions. Every field of the pin is
re-verified against the published manifest on every load, so a pin can never
widen into a different release.

### Three-tier resolution

| Tier               | When                                                       | Source of the methodology                                                                            |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Release            | `methodologyRelease` is present on META                    | The immutable release closure in S3. No SYSTEM DynamoDB row is read.                                 |
| Legacy catalog     | No release pin, but a native export needs the intent's SHA | `aidlc-catalogs/v1/<ref>.json`, rebuilt from `core/**` on miss — the existing export-only behaviour. |
| DynamoDB (default) | No release pin                                             | The SYSTEM + user rows the platform has always read, with `methodologyPins` applied as before.       |

`lambda/shared/release-resolver.js` owns the release tier. `loadReleaseClosure`
verifies the pin against the manifest and the catalog bytes against
`manifest.catalog.sha256`, and memoizes the result — a closure is immutable, so
a bounded process-level cache keyed by `releaseId` + `closureDigest` is safe.
`resolveMethodologyLibrary` then assembles the library, and `resolveRuntimeFile`
reads a digest-verified runtime engine file out of the content-addressed store.

In release mode the release catalog is the base library and the only overlay is
an explicitly versioned user-tenant block. The workflow comes from the catalog
when the pinned id and numeric version match it, and otherwise from the user
fork's immutable `WF#default#<id>` `V#<n>` snapshot — `WF#SYSTEM#*` is never
read, because the release _is_ the SYSTEM methodology for that intent.

### Carrying the pin to the runtime

The pin lives on the execution META row, so every component that resolves
methodology has to be handed it explicitly. The chain is:

| Hop                               | Carrier                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| intents → plan / scope resolution | `releasePlanOptions(meta)` on every `loadExecutionPlan` / `loadWorkflowScopes` call                      |
| orchestrator → its own plan load  | the same helper, so a rewind or repair walk resolves the release the intent started on                   |
| orchestrator → AgentCore          | `methodologyRelease` on the `run-stage-start` payload, beside `aidlcRepoRef` and `methodologyPins`       |
| intents → AgentCore (composer)    | `methodologyRelease` on the `compose-plan-start` payload                                                 |
| AgentCore → library and conductor | `loadLibrary({ methodologyRelease })` and `loadConductor(ref, { methodologyRelease })` in `block-loader` |

Every hop uses a conditional spread, so an unpinned intent's payloads and loader
arguments are byte-identical to what they were before issue #482. The
orchestrator needs `s3:GetObject` on `aidlc-releases/*` and an `ARTIFACTS_BUCKET`
environment variable for this; both are scoped to reading published releases.

### The runtime half

Inside the container, release mode replaces three sources:

- **the block library.** `loadLibrary` delegates to `resolveMethodologyLibrary`,
  so the release catalog is the base and explicit user-tenant pins the only
  overlay. Neither `listMergedBlocks`, nor a `BLOCK#SYSTEM`/`WF#SYSTEM` row, nor
  a `V#latest` read happens at all. `assertSystemSourceRef` still runs — release
  blocks carry `sourceRef = sourceSha`, so an `aidlcRepoRef` that disagrees with
  the pin is still loud, it just can no longer be satisfied by a reseeded row.
- **the conductor persona.** `loadConductor` reads
  `core/aidlc-common/conductor.md` out of the closure's content-addressed runtime
  objects and verifies its digest. The legacy path reads
  `aidlc-runtime/<ref>/…` and tolerates a miss with `''`; release mode does not.
  A missing or tampered conductor fails the stage with `conductor_unavailable`
  instead of silently running without the execution-quality doctrine — that
  swallowed error was one of the two drift vectors this phase closes.
- **the composer's grounding.** `compose-plan-start` takes its SCOPE vocabulary
  from `blocksByType.SCOPE` on the closure, so a proposal is validated against
  the methodology the intent will actually run rather than the current SYSTEM
  catalog. An unresolvable closure fails the compose row; it never grounds the
  composer in an empty scope list.

### Fail-closed rules

Release mode never degrades to a lower tier. Any of the following aborts plan
resolution with a structured error instead of running something else:

| Code                       | Cause                                                                           |
| -------------------------- | ------------------------------------------------------------------------------- |
| `release_not_found`        | No manifest is published for the pinned SHA and importer revision.              |
| `release_closure_mismatch` | The pin, the manifest, the catalog digest, or a runtime object digest disagree. |
| `unpinned_user_block`      | A user-tenant block or placement has no explicit immutable version.             |
| `user_block_missing`       | An explicitly pinned user block version is not in the table.                    |
| `workflow_not_found`       | The pinned workflow is in neither the release nor a user-fork snapshot.         |
| `runtime_file_missing`     | A requested runtime path is absent from the release or its object is gone.      |

`V#latest` is never read in release mode: a user-tenant placement must carry an
explicit `pinnedVersion` or a user pin. Otherwise a later user edit would change
what an already-created intent runs — the same class of drift as a SYSTEM
reseed. The scope vocabulary offered for a pinned intent likewise comes from the
release, so an unresolvable release offers no scopes rather than falling back to
the reseedable SYSTEM list.

The acceptance property is tested directly, at both layers: two profiles that
publish the same workflow id at the same numeric `workflowVersion` with different
content are published as releases A and B, the SYSTEM rows are seeded from B, and
an intent pinned to A must still resolve exactly A — the same plan from
`loadExecutionPlan`, the same library from the container's `loadLibrary`, and the
same conductor bytes even when `AIDLC_REPO_REF` names B's snapshot.

### The write flag

Stamping the pin is gated by `AIDLC_RELEASE_PINNING`, default `off`. When it is
`on`, intent create looks for a published manifest for the ref it already
resolved and stamps the pin if one exists. A ref with no published release is
not an error — the intent is created unpinned and a warning is logged. Reading
an existing pin is never gated: turning the flag back off must not silently move
a pinned intent back onto the reseedable rows.

### Deliberate deferrals

Two runtime integration details are worth noting:

- `findNativeIncompatibleBlocks` still lists the merged DynamoDB blocks to detect
  customer-authored custom blocks. That check asks "what has this tenant added?",
  which is a question about the live catalog, not about the pinned release, so it
  intentionally keeps reading the merged view.
- a plain `POST /start` does not revalidate the closure before accepting. The
  orchestrator revalidates on its first plan load and fails closed there, so a
  release deleted or tampered with between create and start surfaces as a
  `plan_invalid` execution failure rather than a rejected start request.

Existing intents are not repinned. To use a different release, create a new
intent and choose its release at creation time.

## Capability adapters and fidelity

The capability adapters consume execution-relevant frontmatter fields through
named runtime seams. This makes supported values runnable while retaining a
field-by-field fidelity classification for any remaining approximation or gap.

Runnable is not the same as faithful, and this document does not conflate them.
Each field is classified `native`, `approximated`, `unsupported`, or
`packaging-only` per AUTHORED VALUE, and a release that authors an unsupported
value is not ready for certification even though it runs. See the fidelity matrix
and the certification bar below for where 2.6.18-2.9.0 currently stand.

The governing rule is that **a field only acts when it is present, and the
per-scope policy only acts in release mode**. Each mapper adds its key
conditionally, the plan resolves a policy object only when the library came from
a verified release closure AND the resolved SCOPE or STAGE block carries at least
one capability field, and the stage prompt appends a section only when there is
something to say. An unpinned catalog therefore maps, plans, and prompts
byte-identically to the legacy path; that invariant is asserted directly against
the adapter goldens
(`lambda/shared/test/aidlc-release-adapters.test.js`).

### The semantics, and where each one lands

Defaults are the behaviour of a release that lacks the field, so adding the
field to a catalog never changes a run that does not use it.

| Field                        | Since  | Semantics                                                                                                                                                                                                                       | Seam                                                                                                                                          |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `STAGE.mode`                 | 2.6.18 | `inline` \| `subagent` \| `pipeline` \| `mob` \| `agent-team`, default `inline`. `pipeline`/`mob` are multi-persona topologies.                                                                                                 | plan `RUNNABLE_MODES`; real per-persona sessions in `ensemble-runner.js` (release mode), ensemble prompt in `stage-materializer.js` otherwise |
| `SENSOR.fire_on`             | 2.7.0  | `write` \| `gate`, default `write`.                                                                                                                                                                                             | plan `stage.sensors[].fireOn`; `sensor-runner.js` candidate selection                                                                         |
| `SCOPE.sensors`              | 2.9.0  | `on` \| `off`, default `on`. `off` ⇒ no stage sensor runs on either plane.                                                                                                                                                      | plan: `stage.sensors = []`                                                                                                                    |
| `STAGE.review_class`         | 2.6.18 | `adversarial` \| `advisory`, default `adversarial` when a reviewer is set. Advisory is ONE terminal pass, no repair; findings recorded on the stage timeline.                                                                   | plan pins `maxIterations: 1` + `advisory`; `run-stage.js` honours it                                                                          |
| `SCOPE.review_cap`           | 2.6.18 | `none` \| `advisory` \| `adversarial`, default `adversarial`. Effective class = min(stage, cap) with `none < advisory < adversarial`; lowers only.                                                                              | plan: reviewer downgraded or removed                                                                                                          |
| `STAGE.review_artifact`      | 2.7.0  | Slug of a required `produces`; the reviewer judges that canonical artifact.                                                                                                                                                     | `buildReviewerPrompt`                                                                                                                         |
| `STAGE.summary_confirmation` | 2.6.18 | `required` \| `if-present`; absent ⇒ none.                                                                                                                                                                                      | stage prompt "Scope policy" block                                                                                                             |
| `SCOPE.summary_confirmation` | 2.9.0  | `on` \| `off`, default `on`. `off` bypasses the stage-level requirement.                                                                                                                                                        | plan folds it into the effective value                                                                                                        |
| `SCOPE.change_control`       | 2.8.2  | `strict` \| `relaxed` — whether a changed approved input reopens its checkpoint or continues with an audited note. Defaults to `strict` when the CATALOG proves the capability (some SCOPE authors the field); otherwise inert. | stage prompt "Scope policy" block                                                                                                             |
| `SCOPE.learnings`            | 2.9.0  | `on` \| `off`, default `on` — whether the per-stage learnings ritual runs.                                                                                                                                                      | stage prompt "Scope policy" block                                                                                                             |
| `SCOPE.skeleton`             | 2.6.18 | `on` \| `off` — walking-skeleton ceremony for the first construction stage.                                                                                                                                                     | stage prompt "Scope policy" block                                                                                                             |
| `SCOPE.runner`               | 2.6.18 | Boolean, packaging-only.                                                                                                                                                                                                        | none — recorded, never executed                                                                                                               |
| `AGENT.maxTurns`             | 2.6.18 | Decimal integer turn cap on the two reviewer agents.                                                                                                                                                                            | OpenCode `agent.build.steps`; Claude's own cap; inert on Kiro                                                                                 |
| `{{INVOKE}}` in stage bodies | 2.8.2  | Expands to the upstream engine CLI.                                                                                                                                                                                             | neutralized in the prompt + `prompts/invoke-dialect-annex.md`                                                                                 |

### Fidelity matrix

Fidelity is a property of the **(field, value)** pair, not of the field:

- `native` — the platform enforces the upstream semantics itself.
- `approximated` — the effect is reproduced at a different seam, with the
  residual deviation stated below.
- `unsupported` — the authored semantic is **not** reproduced. The platform
  cannot enforce it and does not pretend to.
- `packaging-only` — upstream uses the field to generate convenience packaging;
  there is no execution effect to reproduce.

The analyzer emits this per profile as `report.fidelity`, listing only the
values a profile's catalog actually carries, with a per-row rollup that takes the
**worst** handling among them — so a row can never read `native` while carrying
an unsupported value. `report.certificationGaps` names every gap explicitly.

| Field / value                                       | 2.3.3 (current-stable) | 2.6.18         | 2.7.0          | 2.8.2          | 2.9.0          |
| --------------------------------------------------- | ---------------------- | -------------- | -------------- | -------------- | -------------- |
| `STAGE.mode: inline` / `subagent`                   | native                 | native         | native         | native         | native         |
| `STAGE.mode: pipeline` / `mob`                      | absent                 | approximated   | approximated   | approximated   | approximated   |
| `STAGE.mode: agent-team`                            | absent                 | absent         | absent         | absent         | absent         |
| `STAGE.workspace_requires`                          | approximated           | approximated   | approximated   | approximated   | approximated   |
| `SENSOR.fire_on: write`                             | absent                 | absent         | absent         | absent         | absent         |
| `SENSOR.fire_on: gate`                              | absent                 | absent         | native         | native         | native         |
| `SCOPE.sensors`                                     | absent                 | absent         | absent         | absent         | native         |
| `STAGE.review_class: adversarial`                   | absent                 | absent         | absent         | absent         | absent         |
| `STAGE.review_class: advisory`                      | absent                 | native         | native         | native         | native         |
| `SCOPE.review_cap`                                  | absent                 | native         | native         | native         | native         |
| `STAGE.review_artifact`                             | absent                 | absent         | native         | native         | native         |
| `STAGE.summary_confirmation: required`              | absent                 | native         | native         | native         | native         |
| `STAGE.summary_confirmation: if-present`            | absent                 | absent         | absent         | absent         | absent         |
| `SCOPE.summary_confirmation: off`                   | absent                 | absent         | absent         | absent         | native         |
| `SCOPE.change_control`                              | absent                 | absent         | absent         | approximated   | approximated   |
| `SCOPE.learnings`                                   | absent                 | absent         | absent         | absent         | approximated   |
| `SCOPE.skeleton: off`                               | absent                 | native         | native         | native         | native         |
| `SCOPE.skeleton: on`                                | absent                 | approximated   | approximated   | approximated   | approximated   |
| `SCOPE.runner`                                      | absent                 | packaging-only | packaging-only | packaging-only | packaging-only |
| `AGENT.maxTurns`                                    | absent                 | approximated   | approximated   | approximated   | approximated   |
| `{{INVOKE}} engine sensor-<id>`                     | absent                 | absent         | absent         | native         | native         |
| `{{INVOKE}} engine gen` / `workspace`               | absent                 | absent         | absent         | absent         | absent         |
| `{{INVOKE}} engine orchestrate`/`recompose`/`state` | absent                 | absent         | absent         | absent         | absent         |

`absent` means no file in that release's catalog authors the value, so the
platform's handling of it is untested by that release and is not claimed.
`STAGE.review_class: adversarial` is absent from every catalog above: a stage
that wants an adversarial reviewer declares `reviewer:` instead, and the plan
derives the class from it. The platform reproduces the value, but no fixture
exercises it, so the matrix does not claim it.

Two upstream semantics are **protocol prose plus a PreToolUse guard** rather than
frontmatter, so they cannot be keyed on a (field, value) pair and never appear in
`report.fidelity`. They are registry entries whose presence test is the release
closure's runtime file list, and they are classified here:

| Protocol semantic             | Presence test (runtime file)                                 | 2.3.3  | 2.6.18+          |
| ----------------------------- | ------------------------------------------------------------ | ------ | ---------------- |
| Code Generation Plan Approval | `core/hooks/aidlc-plan-approval-guard.ts`                    | absent | **unsupported**  |
| Build-and-Test loop-back      | `core/aidlc-common/protocols/stage-protocol-construction.md` | absent | **approximated** |

No version string is involved in either test, and 2.3.3 ships neither file, so
both stay inert for the current baseline. Runtime-file protocol capabilities are
recorded separately from the analyzer's frontmatter fields. The release registry
persists every protocol present in the verified closure and checks it against the
current build's handlers during promotion and channel updates. Plan Approval's
current handler checks authorization at the completion boundary, so it is an
approximation of the upstream pre-write guard, not the same guarantee. A build
without an outcome-gate handler blocks promotion; after a handler is registered,
stored and legacy records are re-evaluated from their closure without re-import.
`readyForCertification` remains a field-level signal and can be true when a
protocol semantic is not reproduced.

### Certification bar

`readyForCertification` is true only when the release is structurally valid, its
sensor dependency closure is complete, its sensor commands bind to their declared
ids, and **no modeled authored value is `unsupported` and no execution-relevant
frontmatter key is unmapped**. Unmapped keys now default to
execution-relevant — only an explicit informational allowlist is exempt, and it
has exactly one entry (`STAGE.workspace_requires`, satisfied architecturally).
An `approximated` value does NOT withhold this signal — only `unsupported`
modeled values do — so classifying `workspace_requires` as approximated (its
precondition holds architecturally rather than by per-stage assertion) leaves
`current-stable` ready. This signal is not a certification decision and does not
prove every protocol semantic is reproduced.

On the current fixtures that yields:

| Profile          | readyForCertification | Gaps |
| ---------------- | --------------------- | ---- |
| `current-stable` | **true**              | none |
| `v2.6.18`        | **true**              | none |
| `v2.7.0`         | **true**              | none |
| `v2.8.2`         | **true**              | none |
| `v2.9.0`         | **true**              | none |

These five verdicts are asserted by
`lambda/shared/test/aidlc-compatibility.test.js` against the vendored fixtures;
run `npm run test:aidlc-compatibility` to verify them.

The candidate profiles clear the bar because the runtime now enforces the two
authored values that were previously `unsupported`:

- **`STAGE.summary_confirmation: required`** (27 of the ~32 stages in 2.6.18+
  author it) was previously a prompt instruction with no seam at which to reject
  an output produced without the confirmation. It is now a platform-owned
  `confirm_summary` checkpoint whose positive label writes an attempt-bound
  receipt, and stage outputs must carry that receipt's authorization stamp.
- **`SENSOR.fire_on: gate`** was previously fired beside the write plane. It now
  runs as its OWN pass after the reviewer loop resolves, once per existing
  declared deliverable, on the final bytes the human approves. A blocking verdict
  holds that stage's human gate with an `override-and-approve` option that records
  who accepted what; an ungated stage halts, which is upstream's own autonomous
  behaviour. All six stock 2.9.0 sensors are `advisory`, so for the shipped
  catalog the deliverable here is accuracy and visibility rather than new blocking
  behaviour.

`pipeline` and `mob` travelled furthest. They first returned `not_implemented` for
2.9.0-pinned stages; then ran as a single-session approximation; and now run as a
real session per persona with per-link and per-contribution receipts.

The signal is not the same as `certified`. Certification is the admin's recorded
decision; the service enforces structural and capability checks but does not
validate a runtime-evidence artifact. Admins may document their operational
review in release notes. Stable-channel eligibility is enforced from the
certified support state, with the current-baseline exception.

### Residual deviations

These are the exact ways a pinned run still differs from upstream. They are
deviations, not gaps to be discovered later.

- **`<stage>-questions` outputs are satisfied by the question channel.** From
  2.9.0 on, upstream lists a per-stage questions file (for example
  `requirements-analysis-questions`, `intent-capture-questions`) in `produces:`
  and exchanges a stage's clarifying questions through it. The platform asks the
  same questions through `ask_question` / `confirm_summary`; the questions and
  answers live in the HUMAN# task rows and on the timeline, not in a graph
  artifact. Any produced artifact whose slug ends in `-questions`
  (`isQuestionChannelOutput` in `lambda/shared/aidlc-capabilities.js`) is
  therefore never reported as `required_artifact_missing` and never demanded as a
  re-save after the confirmation checkpoint. The artifact block itself is still
  imported unchanged.

- **`fire_on` has no write hook; the gate plane is reproduced.** Upstream fires a
  `write` sensor when a matching file is written; the CLI owns the edit loop here,
  so the write plane runs post-agent, narrowed to the files this stage attempt
  actually changed (from the stage's git result) — an approximation. The `gate`
  plane is a SEPARATE pass that runs after the reviewer loop resolves, sweeping
  every declared deliverable rather than one attempt's delta, so its verdict is on
  final bytes; that is why it is classified native. A
  sensor whose plane has nothing to inspect records `INCONCLUSIVE` with
  `detail.notApplicable` rather than a new result value, because widening the
  four-value verdict vocabulary would change how every historical `SensorRun` row
  is read. A MISSING REQUIRED deliverable is still reported as a finding and
  never suppressed behind not-applicable. When the git result is unavailable, or
  any repository reported no file list at all, the `write` list is discarded
  entirely and the sweep falls back to the whole workspace — a partial list would
  silently narrow a real finding into "no files match". In a multi-repo project
  the git-reported repo-relative paths are projected into the workspace path
  space before matching.
- **`mode: pipeline` / `mode: mob` / `mode: subagent`-with-supports run a real
  session per persona, serially.** Upstream's invariant is not concurrency, it is
  who sees whose work (upstream stage-protocol-ensemble §3.7, which explicitly
  permits serial dispatch with unchanged briefs). In release mode
  `lambda/agentcore/ensemble-runner.js` dispatches one CLI session per persona
  through `dispatchPersona`, each with its own brief:
  - `subagent` with N supports and `mob`: the lead session drafts, each support is
    dispatched with a brief naming only the lead's draft artifacts, then the lead
    is re-invoked as an integrator with the contributions. Each support records a
    `contribution` artifact (`contribution-<stageId>-<agentRef>`) carrying the
    server-owned `collaborator` property and AGREE/OBJECT positions. The markdown
    `**Collaborator:** <agentRef>` line is display text, not evidence identity.
    Each support also records a `RECEIPT#persona-contribution` and a
    `v2.persona.contribution` timeline event.
  - `pipeline`: N+1 ordered links, the lead being link 1. Each link sees every
    upstream link's work and edits the evolving artifacts directly — no
    contribution files, per upstream §3.4. Each link records
    `RECEIPT#pipeline-link#…#<ordinal>` and `v2.persona.link_completed`.
  - `mob` dissent triage: a maintained `OBJECT (judgment)` is raised by the
    integrator as one consolidated `ask_question`; a maintained
    `OBJECT (knowledge)` re-dispatches the objectors with the revised draft and
    their peers' positions, capped at two rounds on the persisted receipts.
    Dissent that survives is quoted verbatim into the validation gate as a
    `review_dissent_maintained` finding and emitted as `v2.persona.dissent`.

  Receipts are attempt-scoped, so a park/resume within one attempt skips the
  personas that already produced evidence (including a park during the integrator
  session), while a rewind bumps the attempt and re-dispatches the whole topology
  in order — upstream's deliberate receipt invalidation, for free.

  Residual deviations that keep this `approximated` rather than `native`:
  - **personas run serially, never concurrently.** Upstream permits this, but the
    wall-clock shape of a stage differs.
  - **contributions are graph artifacts, not `.aidlc-engine/**` files.** The
    platform has no engine mount; the timeline plus DynamoDB receipts are the
    record. The artifact vocabulary is the existing generic `create_artifact`, so
    no new MCP tool and no new artifact registry entry were needed.
  - **blindness is enforced by what a brief contains, not by a read hook.** A
    support's brief never names a sibling's contribution id and explicitly forbids
    reading one, but the platform has no PreToolUse interception to make that
    impossible — the same limitation upstream carries on hookless harnesses.
  - **`subagent` stays classified on the single-session seam.** A lead-only
    `subagent` (stock `code-generation`) is genuinely one session; only a
    `subagent` that declares supports becomes hub-and-spoke.

  Failure never blocks. A persona session that produces no evidence is retried
  once with a reduced brief (knowledge block dropped, artifact names instead of
  bodies — upstream §3.3 does the same); still nothing and a `contribution` stub
  with `props.status = 'gap'` is recorded, `v2.persona.gap` is emitted, and the run
  continues. Every gap reaches the human as an advisory finding at the validation
  gate. Any unexpected error in ensemble orchestration degrades to a gap, never to
  a failed stage.

  The support-agent bodies are loaded from the SAME library as the stage (the
  release closure for a pinned intent), so a pinned run can never pull a reseeded
  persona. A stage that declares an ensemble mode but resolves no support agent is
  byte-identical to `inline`. `V2_ENSEMBLE_SESSIONS=off` reverts to the
  single-session ensemble prompt (`renderEnsembleProtocol`) byte for byte, as does
  any non-release-mode run. `agent-team` remains `not_implemented`.

- **`STAGE.workspace_requires` is satisfied architecturally, not per field.** The
  runtime clones and self-heals the repository checkout before every stage, so
  the precondition always holds for a repo-backed project. It is classified
  `approximated` rather than `native` for exactly that reason: nothing asserts the
  declaration per stage. Residual: a project
  with no repositories is not refused — there is no checkout to require, and the
  stage runs against graph artifacts only.
- **`summary_confirmation` is fully enforced, natively.** A `confirm_summary`
  tool, registered only when the resolved policy needs it, opens a checkpoint
  whose two option labels the platform owns, and whose positive label writes a
  `RECEIPT#summary-confirmation` bound to the digest of the summary the human
  actually saw. Every subsequent artifact write is stamped with that receipt, and
  the completion ladder rejects a stage whose required outputs carry no current
  authorization: one repair turn, then a blocking overridable finding at the gate
  (or a rewind-eligible failure for an ungated stage). Residual, shared with
  upstream: an artifact drafted BEFORE the confirmation and re-saved after it
  passes the lineage check, because the check is at the boundary rather than on
  each write.
- **`change_control` reproduces only the input-fingerprint half of upstream's
  mechanism, so it is classified `approximated`.** A stage approval records the
  content fingerprints of what it produced, and the next stage compares its
  required inputs against them before the agent runs — `relaxed` appends a
  deduplicated `v2.change.accepted` and continues, `strict` opens a two-option
  question gate (reconfirm, or stop so the human can rewind) whose halt is the
  rewind-eligible `change_control_halt`. It defaults to `strict` only when the
  CATALOG proves the capability (some SCOPE authors the field on this closure)
  — never merely because some other policy key is present. Residual: upstream's
  reviewer-request and completion-refusal halves of change control — a reviewer
  that can itself request re-confirmation, and a human that can refuse the
  completion outright on a changed input — are not reproduced; this platform
  compares fingerprints at the stage boundary only.
- **`skeleton: off` is native; `skeleton: on` is approximated.** `off` skips the
  walking-skeleton solo pass and its `eg-skeleton-*` gate (recorded as
  `v2.units.skeleton_skipped`) while the first construction stage keeps its
  ordinary approval gate — a removal the platform enforces fully, which is why
  `off` is `native`. `on` keeps the ceremony, but upstream's conductor
  additionally classifies a project/team/org skeleton STANCE from `##
Walking Skeleton` memory-file statements and can override the authored value
  with it; this platform has no memory file of that shape, so the scope field
  alone decides and the stance classification is not reproduced — which is why
  `on` stays `approximated`.
- **Code Generation Plan Approval rejects the outcome; upstream prevents the
  write.** Upstream's `aidlc-plan-approval-guard.ts` is a PreToolUse hook that
  blocks a code write before the plan is approved. The platform has no
  per-write hook, so that requirement — preventing the write — is classified
  `unsupported`, not `approximated`: the registry does not pretend a boundary
  check reproduces a pre-write block. What IS built is a compensating boundary
  check: `request_plan_approval` opens a checkpoint bound to the plan digest,
  and the completion ladder rejects a stage whose required outputs carry no
  current authorization (the stage's git commit must be newer than the
  receipt) — one repair turn, then a blocking overridable finding at the gate.
  Rejecting the outcome of an unapproved write is a different guarantee from
  preventing the write itself, so it does not change the classification.
  `PROTOCOL:plan-approval` is not a frontmatter `(field, value)` pair — see
  [capability adapters and fidelity](#capability-adapters-and-fidelity) — so this
  `unsupported` classification can never appear in `report.certificationGaps`
  and never withholds `readyForCertification` for any pinned release.
- **The Build-and-Test loop-back is bounded faithfully and offered, not taken.**
  Upstream loops build-and-test back to code generation autonomously, up to three
  times per intent. Here the agent records a recommendation through
  `emit_stage_note`'s `loopBackRecommended` field — a typed
  `v2.loopback.recommended` event stamped with the attempt from the trusted
  container scope, never parsed from prose — and the validation gate
  build-and-test already has then carries a third `loop-back` option naming the
  computed target verbatim. The target is derived from the plan (the nearest
  preceding in-scope stage the release marks as code generation), never from a
  version string or a hardcoded stage id. Choosing it resets the `STAGE#` rows from
  the target through the current stage, which bumps their attempt and makes every
  prior plan-approval and review receipt unreachable without deleting anything,
  emits `v2.loopback.recorded`, and moves the walk back. At three recorded
  loop-backs the option is withheld and the gate says so, leaving
  `request-changes` and the rewind API. Residual deviations: the **autonomy** is
  deliberately not reproduced (a human decides every jump, which is where every
  other backward jump in this platform is decided), and a target inside a parallel
  section — the per-unit `code-generation` lane of a scope with a unit DAG — is not
  offered, because re-entering a fan-out would have to re-derive the approved unit
  plan; those scopes keep the rewind API. Human-directed rewinds do not count
  against the cap, matching upstream.
- **`learnings: on` runs the ritual INSIDE the approval gate** rather than as
  upstream's separate pre-gate turn. The gate prompt asks "Anything to add for next
  time?", the review panel offers an optional field, and a non-empty answer writes
  a durable project learning (`v2.learning.recorded`; a failed write is
  `v2.learning.record_failed` and never fails the run). An empty answer is an
  explicit, recorded "nothing to add". This is classified `approximated`
  deliberately: a second mandatory human turn per stage across 18–33 stages is
  friction without decision value. `learnings: off` is native: the MCP server
  withdraws `record_team_knowledge` and `record_learning_rule` outright.
- **Advisory findings now reach the human inside the gate.** An advisory verdict is
  carried into the validation prompt's "Findings for your decision" section and
  onto the structured gate row the review UI renders, which is upstream's
  at-the-gate presentation. The `v2.review.advisory` timeline event and the
  durable review note remain as the record.
- **`review_class: adversarial` resumes the lead between rounds, except where it
  cannot.** Each NOT-READY round re-enters the lead's own CLI session for one
  repair turn (the checkpoint repair-turn machinery) before the reviewer re-runs,
  within the stage wall-clock budget. Residual: a codex lead, or any lead with no
  resumable CLI session, gets no repair turn, so its next round re-reviews the
  same revision.
- **Question events carry the attempt.** `v2.question.asked` rows now carry
  `detail.attempt` on every run, pinned or not. Prompts, tool lists and gates stay
  byte-identical for 2.3.3 and unpinned runs; only the event row gains that detail
  field.
- **`maxTurns` is inert on Kiro**, which exposes no turn/step limit. This matches
  upstream, which omits the field for Kiro.
- **`runner` is never acted on.** No convenience runner is generated.
- **SCOPE blocks are read but not pinned.** The per-scope policy is resolved from
  the catalog the plan already resolved; SCOPE is deliberately absent from
  `methodologyPins` and from `methodologySourceRefs`, because adding it would
  change the shape of an already-persisted pin set.
- **The `{{INVOKE}}` dialect is instruction, not emulation.** The annex is a
  CLOSED list: an engine command that is not in it must not be run or
  improvised, only reported. `engine sensor-<id>` binds natively to our own
  sensor runner. `orchestrate report` is suppressed (the platform records
  lifecycle itself). `recompose --add` becomes a prominent structured
  "recommended stage addition" recorded via `emit_stage_note`, with the prompt
  stating plainly that a human must rewind and recompose. `state
set-construction-iteration` records the intended value only.
  `practices-event` / `practices-promote` record a **recommendation for the
  human** — they explicitly do NOT write durable project rules or team
  knowledge, because promotion is a human decision here. The read-only `gen` /
  `codekb` commands are skipped, and the agent is told never to mint a substitute
  identifier (no fingerprints, no scope-diff ids) for a command it did not run.
  A missing engine step is recorded as a GAP; the annex no longer tells the agent
  to treat an unavailable prerequisite as satisfied.

### Where the policy applies

The capability scope/stage policy is applied **only when the methodology library
came from a verified release closure**. The loader that resolved the closure
stamps `library.fromRelease`, and `buildExecutionPlan` also accepts an explicit
`releaseMode` flag; the policy is never inferred from the mere presence of a
capability field.

That gate is load-bearing in two directions. It keeps every legacy/DDB plan
byte-identical — asserted against golden digests computed on the pre-Phase-3 tree
(`lambda/shared/test/aidlc-release-adapters.test.js`), in both modes for the
2.3.3 fixture. And it prevents an UNPINNED, user-edited SYSTEM `SCOPE` row from
retroactively disabling verification on an already-running legacy intent:
`sensors: off` and `review_cap: none` are silent, plan-shaped downgrades that
remove a reviewer or an entire sensor list.

When the policy does remove verification, the plan records it on
`plan.policyEffects` and the runtime emits a `v2.policy.applied` timeline event
naming the reviewer and the sensors that were dropped, so a stage that ran
without the checks its stage block declares is never silent.

### Fail-closed on an unknown value

A capability field whose value is outside the modelled vocabulary is an error, not
a fallback to the default — an unrecognized value means the release drifted from
what these adapters model, and running it as "probably the default" is precisely
the silent divergence the release contract exists to prevent. The analyzer
raises `frontmatter_enum_invalid` (including for a `STAGE.mode` outside the known
set, a non-integer `maxTurns`, and a `review_artifact` that is not one of the
stage's required `produces`), and the plan resolver raises `policy_enum_invalid`
and attaches no policy.

Release-mode body and script reads are fail-closed on integrity too. A stage
body, agent persona, support persona, reviewer persona, rule body, or sensor
script resolved from a release is verified against the closure's recorded sha256
before it reaches a prompt or a spawn, and a mismatch fails the STAGE
(`methodology_body_unavailable`) instead of degrading to an empty string. A
sensor script is executed inside the session, so a tampered one is arbitrary
code execution, not merely a wrong verdict.

## Release registry and channels

The release registry stores an admin-controlled support decision and optional
channel pointers in the blocks table:

| Item                                       | Meaning                                                   |
| ------------------------------------------ | --------------------------------------------------------- |
| `AIDLC_RELEASE#<releaseId>` / `META`       | One registered release and its support decision.          |
| `AIDLC_RELEASE_CHANNEL#<channel>` / `META` | A pointer naming one release as stable/candidate/preview. |

Release records are listed through GSI1 (`AIDLC_RELEASES`) with a sort key of
`<zero-padded upstreamVersion>#<releaseId>`, so an index scan is also a version
ordering and `2.10.0` sorts after `2.9.0`.

The registry is a **selection gate, not an execution input**. No execution path
reads a registry row: `release-resolver.js` still resolves a pinned closure
straight from S3. Demoting, hiding, or moving a release to `existing-only`
changes what new intents may pick and never changes what an existing intent
runs. That separation is what makes `existing-only` usable at all.

`registerRelease({ profileId })` reads the published manifest for an allowlisted
profile's `upstreamRef` at the current importer revision, fails with
`release_not_published` when there is none, and writes a record that carries
**evidence only**:

- `supportState` is `structurally-valid` when the manifest's compatibility
  evidence says so, and `importable` otherwise. It is never higher.
- `visible` is `false`.
- `runnable` is decided once, from provenance: an allowlisted official profile
  above T0. Custom, preview, and T0 content is non-runnable and no later patch
  can change that.

Registration is idempotent under a conditional `attribute_not_exists` put: the
same closure returns the existing record, a different closure under the same
release id fails with `release_conflict` rather than overwriting an identity.

A record registered before an importer bump points at the older revision's
closure. Re-registering it fails with `release_conflict` (a different closure
under the same id) and names the upgrade path instead; see
[Closure upgrades](#closure-upgrades).

`updateRelease` is the only mutation of a support decision, and it may change
only `supportState`, `visible`, and `notes`. It is a compare-and-swap on an
integer `revision`; a stale `expectedRevision` fails with
`release_revision_conflict` instead of clobbering the concurrent winner.
Promotion to `certified` or `selectable` additionally requires a `runnable`,
structurally valid release — otherwise `release_not_selectable`. `certified`
records its claimant as `certifiedBy`/`certifiedAt`, because it is a reviewer's
label, not a computed property; leaving `certified` clears both, so a later
re-promotion cannot inherit evidence from a decision that was already revoked.

Before a release becomes selectable or certified, the registry checks that the
running build can honour its authored frontmatter values and every protocol
capability present in its runtime files. Unsupported values fail with
`release_capability_unhandled` and identify the block type, field, and value.
Evidence is re-derived from the verified immutable closure, including for legacy
records without cached evidence. Closure upgrades and channel changes use the
same check; a closure that adds behavior this build cannot honour is not made
available to new intents. Certification remains an admin-recorded decision; the
service does not validate a separate runtime-evidence artifact.

### Channel pointers are a promise, so demotions are refused

A channel pointer asserts that its target is selectable, and intent creation
reads it. Demoting or hiding a channel target therefore does not merely narrow
what new intents may pick — it stops new intents from being created at all.

`updateRelease` refuses any transition that would strand a pointer, with
`release_channel_pinned` (HTTP 409):

- the release would stop being `runnable`, `visible`, and `selectable`/
  `certified`, while any channel names it; or
- the release is the `stable` target and would stop being certification-eligible.

The check is not merely a read-then-write: the write is a `TransactWriteCommand`
whose other items are `ConditionCheck`s asserting that each channel the _new_
state would not satisfy still does not point at this release. A concurrent
`setChannel` cannot slip a pointer in between the check and the write. Channels
the new state does satisfy are left unconstrained, so an ordinary `notes` edit on
a channel target still succeeds.

The exit is `clearChannel`, a CAS delete of the pointer row. The intended
sequence is therefore **clear the pointer, then demote** — never a forced
demotion that leaves the platform unable to create intents.

`setChannel` moves a pointer under the same CAS discipline (`expectedRevision:
null` asserts the pointer does not exist yet; the field must be **present**, as
an absent one would silently turn a stale update into a create). The target must
already be `runnable`, `visible`, and `selectable` or `certified`, so a channel
can never widen a support state — it only names a release an admin already
approved. The pointer write and the target release's `revision` are asserted in
one transaction, so a release demoted between the read and the write cannot
produce a published pointer to a non-selectable release
(`release_revision_conflict`).

`stable` is additionally restricted to a `certified` release, with one
documented exception: the profile flagged `currentPlatformBaseline` may hold
`stable` while it is merely `selectable`. That profile is what every unpinned
intent already runs today, so demanding fresh T3 certification evidence before
it can be named `stable` would leave the channel empty and make the default
worse than the status quo. Every other release must be certified.

`resolveSelectableRelease({ releaseId })` is the gate new-intent creation calls.
An explicit id must resolve to a registered, selectable release; an unknown or
demoted id is rejected (`release_not_found` / `release_not_selectable`) and never
silently substituted. With no id the stable channel decides, and an unset stable
channel returns `null` — not an error, but "the platform has not opted into
release-based selection", which keeps the caller's pre-existing behaviour.

A stable pointer whose target is **not selectable** also degrades to `null`, with
a warning log. `updateRelease` refuses to create that state, but a restored
backup or a hand-edited row can, and an implicit fallback must never be able to
fail intent creation platform-wide. Stable _eligibility_ (certified or baseline)
is deliberately NOT re-decided here: it is enforced when the pointer is written,
and re-deciding it on every read would let a later policy change retroactively
unpin a channel an admin legitimately set. An explicitly requested id is still
rejected, so no caller silently receives a release it did not ask for.

### Closure upgrades

`upgradeReleaseClosure({ releaseId, expectedRevision, importerRevision })` moves a
registered release onto the closure a newer importer revision published for the
**same** source SHA. It is a pointer move, never a rewrite: both closures stay
published and untouched, existing intents keep resolving the closure their META
row pinned, and only intents created afterwards pin the new one.

It fails closed, in order:

| Check                                                                    | Code                                |
| ------------------------------------------------------------------------ | ----------------------------------- |
| revision strictly newer than the record's, and ≤ the running importer's  | `release_importer_revision_invalid` |
| a manifest is published at that revision                                 | `release_not_published`             |
| the manifest validates (digest, fingerprint, sha, provenance)            | `release_conflict`                  |
| same `releaseId`, `profileId`, `trustTier`, `sourceRepository`, `custom` | `release_conflict`                  |
| a structurally valid record does not move onto an invalid closure        | `release_not_selectable`            |
| no channel pointing at the release is left unsatisfied                   | `release_channel_pinned`            |
| CAS on `revision` AND on the importer revision being replaced            | `release_revision_conflict`         |

Support state, visibility, certification, and runnability are carried over
unchanged — an upgrade is not a support decision. The replaced pointer is kept on
the record as `importerHistory[]`, each entry `{ from, to, upgradedAt,
upgradedBy }` with `importerRevision`, `closureDigest`, `manifestKey`, and
`catalogKey` on both sides. Asking for the revision the record already points at
is an idempotent `already-current` no-op, so an operator can retry safely.

An admin `GET /aidlc-releases` marks every record whose `importerRevision` is
below the running importer's as `importerStale: true` and returns
`currentImporterRevision`; `GET /aidlc-release-profiles` adds
`registeredImporterRevision` and `importerStale`. Non-admin projections carry
neither. A stale release stays selectable — creating an intent on it is allowed
and logs a warning — because it is correct for the bytes it pins, just missing
fields later mappers learned.

The compose reads (`?release=`) resolve the record's current closure by default.
An intent pinned before an upgrade passes its pin's revision as
`releaseImporterRevision=<n>`; only the current closure or one in the record's
`importerHistory` is addressable, and any other value is the same
`404 release_not_found` as an unregistered release.

### Reads are provenance-checked and least-privilege

Two further fail-closed rules cover the read side:

- `readReleaseManifest` asserts that the bytes found at a key actually describe
  the release that key addresses — `sourceSha`, `importerRevision`, and (for a
  custom prefix) `sourceRepository` must all match, or
  `release_manifest_invalid`. `registerRelease` additionally asserts
  `manifest.releaseId === profile.releaseId`, so one release's identity can never
  be spliced onto another's provenance.
- The admin profile listing (`GET /aidlc-release-profiles`) probes keys that are
  usually ABSENT. Without `s3:ListBucket` on the prefix, S3 answers such a GET
  with `403 AccessDenied` rather than `404 NoSuchKey`, which previously turned the
  whole listing into a 500. The probe therefore treats a masked 403 as "not
  published". The blocks role is deliberately **not** granted `s3:ListBucket`: a
  prefix-conditioned grant would not change the GET response, because `s3:prefix`
  is not part of the `GetObject` authorization context, so it would widen the role
  for no effect. The code-side tolerance is the whole fix. It is scoped to the
  probe: every execution path still treats an unreadable manifest as a hard
  failure, because there "cannot read" must never be downgraded to "does not
  exist".

## Intent selection API

The workflows API exposes the registry and channels; the intents API uses the
selection result when creating an intent. Both reuse the platform-admin guard
(`lambda/shared/authz.js`) for administrative operations.

| Route                                      | Access                 | Purpose                                         |
| ------------------------------------------ | ---------------------- | ----------------------------------------------- |
| `GET /aidlc-releases`                      | any authenticated user | list releases                                   |
| `POST /aidlc-releases`                     | platform admin         | register a published release                    |
| `PATCH /aidlc-releases/{releaseId}`        | platform admin         | support-state decision or closure upgrade (CAS) |
| `GET /aidlc-release-channels`              | any authenticated user | the three channel pointers                      |
| `PUT /aidlc-release-channels/{channel}`    | platform admin         | move a pointer (CAS)                            |
| `DELETE /aidlc-release-channels/{channel}` | platform admin         | clear a pointer (CAS)                           |
| `GET /aidlc-release-profiles`              | platform admin         | allowlisted profiles, publish/register state    |

`DELETE /aidlc-release-channels/{channel}` takes `{ expectedRevision: number }`
and returns `200 { cleared: true, channel }`. It is the exit from a channel whose
target an admin now wants to demote (see "Channel pointers are a promise" above).

`GET /aidlc-release-channels` also reports `pinningEnabled: boolean`, mirroring
the `AIDLC_RELEASE_PINNING` flag so the admin UI can state whether the pointers
are being consulted at all. It is advisory: the intents lambda reads its own copy
of the variable, and this route gates nothing on it.

A non-admin `GET /aidlc-releases` is filtered to `visible` records whose support
state is `selectable` or `certified`. Showing an importable or hidden record to a
user would imply it is runnable; the list is limited to visible, runnable
`selectable` or `certified` releases.

Non-admin reads are additionally **projected to selection fields only**:
`releaseId`, `upstreamVersion`, `upstreamChannel`, `profileId`, `supportState`,
`trustTier`, `visible`, `runnable`, and `certifiedAt` when set. Storage keys,
closure digests, source SHAs, and the Cognito subs of whoever registered,
updated, or certified a release are operator data describing platform internals,
not the user's choice. Channel pointers are likewise reduced to
`{ channel, releaseId, revision }`. An admin sees the full record.

`{releaseId}` contains a colon (`aidlc:<sha>`), so callers percent-encode the
segment and the lambda decodes it. Failures return `{ error, code }` with 400 for
a rejected request, 403 for the admin guard, 404 for an unregistered release, and
409 for a CAS conflict — including `release_channel_pinned`.

Intent creation accepts an optional `methodologyReleaseId`. Behaviour is gated by
`AIDLC_RELEASE_PINNING`:

| Flag  | `methodologyReleaseId`     | Result                                                                                                              |
| ----- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `off` | absent                     | unchanged pre-#482 behaviour; no registry row is read at all.                                                       |
| `off` | present                    | `400 release_selection_disabled`.                                                                                   |
| `on`  | absent, stable channel set | the stable release is selected.                                                                                     |
| `on`  | absent, no stable channel  | try a published closure matching the resolved deployment ref, then re-validate the plan; otherwise remain unpinned. |
| `on`  | present                    | that exact release is selected, or the request is rejected.                                                         |

A non-string, non-null `methodologyReleaseId` is `400 release_selection_invalid`
rather than silently ignored: ignoring it would create the intent on the stable
channel (or unpinned) while the caller believes it asked for a specific release.
An explicit `null` means "no selection" and takes the absent-id path.

When a release is selected, the whole create-time validation moves into release
mode: `loadWorkflowScopes` and the `loadExecutionPlan` plan check both receive
the pin, so the scope vocabulary and the stage grid are validated against the
methodology the intent will actually run rather than the current SYSTEM catalog.
`aidlcRepoRef` becomes the release's `sourceSha`, and `methodologyRelease` is
stamped from the registry record. The deployment ref is not resolved over the
network at all in that case — a selected release is the source of truth for the
ref, so an unrelated misconfigured ref cannot 503 the create.

An invalid or unselectable id is a `400` with the registry's code. A selection is
never quietly replaced by a different release, and `methodologyRelease` is part
of the intent detail projection so a client can show what an intent is bound to.

### The auto-pin path re-validates before it commits

When no release is selected but the flag is on, the create still derives a
candidate pin from the deployment ref's published manifest. Everything up to that
point was validated against the **SYSTEM DynamoDB library**, which is not what a
pinned intent runs. So before the pin is stamped, `loadWorkflowScopes` and
`loadExecutionPlan` are re-run in release mode against the candidate closure:

- both reproduce the scope and the plan → the pin is stamped, and the persisted
  `methodologyPins` come from the release-mode plan;
- either one cannot → a warning is logged and the intent is created **UNPINNED**,
  on exactly the legacy DynamoDB path it would have used before #482.

A `201` followed by a permanent `plan_invalid` on every run is the one outcome
this path must never produce, so the fallback is always "stay unpinned" rather
than "stamp it anyway".

### Release-mode intents persist no SYSTEM pins

Every block in a release closure carries `tenantId: SYSTEM` and `version: 1` by
construction. Those are precisely the coordinates a SYSTEM reseed rewrites in
place, so persisting them as pins is worse than useless — the pin would point at
whatever the reseed left behind, while the release pin on the META row already
names the exact immutable closure. In release mode the persisted
`methodologyPins` therefore contain **only genuine user-tenant overlay pins**; a
type with none is omitted rather than recorded as an empty map.

Native-export compatibility classification follows the same rule: for a
release-pinned intent, `findNativeIncompatibleBlocks` classifies against the
closure plus its overlay pins rather than the live merged catalogs, which the
intent never reads.

### Release-correct compose reads

A release-pinned intent's compose page must show the scopes and stage grid of the
methodology it will run. `GET /workflows/{id}/compiled`,
`GET /workflows/{id}/execution-preview`, and `POST /workflows/{id}/validate-grid`
therefore accept an optional `release=<releaseId>` query parameter that resolves
the view from that closure instead of the live SYSTEM rows; the `compiled`
response additionally carries the closure's own `phases`, so a pinned client
needs no second request. Omitting the parameter leaves every caller on its exact
prior behaviour.

The id must name a **registered** release, and the closure resolver re-verifies
every digest, so this cannot be used to read arbitrary bucket content. Who may
name which release is a separate decision from what the pin resolves to:

- a **platform admin** may name any registered release in any support state — an
  existing intent may be pinned to a demoted one, and the admin UI has to be able
  to inspect it;
- a **non-admin** may only name a release that is selectable (runnable, visible,
  `selectable`/`certified`) — exactly the set `GET /aidlc-releases` and the intent
  picker already show them. For a non-admin, "not registered" and "registered but
  not selectable" return the SAME `404 release_not_found`, so the parameter cannot
  be used to enumerate the registry.

The caller's access to the workflow is asserted before the release is used, with
the same `resolveWorkflow(tenant, workflowId)` lookup the non-release path
performs, and an invisible workflow answers with the identical `404 Not found`
body. An unresolvable or tampered closure is `409`. There is no fall back to the
live rows, which are exactly the methodology the caller asked not to see.

**Residual: the release compose view shows the release closure only.** A pinned
intent may additionally carry per-intent user-tenant methodology overlay pins,
and `buildExecutionPlan` applies them at execution time. The compose preview does
not: `?release=` resolves the closure plus nothing else, because the overlay is
intent state and accepting it from the query string would let a caller assemble an
arbitrary library in a read that is otherwise digest-verified end to end. A stage
an overlay pin replaces therefore renders at its closure version in the preview
and runs at its pinned version. Closing this means reading the overlay from the
intent server-side, which is deferred.

`loadPlanInputs` loads `SCOPE` blocks on the release branch only. The per-scope
execution policy releases ≥2.6.18 author is gated on `library.fromRelease`, which
only a resolved closure sets, so loading SCOPE blocks on the DynamoDB branch would
buy a query no consumer can read.

The registry is consulted at intent creation, not during execution. Existing
intents continue to resolve their persisted closure pin.

## Runtime gates and persona sessions

Pinned runs enforce authored execution semantics through capability-driven
policies, attempt-scoped receipts, structured findings, and release-mode persona
sessions. A check proceeds, opens an actionable gate, or fails rewindably.

### The primitive: an attempt-scoped, content-bound receipt

Upstream proves its semantics with files under `.aidlc-engine/**` plus PreToolUse
hooks. This platform has neither, and its timeline is the primary record. Every
remaining gap reduced to the same missing thing:

> an attempt-scoped, content-bound receipt, written through the platform, that a
> single gate-precondition evaluator consults before a gate opens or a stage
> completes.

Receipts are a `RECEIPT#` item family in the process table, keyed
`RECEIPT#<kind>#<stageInstanceId>#<attempt>#<unitSlug|->[#<ordinal>]`, with kinds
`summary-confirmation`, `plan-approval`, `pipeline-link`, `sensor-override`,
`stage-approval`, `change-reconfirm` and `persona-contribution`. There is no
on-disk mirror.

`attempt` is read from the `STAGE#` row the platform already maintained and
already bumped on rewind. That single fact buys upstream's "a rejection, jump or
restart invalidates prior receipts" for free: a rewind or a loop-back bumps the
attempt, and every earlier receipt becomes unreachable without anything being
deleted. Writes are idempotent on the deterministic sort key, so a durable replay
is a no-op rather than a conflict.

Three rules follow, and each is asserted by test rather than by convention:

1. **Trust boundary.** Receipts and tool restrictions are workflow controls, not
   an isolation boundary against a compromised AgentCore runtime identity. That
   runtime identity remains trusted.
2. **Everything is bounded, on persisted state.** Repair turns ≤1 per checkpoint
   per attempt, mob dissent rounds ≤2, and persona retries ≤1. Loop-backs are
   limited to three per intent through one execution-level tally shared across
   its stages.
3. **Three outcomes, never a fourth.** Every new check ends in `proceed`, a human
   gate with at least two actionable options, or a `fail()` whose code is in the
   rewind-eligible set. No path leaves an intent `WAITING` with nothing to answer.

### Checkpoints: `confirm_summary` and `request_plan_approval`

A checkpoint is an `ask_question` with three things the platform owns instead of
the agent: the two exact option labels, the receipt the positive label writes, and
the digest binding that receipt to the content the human actually saw. Owning the
labels server-side is what lets the completion ladder tell "this was THE
confirmation" from "this was an ordinary question" without matching prose.

Tool availability is the enforcement seam, not prompt prose: `confirm_summary` is
registered only when the resolved policy's `summaryConfirmation` needs it,
`request_plan_approval` only where Plan Approval applies, and `learnings: off`
WITHDRAWS `record_team_knowledge` and `record_learning_rule` outright. A null
policy — 2.3.3 or unpinned — changes nothing, which keeps the registered tool list
byte-identical for those runs.

Both checkpoints park and resume through the same durable-callback path as every
other gate, so a checkpoint answered in a different container than the one that
raised it still mints its receipt: the bridge rehydrates the active authorization
from durable state at construction rather than trusting process memory.

The completion ladder persists its per-attempt repair counter before it starts a
repair turn. If that write fails, the stage fails rewindably with the original
checkpoint finding; it does not run an uncounted repair or report success.

### Gate findings and `override-and-approve`

`lambda/shared/gate-preconditions.js` is the single evaluator. It runs when a
validation gate opens, re-reading receipts and stamps from durable state rather
than trusting the stage result, and returns structured findings each carrying a
code, a severity and a remediation: `required_artifact_missing`,
`summary_confirmation_missing`, `summary_confirmation_stale`,
`plan_approval_missing`, `persona_contribution_missing`,
`pipeline_link_incomplete`, `stage_budget_exhausted`, `review_advisory_findings`,
`review_dissent_maintained`, `change_control_input_changed`,
`sensor_gate_blocking`, `sensor_gate_advisory`.

The evaluator combines artifact, checkpoint, review, and sensor findings and
determines whether the gate blocks or allows an override. The orchestrator
presents the findings at the validation gate; an allowed override is recorded
with a receipt and timeline event.

Findings reach the human in the gate prompt AND on the structured gate row the
review UI renders. A blocking finding a human may take responsibility for adds a
third `override-and-approve` option, which writes a receipt and a
`v2.gate.override` event naming the finding codes, the person, and — when a sensor
was overridden — the sensor ids, results and reasons as a queryable sub-object. A
blocking finding that is NOT overridable withholds plain `approve` instead,
leaving `request-changes`, which re-runs the stage. No gate ever has nothing to
choose.

`required_artifact_missing` is blocking AND overridable (receipt kind
`stage-approval`): a declared output the platform cannot map, or one the human
judges unnecessary, must never produce a gate whose only option is
`request-changes`, forever. The override names the artifact on the receipt and the
`v2.gate.override` event.

The review panel requires a reason (at most 300 characters) before it sends
`override-and-approve`; the engine stores it as `detail.reason` on every override
receipt and on the `v2.gate.override` event. The engine itself is tolerant: an
answer without a reason records `reason: null` rather than refusing the override.
A loop-back is confirmed in the UI naming the target, the stages it re-runs (the
gate row's `loopBackStages`) and the approvals it invalidates.

The gate `kind` union the frontend closes over is untouched: every new gate reuses
`question` or `validation`.

### The gate sensor plane

`fire_on: write` narrows the post-agent sweep to the files this stage attempt
actually changed. `fire_on: gate` is a SEPARATE pass that runs after the reviewer
loop resolves, sweeping every declared deliverable on the final bytes the human is
about to approve. A blocking gate verdict holds the stage's human gate; an ungated
stage halts. A sensor whose plane has nothing to inspect records `INCONCLUSIVE`
with `detail.notApplicable` rather than a fifth verdict value, because widening
`SENSOR_RESULT` would change how every historical `SensorRun` row is read.

### Ensemble persona sessions

`pipeline`, `mob`, and `subagent`-with-supports dispatch one real CLI session per
persona in release mode, each with its own brief, its own MCP role and its own
durable evidence: contributions carrying the server-owned `collaborator` property
and AGREE/OBJECT positions, per-link `RECEIPT#pipeline-link#…#<ordinal>` rows, and
bounded dissent triage. The markdown `**Collaborator:**` line is display text, not
evidence identity. Receipts are attempt-scoped, so a park/resume within one attempt
skips the personas that already produced evidence while a rewind re-dispatches the
whole topology in order.

`get_team_knowledge` and `record_team_knowledge` use the project's shared
knowledge. Persona identity scopes authorship; it does not create a private
knowledge namespace for each persona.

Contribution identity is trusted, never agent-asserted. Every release-mode author
session — each dispatched persona AND the lead — carries its own `agentRef` on its
MCP scope, and graph-writer lets it create or update only the `contribution` head
whose id exactly matches `contributionArtifactId({ stageId, agentRef })` and whose
logical key includes that persona: `collaborator` is forced to it and `status` is
server-owned, so no session can forge a peer's evidence, flip a peer's OBJECT, or
turn a gap stub into evidence. Only the platform's own writer (`systemWriter`)
records a gap stub for another persona; a release-mode session with no identity is
refused. These identity checks apply through supported tool calls and do not
change the trust boundary above. Unpinned and 2.3.3-era runs keep their previous
writer behaviour and a byte-identical MCP config.

One wall-clock budget (6.5 h, `STAGE_BUDGET_MS`) bounds every persona session and
lead repair turn a stage attempt runs, measured from that attempt's start in the
current invocation — never from the container's age, so a reused long-lived
container does not start a stage already spent. A timed-out CLI child is killed
and its exit awaited before a retry or gap. A session past the aggregate budget
degrades to a gap and `stage_budget_exhausted` names it. That finding is advisory
while some collaborator evidence exists; when the cut left none at all, it blocks
overridably (receipt kind `stage-approval`), so approving what ran as a single
session is a recorded waiver.

`V2_ENSEMBLE_SESSIONS` defaults to `on` and affects release-pinned intents only;
release pinning itself defaults to `off`. Setting the ensemble switch to `off`
reverts pinned ensemble stages to the single-session prompt byte for byte. It is
an operational escape hatch and needs no orchestrator redeploy, only a container
environment change and restart.

`mode: subagent` changed meaning upstream. Up to 2.3.3 it is one delegated
session for the lead, whose support agents are perspectives it adopts; from the
release that ships `core/aidlc-common/protocols/stage-protocol-ensemble.md`
(2.6.18 on) it is hub-and-spoke with separate support sessions. The runtime keys
on that file in the pinned closure, so a 2.3.3-pinned `subagent` stage keeps its
single session. `pipeline` and `mob` only exist in releases that ship the
protocol, so they are not gated on it.

`agent-team` remains explicitly unimplemented because it requires concurrent
sessions. Build-and-Test loop-back is a separate runtime behavior; persona
sessions do not add a loop-back gate option.

### Change control

A validation gate approval freezes the content fingerprints of what the stage
produced onto its `stage-approval` receipt. The next stage compares its required
inputs against those fingerprints BEFORE the agent runs. `relaxed` appends a
deduplicated `v2.change.accepted` and continues; `strict` opens a two-option
question gate (reconfirm, or stop so the human can rewind) whose halt is the
rewind-eligible `change_control_halt`.

Upstream defaults an omitting scope to `strict`. Defaulting that unconditionally
would be wrong for 2.6.18/2.7.0, which have no change control at all, so the
default is gated on the CATALOG proving it has the capability — at least one
`SCOPE` in this closure authors the field. No version string is involved.

After a human reconfirms, the stage does not spawn its CLI until the
attempt-scoped `change-reconfirm` receipt is persisted. A failed receipt write
returns a rewindable FAILED state; an existing receipt for the same attempt
continues idempotently without asking again.

### The learnings ritual

`learnings: on` asks "Anything to add for next time?" inside the approval gate the
stage already has. A non-empty answer writes a durable project learning
(`v2.learning.recorded`; a failed write is `v2.learning.record_failed` and never
fails the run), and an empty answer is an explicit, recorded "nothing to add". A
second mandatory human turn per stage across 18–33 stages would be friction
without decision content, which is why this is `approximated` by choice.
The orchestrator sends the answer through AgentCore's `record-learning` command,
which is registered by the HTTP dispatcher alongside the other runtime commands.

### The skeleton switch

`skeleton: off` skips the walking-skeleton solo pass and its `eg-skeleton-*` gate,
recording `v2.units.skeleton_skipped`; the first construction stage keeps its
ordinary approval gate. `on` keeps the ceremony.

### The Build-and-Test loop-back

A build-and-test agent that finds a defect in the generated code must neither fix
it itself nor fail. It records a recommendation through `emit_stage_note`'s
`loopBackRecommended` field; the platform turns that into a typed
`v2.loopback.recommended` event stamped with the attempt from the trusted
container scope; and the validation gate then carries a third `loop-back` option
naming the target the plan computes. Choosing it resets the `STAGE#` rows from the
target through the current stage — bumping their attempts, and with them
invalidating every plan-approval and review receipt from that pass — emits
`v2.loopback.recorded`, and moves the walk back. Three per intent, tracked in one
execution-level tally shared across its stages; at the cap the option is withheld
and the gate says so.

### The resume endpoint and the anti-stuck rule

A durable callback that failed to resume for any reason other than a timeout used
to leave an intent parked with an answered gate and nothing to click. The answer
path now records `META.resumeRequired` with the gate and callback ids, the intent
view surfaces "Your answer was saved but the run did not continue", and
`POST /projects/{projectId}/intents/{intentId}/resume` completes the callback. A
callback that has genuinely expired is repaired into a FAILED execution the rewind
endpoint accepts, rather than a WAITING one nobody can move.

That is the third outcome made operational: together with the bounded ladders
above, no runtime check can produce an intent that is waiting on nothing.

### Operator notes

- **Nothing here activates without a release pin.** Every mechanism above is gated
  on `library.fromRelease` (or an explicit `releaseMode`) AND on the field being
  authored by the resolved catalog. An unpinned or 2.3.3-pinned intent gets the
  pre-Phase-6 behaviour, which the golden digests in
  `lambda/shared/test/aidlc-release-adapters.test.js` prove byte for byte.
- **`V2_ENSEMBLE_SESSIONS=off`** reverts ensemble stages to the single-session
  prompt without a redeploy.
- **A hand-edited `methodologyRelease` pin fails loudly.** Every capability the
  plan resolves must name a runtime seam this build implements; one that does not
  fails the stage with `capability_unhandled` before any agent work, rather than
  running with the semantic silently missing.
- **New timeline event types to expect on a pinned run:** `v2.summary.requested` /
  `v2.summary.confirmed` / `v2.summary.changes_requested`, `v2.plan.requested` /
  `v2.plan.approved` / `v2.plan.changes_requested`, `v2.artifact.stamped`,
  `v2.gate.override`, `v2.change.accepted`, `v2.persona.contribution` /
  `v2.persona.link_completed` / `v2.persona.dissent` / `v2.persona.gap`,
  `v2.learning.candidate` / `v2.learning.recorded` / `v2.learning.record_failed`,
  `v2.units.skeleton_skipped`, `v2.loopback.recommended` / `v2.loopback.recorded`.
  None of them appear on an unpinned run.
- **Reading the audit trail.** "Was this stage's output authorized?" is answered by
  the `v2.artifact.stamped` events plus the `RECEIPT#` rows for the stage's CURRENT
  attempt. A receipt from an earlier attempt is deliberately invisible, and that is
  the record of an invalidation rather than a gap.

## Custom forks

A custom fork of `aidlc-workflows` can be imported and inspected. It can never
be run. That is a deliberate gate, not a missing feature: executing third-party
methodology means executing third-party sensor scripts and engine files with the
platform's own IAM identity, so custom content stays import-only until sandboxed
execution and IAM isolation exist.

Identity. A fork is identified by `owner/name` plus an exact 40-hex commit SHA.
Branches and tags are refused for a custom source because they are mutable and
under third-party control, so they cannot be a release identity. Both halves of
the slug are validated against the strict GitHub name grammar
(`lambda/shared/aidlc-custom-source.js`) before they reach a URL or an S3 key.
The official repository is refused as a custom source — use its allowlisted
profile instead.

Profile. `customProfile({ repository, sha, baseProfileId })` synthesizes a frozen
profile with id `custom:<owner>/<name>@<sha>`, release id
`aidlc-custom:<owner>/<name>@<sha>`, `upstreamChannel: 'custom'`, `trustTier:
'T0'`, and `custom: true`. `baseProfileId` must be an allowlisted official
profile and decides one thing only: the frontmatter dialect the fork is parsed
with. It grants no trust and no support state. Custom profiles are deliberately
absent from `AIDLC_COMPATIBILITY_PROFILES`, so `profileFor` can never return one
— the analyzer and the bundle builder accept an explicit `profile` object
instead.

Import via the seed lambda. Custom bytes land on their own prefix,
`aidlc-releases/v1/custom/<owner>/<name>/<sha>/i<importerRevision>/`, which can
never collide with the official `aidlc-releases/v1/<sha>/i<n>/` layout. Preview
first with `dryRun`:

```bash
aws lambda invoke \
  --function-name $(terraform output -raw seed_blocks_lambda_name) \
  --payload '{"importRelease":true,"custom":{"repository":"acme/aidlc-workflows-fork","sha":"0123456789abcdef0123456789abcdef01234567","baseProfile":"v2.9.0"},"dryRun":true}' \
  --cli-binary-format raw-in-base64-out /tmp/out.json
```

Drop `"dryRun":true` to publish. `custom` and `profile` are mutually exclusive,
and the mode still refuses `ref` and `reseed`. Publication is as fail-closed as
an official import: an un-importable or structurally invalid fork never reaches
storage.

Register via admin. `POST /aidlc-releases` with
`{"custom":{"repository":"…","sha":"…","baseProfile":"…"}}` (platform-admin)
records the published closure. The record is `runnable: false`, `trustTier:
'T0'`, `custom: true`, invisible, and at best `structurally-valid`. There is no
parameter that can override that: `updateRelease` refuses `selectable` and
`certified` for a non-runnable record, `setChannel` refuses a non-selectable
target, and the AI-DLC versions admin tab shows the record with an
"import-only, not runnable" badge while every selector omits it.

Never runnable. Selection and execution are separate surfaces, so the execution
path re-decides runnability from the manifest itself: `loadReleaseClosure`
throws `release_not_runnable` when `manifest.trustTier === 'T0'` or
`manifest.custom === true`. A hand-edited `methodologyRelease` pin on an
execution META row therefore still cannot start a custom release.

## Offline compatibility fixtures

The repository carries five compact, reviewable compatibility fixtures under
`lambda/shared/test/fixtures/aidlc-compatibility/`. They preserve exact
frontmatter and runtime import edges while replacing upstream prose and
implementation bodies with deterministic placeholders. Each fixture records
the original SHA-256 digest for every upstream `core/**` file. Each retained
projected file also carries a digest of its redacted fixture content, and the
profile registry pins a canonical digest of the complete fixture. The first
digest records upstream provenance; the latter two detect local evidence
tampering.

| Profile          | Exact upstream commit                      | Fixture use               |
| ---------------- | ------------------------------------------ | ------------------------- |
| `current-stable` | `83ed7a812c4024904f2c5e4d744e28077e0a5acd` | Current platform baseline |
| `v2.6.18`        | `fbb1460c5225657dac7f5a025657785751b41634` | Compatibility fixture     |
| `v2.7.0`         | `96b11d39028955d4f92375e783525db5275cdfd8` | Compatibility fixture     |
| `v2.8.2`         | `355903d6dc8eb07d3c77180be5d40ed679d6a40f` | Compatibility fixture     |
| `v2.9.0`         | `22f5d1b15a064c9ae80046e5b1761d5877e2f69f` | Compatibility fixture     |

All five profiles are T1 (source-pinned). Structural validity and the automated
compatibility signal are derived separately; neither records an administrator's
certification decision.

Run the offline compatibility checks with:

```bash
npm run test:aidlc-compatibility
```

Regenerate all fixtures from their allowlisted commits with:

```bash
npm run aidlc:compatibility:snapshot
```

Regeneration prints each canonical fixture digest. If an intentional projection
or profile change alters a fixture, review that diff and update the matching
`fixtureDigest` in `lambda/shared/aidlc-compatibility-profiles.js` in the same
change. Offline tests reject fixtures whose projected bytes do not match that
trusted registry digest.

The analyzer reports parsing diagnostics, profile-specific normalization,
unmapped fields, sensor dependency closure, scope discovery, and structural
plan results. Structural validity is evidence only: it does not certify sensor
timing, runtime behavior, persistence, export, migration, or custom-fork
execution.

## Operator runbook

Everything below is the day-2 operational path for release coexistence: how to
enable it, what it does when it degrades, and how to roll it back. All CLI
examples assume the deployment's Terraform project directory (for
`terraform output`) and platform-admin credentials for the admin API calls.

### Enable sequence

Releases move through five ordered steps. Each step is independently
verifiable, and nothing earlier in the chain is affected by a later step being
missing — a half-completed rollout is safe, it just offers nothing new.

1. **Import (publish) the closure.** The seed lambda's `importRelease` mode
   fetches the allowlisted upstream commit and writes its immutable closure to
   S3. Always preview with `dryRun` first:

   ```bash
   aws lambda invoke \
     --function-name $(terraform output -raw seed_blocks_lambda_name) \
     --cli-binary-format raw-in-base64-out \
     --payload '{"importRelease":true,"profile":"<profileId>","dryRun":true}' /tmp/out.json
   ```

   Re-run without `"dryRun":true` to publish. Publication is fail-closed: an
   un-importable or structurally invalid profile never reaches storage.

2. **Register the release** (admin UI "AI-DLC versions" tab, or
   `POST /aidlc-releases` with `{"profileId":"<profileId>"}`). Registration
   records import evidence only — the record starts non-offerable.

3. **Decide the support state.** Use the admin tab to mark the release
   `selectable` or record an admin certification decision. Only a visible,
   runnable record in either state can be offered to a new intent.

4. **Point a channel (optional).** Set `stable`, `candidate`, or `preview` to a
   release. When set, `stable` is the default for new intents. With no stable
   channel, creation can auto-pin a published closure matching the configured
   deployment ref after release-mode plan validation. Stable requires
   certification, except for the current platform baseline. Channel moves never
   touch existing intents.

5. **Enable pinning and apply Terraform.** Set
   `aidlc_release_pinning = true` in the deployment's
   `terraform/environments/<environment>.tfvars`, then run:

   ```bash
   ./scripts/deploy-terraform.sh <environment> --phase apply
   ```

   This sets `AIDLC_RELEASE_PINNING` on the intents/workflows lambdas. Until the
   apply completes, the registry is inert for users and creation keeps the
   legacy platform-baseline behavior.

### Upgrading a release closure after an importer change

A deployment that bumps `AIDLC_RELEASE_IMPORTER_REVISION` changes how the block
mappers shape a catalog. Every closure published by the previous importer stays
exactly as it was — existing intents are pinned to those bytes — but new intents
created on those records miss every field the new mappers read. The admin tab
shows such records as **stale closure (importer i<n>)**.

Per registered release, after the new code is deployed:

1. **Preview the re-import.** Same `importRelease` mode, asserting the revision
   the running importer produces (a payload written for a different deployment
   then fails instead of publishing an unexpected prefix):

   ```bash
   aws lambda invoke \
     --function-name $(terraform output -raw seed_blocks_lambda_name) \
     --cli-binary-format raw-in-base64-out \
     --payload '{"importRelease":true,"profile":"<profileId>","importerRevision":2,"dryRun":true}' /tmp/out.json
   ```

   Check `importerRevision`, `manifestKey` (`…/i2/manifest.json`), and
   `mapperFingerprint` in the output.

2. **Publish it.** Re-run without `"dryRun":true`. `status` is `published` the
   first time and `already-published` on a retry. The new closure lands under
   `aidlc-releases/v1/<sha>/i2/`; nothing under `…/i1/` is written or read.

3. **Upgrade the registry record.** Admin tab → **Upgrade closure** on the stale
   row, or:

   ```bash
   curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     "$API_BASE/aidlc-releases/$(jq -rn --arg id 'aidlc:<sha>' '$id|@uri')" \
     -d '{"expectedRevision":<record revision>,"importerRevision":2}' | jq .
   ```

   `expectedRevision` is the record's current `revision` from
   `GET /aidlc-releases`. The response is `{ status: "upgraded", release }`, with
   the previous pointer under `release.importerHistory`. A retry answers
   `already-current`. A `400 release_not_published` means step 2 has not run for
   that profile.

4. **Verify.** `GET /aidlc-releases` shows `importerStale: false` and the `i2`
   keys; a new intent's `methodologyRelease.importerRevision` is `2`; an intent
   created before the upgrade still shows `1` and keeps running.

Custom fork records upgrade the same way, publishing with the `custom` payload
plus `"importerRevision":2`.

Between deploying the new importer and step 2, the **derived** auto-pin (flag
on, no stable channel) finds no manifest at the new revision and leaves new
intents unpinned with a warning, exactly as for any unpublished release. An
explicit selection or the stable channel keeps pinning the stale record's
closure. Run step 2 for every profile promptly after the deploy.

Nothing needs rolling back to undo an upgrade: both closures stay published.
Existing intents are unaffected either way. There is deliberately no downgrade —
a record only moves forward — so a regression in the new closure is handled by
demoting the release (`existing-only`) or moving the channel, like any other.

Bumping the importer (developers): increment `AIDLC_RELEASE_IMPORTER_REVISION`,
pin the new fingerprint in `AIDLC_RELEASE_MAPPER_FINGERPRINTS` (the failing
`aidlc-release-importer` test prints it), and add the new revision's per-fixture
catalog goldens. Never edit an existing revision's entry.

### Auto-pin fallback behaviour

With the flag on, an intent created without an explicit version first uses the
stable channel when one is set. Otherwise, it can derive a candidate pin from
the configured deployment ref. Degradations are deliberate and non-fatal:

- No stable channel and no published closure for the deployment ref, or a
  candidate closure that cannot reproduce the plan → the intent is created
  **unpinned** (legacy behavior) with a warning in the lambda logs. An invalid
  stable target resolves to no release; creation does not substitute a different
  registry release.
- The registry being unreachable from the frontend hides the version selector
  entirely — creation falls back to the legacy path.
- If the flag flips off between page load and submit, the create retries once
  without the pin (`release_selection_disabled` handling in the UI).
- An auto-pin that fails release-mode plan validation leaves the intent
  unpinned rather than failing after creation.

### Rollback

Turning `AIDLC_RELEASE_PINNING` off and redeploying is the safe rollback: new
intents return to the platform baseline while existing pinned intents keep
running from their immutable closures. Rolling application code back to a
version without release support is not safe until every pinned intent has
finished or been cancelled, because that code cannot resolve the release
closures referenced by those intents' META rows. To retire a release from new
intents without a flag change, set its support state to `existing-only` (or
clear/move the channel that points at it).

### Deploying while intents are running

A validation gate persists the options and findings it was opened with. A run
that was already waiting on a gate when a new build is deployed therefore keeps
that gate's options, even if the new build would compute different ones (for
example, a fix that makes a finding overridable). Two ways to re-evaluate:

- answer the gate with `request-changes` — the stage re-runs and the next gate
  is computed by the running build; or
- rewind the intent from that stage (`POST .../rewind`), which relaunches the
  orchestrator on the current build.

Neither loses work: rewind archives artifact heads first, and the stage's
committed code stays on its branch.

### IAM propagation on the first seed after a role change

The seed lambda and the intents/workflows lambdas read the release prefix
(`aidlc-releases/v1/...`) with scoped S3 grants. After a Terraform apply that
swaps or extends those role policies, the first `importRelease` or
release-listing call can still see `AccessDenied` for a short window while IAM
propagates. Retry after a minute before diagnosing further; probe-path 403s on
`GET /aidlc-release-profiles` are reported as "not published", not as errors.

### Custom forks

Forks of `aidlc-workflows` are import-only, forever T0, and never runnable or
selectable (see [Custom forks](#custom-forks)). Publish with the `custom` mode
(`repository` = exact `owner/name`, `sha` = full 40-hex commit, `baseProfile` =
the official profile whose frontmatter dialect the fork is parsed with):

```bash
aws lambda invoke \
  --function-name $(terraform output -raw seed_blocks_lambda_name) \
  --cli-binary-format raw-in-base64-out \
  --payload '{"importRelease":true,"custom":{"repository":"owner/name","sha":"<40-hex>","baseProfile":"v2.9.0"},"dryRun":true}' /tmp/out.json
```

Register it from the admin tab afterwards. There is no supported way to make a
fork offerable to a new intent.

### Certification bar

`certified` is an admin-recorded decision. The service enforces that the release
is runnable and structurally valid and that the current build honours its
authored capabilities. `readyForCertification` is an automated field-level
signal, not proof that every protocol is reproduced; the service does not
validate a separate runtime-evidence artifact. Record operational review and
known limitations in the release notes.

### Runtime operational knobs

Day-2 reference for runtime and selection knobs.

| Knob                                  | Where                                                                                   | Default                                | Effect                                                                                                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `V2_ENSEMBLE_SESSIONS`                | Terraform variable `v2_ensemble_sessions`, wired into the AgentCore runtime environment | `on`                                   | Applies only to release-pinned intents; release pinning itself defaults to `off`. `off` reverts pinned `pipeline`/`mob`/`subagent`-with-supports stages to the single-session prompt byte for byte — no orchestrator redeploy, only a container environment change and restart.     |
| Resume endpoint                       | `POST /projects/{projectId}/intents/{intentId}/resume`                                  | n/a                                    | Completes a durable callback that answered but did not resume (`META.resumeRequired`). A genuinely expired callback is instead repaired into a FAILED execution the rewind endpoint accepts.                                                                                        |
| `override-and-approve`                | Gate option, added only when a blocking finding is itself overridable                   | n/a                                    | Records a receipt plus a `v2.gate.override` event naming the finding codes, the person, and (for a sensor override) the sensor ids/results/reasons. A blocking finding that is NOT overridable withholds plain `approve` and leaves `request-changes` only.                         |
| Build-and-Test loop-back              | Gate option `loop-back`, offered by the validation gate build-and-test already has      | cap 3 per intent                       | Uses one execution-level tally shared across the intent's stages. Resets the `STAGE#` rows from the computed target through the current stage, then moves the walk back. Withheld past the cap; not offered into a parallel section. Human-directed rewinds never count against it. |
| `SCOPE.change_control` strict default | Registry `defaultWhenAbsent` in `lambda/shared/aidlc-capabilities.js`                   | inert unless the capability is present | Applies `strict` to a scope that OMITS `change_control` only when this release's catalog proves the capability by authoring the field on at least one SCOPE — never merely because another policy key is present, and never on 2.6.18/2.7.0 (no change control at all).             |

`V2_ENSEMBLE_SESSIONS` is the only Terraform-level switch among these; the rest
are runtime decisions driven by the release pin and the resolved policy, with
no redeploy required to change how they apply to a NEW intent.

### Verification commands

```bash
# Closure published? (expect manifest.json under the release prefix)
aws s3 ls s3://$(terraform output -raw artifacts_bucket_name)/aidlc-releases/v1/

# Registry and channels as the API sees them (admin idToken)
curl -s -H "Authorization: Bearer $TOKEN" "$API_BASE/aidlc-releases" | jq .
curl -s -H "Authorization: Bearer $TOKEN" "$API_BASE/aidlc-release-channels" | jq .

# What may the importer bring in, and is it published/registered?
curl -s -H "Authorization: Bearer $TOKEN" "$API_BASE/aidlc-release-profiles" | jq .

# Offline compatibility evidence for the vendored fixtures
npm run test:aidlc-compatibility
```

End-to-end check after enabling: create a throwaway intent, confirm the
version selector offers the stable release, and that the created intent's
detail shows the `methodologyRelease` pin.

## Trust boundary

Receipts and tool restrictions are workflow controls, not an isolation boundary
against a compromised AgentCore runtime identity. The runtime identity remains
trusted.
