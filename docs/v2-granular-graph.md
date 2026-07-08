# V2 Granular Graph — What Is Built

The granular graph is the fine-grained, queryable projection of the intent's
canonical markdown artifacts. Documents stay the source of truth; the graph is
a deterministic, re-derivable index over them — sections, typed items,
citations, and traceability edges — so agents, sensors, the UI, and the audit
all work from the same typed data instead of re-reading whole documents.
(Companion doc: `v2-graph-context.md` describes the lifecycle and the
enrichment toggle; this doc describes WHAT exists and WHERE it lives.)

## Node model

| Label                                                                             | Id scheme                             | Written by               | Purpose                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `Intent`                                                                          | intent id                             | init-ws                  | Scope anchor; everything hangs off it via `CONTAINS`                                                                 |
| `Artifact`                                                                        | agent-chosen id                       | agent MCP tools          | Canonical document-level stage output (`artifact_type` = v2 artifact id)                                             |
| `Section`                                                                         | `section:<artifactId>:<slug>`         | derive                   | One `##`–`######` heading + body; powers TOC/section reads. NOT rendered in the UI graph                             |
| `Story` `Persona` `Requirement` `Component` `Decision` `StoryMapEntry` `Contract` | `<label lowercase>:<intentId>:<slug>` | derive                   | Typed items parsed from the artifact's fenced YAML structured block. Intent-scoped ids stay stable across re-derives |
| `UnitOfWork`                                                                      | `unit:<intentId>:<slug>`              | promote-units            | Traceability mirror of the promoted unit DAG (DDB rows are the scheduling truth)                                     |
| `Question` / `Steering` / `Discussion` / `TeamKnowledge` / `LearningRule`         | various                               | runtime / intents lambda | Process + knowledge vertices (not part of the derived layer)                                                         |

The typed item labels are derived from the extraction `REGISTRY`
(`lambda/shared/artifact-extractors.js`) — the single source of truth that
also generates the structure contracts agents see and the parser that reads
them back (round-trip tested, so instructions and parser cannot drift).

## Edge model

**Business edges (agent-written, allowlisted):** `PRODUCES` `CONSUMES`
`DERIVED_FROM` `RELATES_TO` `DEPENDS_ON` between Artifacts (`link_artifacts`
tool); `CONTAINS` anchors scope.

**Derived edges (machine-written, never by agents):**

| Edge                            | From → To                                                     | Source of truth                           |
| ------------------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| `HAS_SECTION` / `HAS_ITEM`      | Artifact → Section/item                                       | markdown headings / structured block      |
| `DERIVED_FROM`                  | Section/item/UnitOfWork → Artifact                            | provenance back-links                     |
| `CITES`                         | Artifact → Artifact                                           | `[[artifact-slug]]` wikilinks in the body |
| `COVERS`                        | Story → Requirement                                           | item prop `covers`                        |
| `FOR_PERSONA`                   | Story → Persona                                               | item prop `persona`                       |
| `DEPENDS_ON`                    | Story → Story, Component → Component, UnitOfWork → UnitOfWork | item props `depends_on` / the unit DAG    |
| `IMPLEMENTS`                    | StoryMapEntry → Story and → UnitOfWork                        | item props `stories` / `unit`             |
| `EXPOSES` / `CONSUMES_CONTRACT` | UnitOfWork → Contract                                         | Contract props `provider` / `consumers`   |

The item↔item edges are materialized by `resolveDerivedItemEdges`
(graph-writer), an intent-wide idempotent sweep that runs after every derive
and again after `promote-units` (StoryMapEntry/Contract items derive before
the UnitOfWork vertices exist). It drops-then-recreates the managed labels per
current source vertex — a re-derive that removes a reference removes its edge
— and silently skips dangling slugs (the coverage sensor reports those as
`unknownReferences`).

## Pipeline (write path)

1. **Structure contracts in prompts** — `lambda/shared/artifact-structure-contract.js`
   renders per-type YAML block specs + examples from the REGISTRY into every
   producing stage prompt (`stage-materializer.js`).
2. **Agent authors markdown** — headings, `[[citations]]`, one fenced
   `yaml` structured block per registered type; cross-references (covers/
   persona/depends_on/…) are ordinary fields in that block.
3. **Derive** — `lambda/agentcore/commands/derive-artifacts.js` runs after
   every artifact-producing stage (orchestrator + unit-lane hooks) and on the
   admin backfill route. Extraction (`extractArtifactStructure`) → mirror
   (`mirrorArtifactDerivations`) → item-edge sweep → optional LLM enrichment
   (enabled by default on deploy; Admin-togglable — props only:
   `summary_gist`/`summary_claims`). Fail-open at every step; the
   event feed reports `N artifact(s), N section(s), N item(s), N item edge(s),
N citation set(s)[, N enriched]`.
4. **Hygiene** — supersede, never delete: re-derive marks removed rows
   `superseded_at`; rewind orphans are swept; re-promotion supersedes dropped
   units and revives re-added ones. Every read filters to current rows.

## Consumption (read path)

- **Agent MCP tools** (graph-writer reads): compact-first ladder —
  `get_intent_graph` → `get_artifact_toc`/`get_artifact(mode)` →
  `get_section`/`get_items` → `search_graph` → full `get_artifact`.
  `get_coverage` answers the join questions in one call (uncovered must-haves,
  unmapped stories, unknown refs, component cycles, per-unit lane slices).
- **Context pack** (`lambda/agentcore/context-compiler.js`): bounded 24 KB
  markdown injected into fresh stage prompts — input artifacts + gists, the
  unit lane pack (mapped stories, requirements covered via one `COVERS` hop,
  touched contracts), decisions, a typed-item index with traceability
  suffixes (`→ covers: …; persona: …; depends on: …`), input TOCs last.
- **UI knowledge graph** (`lambda/intents/knowledge-graph.js`): renders the
  business layer plus the derived layer (typed items, units, and all
  traceability edges) behind a layer toggle. Sections are deliberately
  excluded from the canvas.
- **Sensors** (`lambda/shared/v2-sensor-contract.js`): `required-sections`
  (headings + structured-block shape), `upstream-coverage` (citations),
  `graph-coverage` (topology integrity over `get_coverage`).
- **Audit** (`lambda/intents/audit.js`): derive health, structure-contract
  compliance, enrichment spend vs. compact-read adoption, advisories.

## Shared row helpers (one implementation)

`lambda/shared/graph-rows.js` is used by BOTH graph stacks (agentcore writer +
intents read): `flattenVertexMap` (valueMap(true) normalization — properties
always win over T.id/T.label tokens; Neptune orders them differently than
gremlin-server, which once corrupted every business id in the field),
`isCurrentRow`, `jsonListProp`, and `DERIVED_ITEM_LABELS` (derived from the
REGISTRY). These were previously per-bundle copies; the Neptune bug had to be
fixed twice — never again.

## Invariants

- Documents are canonical; the whole projection is re-derivable at any time
  (`POST .../intents/{id}/derive`, platform admin, refused while RUNNING).
- Agents never write derived topology; deterministic parsers own every
  derived node and edge. Provenance stamps come from trusted container ENV,
  never tool args.
- Derive/enrichment/sweep failures are events, never stage failures.
- Reads never surface superseded rows; edge projections drop any edge whose
  endpoint is not a rendered/current node.
- Anything that works against gremlin-server but is provider-sensitive
  (ordering, token keys) must have a both-orders regression test — see
  `flattenVertexMap`'s history.

## Key files

| Concern                                        | File                                                       |
| ---------------------------------------------- | ---------------------------------------------------------- |
| Extraction registry + parser                   | `lambda/shared/artifact-extractors.js`                     |
| Structure-contract rendering                   | `lambda/shared/artifact-structure-contract.js`             |
| Shared row helpers                             | `lambda/shared/graph-rows.js`                              |
| Graph writer (mirrors, sweep, reads, coverage) | `lambda/agentcore/mcp/graph-writer.js`                     |
| Derive command (+ enrichment)                  | `lambda/agentcore/commands/derive-artifacts.js`            |
| Unit DAG promotion (+ re-sweep)                | `lambda/agentcore/commands/promote-units.js`               |
| Context pack                                   | `lambda/agentcore/context-compiler.js`                     |
| UI graph read                                  | `lambda/intents/knowledge-graph.js`                        |
| Sensors                                        | `lambda/shared/v2-sensor-contract.js`                      |
| Audit aggregation                              | `lambda/intents/audit.js`                                  |
| End-to-end regression net                      | `lambda/agentcore/test/graph-pipeline.integration.test.js` |
