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

When pinning is enabled but no stable channel is configured, intent creation may
still discover a published closure from the deployment ref. It pins that closure
only if the matching registry record is registered, visible, selectable or
certified, and its authored behavior passes the runtime promotion guard. If any
check fails, the intent is created on the existing unpinned path.

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

### Verification

Run the offline compatibility and golden-digest suite after importer or mapper
changes:

```bash
npm run test:aidlc-compatibility
```

The suite reads vendored fixtures and requires no network or cloud credentials.
