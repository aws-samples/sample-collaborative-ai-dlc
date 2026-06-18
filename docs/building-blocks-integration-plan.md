# AI-DLC v2 Building Blocks — Integration Plan

> Integrates the AI-DLC **v2 building blocks** model (authoring/editing of
> composable workflow blocks — **not** execution) into this platform. Source
> spec: the three documents in `collab-v2-blocks/` (`01-building-blocks.md`,
> `02-dynamodb-data-model.md`, `03-ui-idea.md`).

## Decisions (locked with the product owner)

| Decision                | Choice                                                                    | Rationale                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Datastore**           | **DynamoDB single-table `aidlc-blocks` + S3**                             | Follow the spec's data model literally. A _new_ table — the project's existing DynamoDB tables are infra-only (locks/sessions/cursors); domain data lives in Neptune, but the spec is DynamoDB-first and we honor it.                                                                                                               |
| **Content storage**     | **Reuse the existing `artifacts` S3 bucket** under a `blocks/` key prefix | Avoids a new bucket + lifecycle/policy. Bodies/scripts are content-addressed (`blocks/bodies/sha256/<hash>`).                                                                                                                                                                                                                       |
| **Ownership namespace** | **`SYSTEM` imported baseline + shared `default` user library**            | The partition key still carries a `tenant` segment, but this is not a team/org boundary. `SYSTEM` owns imported vendor workflows/blocks so the seed job can overwrite them and the API can keep them read-only. `default` owns all user-created/forked definitions. Project/team authorization stays in the existing project graph. |
| **First slice**         | **Library block CRUD only**                                               | Smallest self-contained slice; everything else builds on it. No workflow composition yet.                                                                                                                                                                                                                                           |
| **S3 bodies**           | **In slice 1**                                                            | The content-addressed pointer is core to the spec; small to include now.                                                                                                                                                                                                                                                            |
| **Seed**                | **Establish the pattern now, minimal data; full baseline later**          | Mirror the repo's existing operational-data-job convention (`migrate-tracker-fields`, `purge-neptune`): a standalone lambda invoked via `aws lambda invoke`, idempotent, dry-run support.                                                                                                                                           |

### Note on the intent → workflow link (future slice)

A workflow will later be referenced by an _intent_. That reference must **pin a
version** (`{workflowId, version}`), not a bare id — the spec's immutable
published versions (`V#n`) make this safe. Workflow composition now writes
immutable snapshot rows (`V#<n>#META`, `V#<n>#PHASE#…`, `V#<n>#PLACEMENT#…`,
etc.) on every mutation, so the future intent link can resolve an exact
composition instead of chasing mutable live placements.

## Datastore conflict, resolved

The app uses **Neptune** for all domain data and **DynamoDB** only for
infra (locks, sessions, WS connections, cursors). The spec is a DynamoDB
single-table design. Per the owner's decision we follow the spec: a brand-new
`aidlc-blocks` table, sitting beside the existing tables. There is no existing
domain-data DAL to follow, so the lambda owns its own `DynamoDBDocumentClient`
inline — consistent with how every other lambda in this repo uses DynamoDB.

---

## Slicing roadmap

| Slice | Scope                                                                         | Status |
| ----- | ----------------------------------------------------------------------------- | ------ |
| **1** | **Library block CRUD**                                                        | done   |
| **2** | **Workflow + placements + grouping tree**                                     | done   |
| **3** | **Scope × skill matrix + compiled views (skill-graph, scope-grid, autonomy)** | done   |
| 4     | Learnings queue + fork/clone + 3-way baseline merge                           | later  |

Slice 2 shipped the workflows lambda (workflows share the blocks table via
`WF#…` partitions; one Query loads the whole composition), the grouping-tree
(define-your-own, nestable phases via SK paths) and skill-placement APIs, fork
(copy grouping tree + placements), and the Workflows list + composer UI. The
intent→workflow link itself is deferred to whenever the intent feature consumes
a workflow, but the backend now has immutable workflow versions to pin to.

Slice 3 added scope refs (`SCOPEREF#` items) and the derived views, computed on
demand by pure functions in `lambda/shared/compile.js` and served from
`GET /workflows/{id}/compiled`: the scope grid (`{scope → {skill → EXECUTE|SKIP}}`
transposed from placements), the autonomy profile (per-skill self-halting /
mixed / human-gated from each skill's two gates, plus a roll-up), and the skill
graph (produces→consumes + requires edges with cycle and orphan-artifact
detection). The composer gained the scope × skill matrix (cells toggle
`scopeMembership`), an autonomy panel, and a validation summary. Compiled views
are recomputed per request — no cache yet (a `COMPILED#*` cache is a later
optimization, not a correctness need).

The single-table + S3 pointer design makes slices 2–4 **additive** (new SK
types), never rewrites.

## V2 alignment audit (after slice 3)

Before slice 4, the block model was validated against the real V2 source
(`awslabs/aidlc-workflows`, `v2-unified` branch) and renamed to V2's canonical
vocabulary so the model is understandable and can represent the whole
methodology:

| Was (abstraction) | Now (V2 canonical)                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SKILL`           | `STAGE` (atomic unit; V2's "skill" is a slash-command pack)                                                         |
| `GROUPING` block  | **dropped** — phases are defined **inline** on the workflow (V2 treats a phase as a label, not a standalone object) |
| `POSTCONDITION`   | `SENSOR` (deterministic check; `command` runs a Bun/TypeScript script)                                              |
| `GUARDRAIL`       | `RULE` (layered org/team/project/phase)                                                                             |

Other corrections: the Sensor editor now carries the full check contract
(`mode`, `command`, `runtime`, `matches`, `severity`, `category`,
`timeoutSeconds` + the script in the body); the Stage editor gained
`condition`, `support_agents`, `for_each`. Workflow routes/keys renamed
(`/groupings`→`/phases`, `{skillId}`→`{stageId}`, `groupingPath`→`phasePath`).

**Validation harness:** the seed now ports the entire V2 default workflow — 32
stages, 11 agents, 9 scopes, 4 sensors, 7 rules — into `baseline-blocks.js`,
composed into the `aidlc-v2` workflow with 5 inline phases and 32 stage
placements (each placement's `scopeMembership` transposed from the stage's V2
`scopes:` list). Compiling it yields a 32-node, acyclic graph with **zero
dangling consumes** and no unresolved agent/stage/sensor references — proving
the building blocks can model V2 end-to-end. Stage/agent/rule markdown
**bodies** are a deferred data-seam addition (only structured frontmatter is
seeded today).

### V2 deep-validation pass (against `awslabs/aidlc-workflows@v2-unified`)

The model was re-validated block-by-block against the real source (cloned
`v2-unified`: `stage-definition.md`, the `*-schema.ts` parsers, the protocols,
and every `core/` block dir). Counts match exactly and the pull-authoring shape
(bindings on the stage, satellites as pure capability descriptors) matches V2's
keystone. The following gaps were closed in this pass:

| Gap                     | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autonomy read backwards | V2 gates every non-init stage on human approval. The seed now sets `c2_verification.humanValidation: 'required'` on the 29 non-init stages, so the compiled autonomy rollup is **`selfHalting:3, humanGated:29`** (was all-self-halting) — matching V2's real default. A fork relaxes it.                                                                                                                                                |
| No artifact vocabulary  | Added an **`ARTIFACT`** block type. The baseline derives one ARTIFACT per distinct produced name from the stage data (so the registry can't drift), each flagged `terminal` when consumed by no stage. The stage-graph compiler now takes an optional registry and reports `unknownArtifacts` — the typo case `orphanProduces` alone couldn't distinguish (122 artifacts, 60 terminal = the former 60 "orphan produces", **0 unknown**). |
| Scope missing test axis | `SCOPE` gained an optional **`testStrategy`** (orthogonal to `depth`, defaults to it). Only `workshop` overrides — Standard depth, Minimal tests.                                                                                                                                                                                                                                                                                        |
| Knowledge enum-only     | **`KNOWLEDGE`** modeled with a `tier` (`methodology`\|`team`) + `agentRef` (an agent id or `shared`). The 56 methodology-tier docs from V2's `core/knowledge/` are seeded per-agent; the team tier ships empty (it is the execution-time / learning-loop write-back seam, not authored).                                                                                                                                                 |

**STAGE field re-port (A2) — done.** All 32 stages now carry V2's previously
dropped authored fields, ported verbatim from the v2-unified frontmatter: a
top-level `condition` (branching rationale), `consumes[].conditionalOn`
(`brownfield` — 14 edges across the 5 brownfield-aware stages), and the human
`inputs`/`outputs` prose preserved as `c1_definition.inputsProse` /
`outputsProse` (kept separate from the structured consume/produce edges so the
compiler is unaffected). The prose + conditional-on data live in `STAGE_PROSE`
and `CONDITIONAL_ON` side tables in `baseline-blocks.js`. A stage now
round-trips V2 frontmatter losslessly.

**RULE wiring (B) — done.** Rules are now a live workflow relation on V2's
five-layer chain (org → team → project → phase → stage). The rule data was
aligned to V2's vocabulary (`layer: 'phase'` + `phase: <name>`, replacing the
old `grouping`/`groupingRef` abstraction). Backend: `RULEREF#<layer>#<id>`
items, `POST /workflows/{id}/rules` + `DELETE /workflows/{id}/rules/{layer}/{ruleId}`,
composed into the workflow load. Compiler: a `compileRules` view returns the
universal layer stack plus a per-stage applicable-rule list — universal layers
apply everywhere, a phase rule attaches to a placement when its `phase` matches
the stage's phase (pull authoring, no glob) — and flags unresolved refs. The
baseline `aidlc-v2` workflow seeds all 7 rule refs; compiling it resolves the 3
universal layers onto every stage and each phase rule onto its phase's stages,
with zero unresolved. Terraform routes + frontend service/editor updated to the
`phase` vocabulary; surfacing the rule view in the composer UI is follow-on UI
work, not model wiring.

**Confirmed out of scope** (this is authoring, not execution, per the locked
decisions): the runtime entities — the 6-state stage-instance machine, the
67-event audit trail, sessions, Bolts, worktrees, swarm, the conductor persona,
and the directive contract. The one seam we keep open is the learning-loop
write-back (`c3_learning` → promote into the library + the empty team-knowledge
tier), which slice 4's learnings queue consumes.

---

## V2 completeness re-validation (against `v2-unified` HEAD + the 2.0 PDF)

A second deep pass re-cloned `awslabs/aidlc-workflows@v2-unified` and read it
block-by-block against the **AI-DLC Workflows 2.0** PDF spec. The structural
model holds: counts match exactly (32 stages 3/7/8/7/7, 11 agents, 9 scopes, 4
sensors, 7 rules, 56 methodology-knowledge docs), the `aidlc-v2` workflow
compiles to a 32-node acyclic graph with zero dangling consumes and zero
unresolved refs, and the SYSTEM-baseline + fork/clone + user-owned override
design directly satisfies the PDF's extensibility contract (Principle 8:
additive / replacement / composable variations). **A customer can read the
default V2 definition and author their own variation today.**

The pass surfaced gaps, triaged with the product owner into three tiers:

### Tier 1 — model gaps to close now (this slice)

| Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Source                                                                 | Decision                                                                                      | Change                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| **LLM-judged verification half is not first-class.** The PDF (p.5, L215–233) makes Compartment-2 self-verification two co-equal modes — _LLM instructions_ and _Executables_. We ship the deterministic half (SENSOR) richly; the LLM-judged half was only an unused enum value. `v2-unified` HEAD (today) adds a **Reviewer** spec: a clean-room sub-agent with its own persona, a validation-tool list, an iteration cap, and a binary READY/NOT-READY verdict. | `wip/reviewer-agent-spec.md`, PDF Principle 4                          | **Model the reviewer as the realized form of an `llm-judged` SENSOR** (not a new block type). | A `mode: 'llm-judged'` sensor carries `reviewerAgent`, `maxIterations`, `validationTools`; a stage references it from `c2_verification.sensors` like any other sensor. Adds 3 reviewer AGENTs + 3 reviewer SENSORs to the baseline, wired onto the 5 MVP reviewer stages (requirements-analysis, application/functional/infrastructure-design, code-generation). |
| **Learnings rule tiers absent.** V2's resolver runs `org → team → team-learnings → project → project-learnings → phase` (priorities 0/1/1.5/2/2.5/3); our RULE `layer` enum stopped at org/team/project/phase/stage.                                                                                                                                                                                                                                              | `docs/reference/08-rule-system.md:93`, `core/tools/aidlc-graph.ts:301` | **Reserve room now** (model, not runtime write-back).                                         | Add `team-learnings` + `project-learnings` to the RULE layer enum and the workflow ruleRef layers; the rule compiler treats them as universal layers and sorts the resolved chain by layer priority. They ship empty (accrued at runtime), mirroring the empty team-knowledge tier.                                                                              |
| **rule ↔ sensor `pairing` relation missing.** A rule may declare `pairing: <sensor-id>` (or `feedforward-only`) to bind the feedforward (rule) half to the feedback (sensor) half of the control loop.                                                                                                                                                                                                                                                            | `docs/reference/08-rule-system.md:59`, `07-sensor-system.md:209`       | **Address now.**                                                                              | Add an optional `pairing` field to RULE; the rule compiler reports unresolved/unpaired sensors. (Shipped V2 rule files leave it empty, so the baseline seeds it null.)                                                                                                                                                                                           |
| **`blocks_on` vs `requires` conflation.** V2 reserves `blocks_on` to split a completion-only ordering edge from a data-dependency edge; both we and V2-today overload `requires`.                                                                                                                                                                                                                                                                                 | `stage-definition.md:170`                                              | **Address now.**                                                                              | Add `blocksOn` to a stage's `c1_definition`; the stage-graph compiler emits `kind: 'blocks'` ordering edges (counted in cycle detection, distinct from `data`/`requires`).                                                                                                                                                                                       |
| **AGENT `examples` + optional `tools` fields.** Every V2 agent frontmatter carries `examples:` (example team-knowledge files) and may carry a `tools:` allowlist.                                                                                                                                                                                                                                                                                                 | `core/agents/*.md`, `05-agent-system.md:32`                            | **Address now.**                                                                              | Add `examples` (string[]) and `tools` (optional string[]) to AGENT; seed `examples` verbatim from V2.                                                                                                                                                                                                                                                            |
| **`mode: agent-team` reserved value unguarded.** V2's stage `mode` enum is `inline                                                                                                                                                                                                                                                                                                                                                                                | subagent                                                               | agent-team`(the third reserved). Our STAGE never validated`mode`.                             | `stage-definition.md:55`                                                                                                                                                                                                                                                                                                                                         | **Address now.** | Validate STAGE `mode` against the three-value enum so `agent-team` round-trips as a known-reserved value. |

### Tier 2 — confirmed-reserved, backlog (no model change)

These are reserved-but-unused in the shipped V2 source too, so they are
documented here and added to the roadmap rather than built: stage `when:`
(structured `condition` replacement, supersedes `conditional_on`), stage
`on_failure:` (declarative recovery), sensor/loop `timeout`/`retry` budgets, the
reserved `stage`-layer rule binding (`aidlc-stage-<slug>.md`), and the authored
`bolt_dag` edge block embedded in the units-generation artifact (a runtime-graph
input, not an authoring primitive).

### Tier 3 — confirmed out of scope (unchanged)

The "skill" primitive is V2's command/runner packaging (generated _from_ the
stage graph — `aidlc-<slug>` stage-runners, `aidlc-<scope>` scope-runners, the
base conductor, and 3 hand-authored session skills); our STAGE-as-atomic-unit
is the correct authoring primitive and a "skill block" would be a packaging
concern, not a model gap. All runtime entities (state machine, Bolts, swarm,
worktrees, audit trail, directives, conductor persona, `memory.md` diary)
remain execution-time and out of this authoring model.

---

## Slice 1 — Library block CRUD

The 9 library block types (Skill, Grouping, Agent, Scope, Guardrail,
Post-Condition, Knowledge — Workflow/Artifact arrive in slices 2–3) share one
storage shape, so **one generic lambda + one generic frontend service** handle
all of them; only the UI form fields differ per type.

### Storage shape (this slice)

```
PK = BLOCK#<tenant>#<TYPE>#<id>
SK = V#latest              ← current metadata (queryable skeleton)
SK = V#<n>                 ← immutable version snapshots
GSI1PK = TENANT#<tenant>#<TYPE>   GSI1SK = <name>   ← catalog browse
```

Body/script content → S3 `blocks/bodies/sha256/<hash>` (and
`blocks/scripts/sha256/<hash>`), referenced by `bodyRef`/`scriptRef`. Only
GSI1 is created now; GSI2/3/4 come with slices 2–4.

### Part 1a — Data model & infra (Terraform) — **first concrete change**

- `terraform/modules/data/dynamodb/main.tf`: add `aws_dynamodb_table "blocks"`
  (`pk` HASH, `sk` RANGE, GSI1 `GSI1PK`/`GSI1SK`). `outputs.tf`: name + arn.
- **S3**: reuse `artifacts` bucket; scope the new lambda's IAM to
  `${artifacts_bucket_arn}/blocks/*`.
- `terraform/modules/api/lambda/main.tf`: a dedicated least-privilege
  `aws_iam_role "blocks"` (DDB RW on the table + GSI1; S3 RW on `blocks/*`;
  basic execution — **no VPC**, DDB/S3 only) + `module "building_blocks_lambda"`
  - `module "seed_blocks_lambda"` (reuses the same role). `outputs.tf`:
    invoke-arn/name for the CRUD lambda, name for the seed lambda.
- `terraform/modules/api/lambda/variables.tf`: add `blocks_table_name` /
  `blocks_table_arn`.
- `terraform/main.tf`: pass `blocks_table_*` into `module "lambda"`; pass
  `building_blocks_lambda_invoke_arn`/`_name` into `module "api"`.
- `terraform/modules/api/variables.tf`: declare the two new vars.
- `terraform/modules/api/routes.tf`: `/blocks/{type}` (GET, POST),
  `/blocks/{type}/{id}` (GET, PUT, DELETE), `/blocks/{type}/{id}/body` (GET) —
  Cognito auth, `cors` module per resource, `aws_lambda_permission`.
- `terraform/modules/api/main.tf`: add the new resource ids to the deployment
  `redeployment` trigger.

### Part 1b — Backend CRUD lambda (`lambda/building-blocks/`)

ESM `nodejs24.x`, `export const handler`, path-suffix router, `buildResponse`,
OPTIONS short-circuit (mirror `lambda/discussions`). Routes:

- `GET  /blocks/{type}` → Query GSI1 (`TENANT#<tenant>#<TYPE>` + merge `TENANT#SYSTEM#<TYPE>`)
- `POST /blocks/{type}` → create: PutItem `V#latest` + `V#1`; body → S3 → `bodyRef`
- `GET  /blocks/{type}/{id}` → GetItem `V#latest` (metadata only)
- `GET  /blocks/{type}/{id}/body`→ resolve `bodyRef`/`scriptRef` → S3 GetObject (lazy)
- `PUT  /blocks/{type}/{id}` → new `V#latest` + immutable `V#<n+1>`; re-hash body if changed
- `DELETE /blocks/{type}/{id}` → delete partition

Cross-cutting: **SYSTEM read-only guard** (reject writes to the imported
baseline; user edits happen in `default`), inline validation (block-type enum,
kebab-case id, length caps, per-type required fields — no schema lib, matches
the codebase), and `lambda/shared/tenant.js` (`resolveTenant(claims)` —
constant by design, because the ownership split is imported vs user-created,
not one library per team/project).

### Part 1c — Backend tests (`lambda/building-blocks/test/`)

Vitest + `mockClient(DynamoDBDocumentClient)` + `mockClient(S3Client)`. **No
Neptune testcontainer** (DDB/S3 only → simpler than `discussions`). Cover:
create→`V#latest`+`V#1`, GSI1 list, get, version bump on PUT, body round-trip,
SYSTEM-write rejection, validation 400s.

### Part 1d — Frontend service + library browser

- `frontend/src/services/blocks.ts`: co-located TS interfaces + `blocksService`
  (`list/get/getBody/create/update/delete`) over the `api` wrapper — mirrors
  `services/projects.ts`.
- `frontend/src/pages/BlockLibrary.tsx`: list page modeled on `Dashboard.tsx`
  (tabs per block type, card grid, search, `Skeleton`, empty state, create,
  `AlertDialog` delete, SYSTEM read-only badge), shadcn `ui/*`.
- `frontend/src/App.tsx`: `<Route path="/blocks">` under `AppShell`.
  `AppHeader.tsx`: a "Building Blocks" nav entry.

### Part 1e — Block editors (smallest first)

- **1e-i** simple-block generic form (Grouping, Scope, Agent, Knowledge,
  Guardrail, Post-Condition): sectioned `Card` form driven by a per-type field
  config + a markdown `Textarea` for the S3 body. (`ProjectSettings.tsx` pattern.)
- **1e-ii** the rich **Skill editor**: tabbed ⊣ Clarify / C1 Define / C2 Verify
  / C3 Learn / Instructions / More (shadcn `Tabs`). Reference pickers as plain
  `<select>`s from `blocksService.list(...)` for now.

### Part 1f — Seed pattern (establish now, full baseline later)

Mirrors `lambda/migrate-tracker-fields`:

- `lambda/shared/baseline-blocks.js`: `export const BASELINE_BLOCKS = [...]` —
  the data seam. "Full seed later" = append entries here, nothing else changes.
  Ships with a minimal set (a couple groupings, an agent, a scope, a skill).
- `lambda/seed-blocks/index.js`: standalone lambda (DDB/S3 only). For each
  entry: body → S3 if present; PutItem `BLOCK#SYSTEM#<TYPE>#<id>` `V#latest` +
  `V#1` with `ConditionExpression: attribute_not_exists(pk)` (idempotent).
  `{"dryRun":true}` previews; `{}` applies. Writes to `tenantId: SYSTEM`,
  which is intentionally replaceable/reseedable and never user-editable.
- `terraform`: `module "seed_blocks_lambda"` reusing the blocks IAM role; no API
  route (operator-invoked); output `seed_blocks_lambda_name`.
- Tests: idempotency (second run no-ops) + correct key placement.

### Build order

1a (terraform) → 1b+1c (lambda+tests) → 1f (seed gives the UI real data) →
1d (service+browser) → 1e-i → 1e-ii.

---

## Out of scope for Slice 1 (additive later)

Workflow composition, placements, the grouping _tree_, scope-membership matrix,
compiled graph/autonomy/scope-grid caches, the learnings queue, fork/clone,
3-way baseline merge, Yjs co-editing of bodies.
