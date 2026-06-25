# AI-DLC v2 Building Blocks

The authoring layer for composable AI-DLC v2 workflows: a library of reusable
**blocks**, the **workflows** that arrange them, and a **seed** that imports the
official methodology from the upstream repo. This is authoring, not execution —
the **execution** layer (the AgentCore container that runs a stage at a time, the
MCP integration contract, the process/state table) lives in
[`v2-runtime.md`](./v2-runtime.md); open items and the trigger/resume lambda seam
are tracked in [`v2-open.md`](./v2-open.md).

## Block types

A block is the atomic editable unit. Nine types, named to match the AI-DLC v2
source (`awslabs/aidlc-workflows`):

| Type        | What it is                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STAGE`     | The atomic unit of work. Flat V2 frontmatter: `phase`, `execution`, `leadAgent`/`supportAgents`, `mode`, `produces`/`consumes`/`requires` DAG edges, `sensors`, `reviewer`, `humanValidation`. |
| `AGENT`     | A domain-expert persona (lead/support/reviewer). Carries `modelOverride`, `examples`, optional `tools`.                                                                                        |
| `SCOPE`     | A run profile: `depth` + orthogonal `testStrategy` + auto-select `keywords`. Decides which stages execute.                                                                                     |
| `RULE`      | A layered guardrail on V2's chain `org → team → team-learnings → project → project-learnings → phase → stage`.                                                                                 |
| `SENSOR`    | A deterministic check (`command` + glob `matches`); its executable script rides in `scriptRef`.                                                                                                |
| `ARTIFACT`  | A named output that wires stages (produces→consumes). Derived from the stage graph, so it can't drift.                                                                                         |
| `KNOWLEDGE` | Per-agent (or `shared`) methodology corpus. `tier: methodology` ships; `team` is accrued at runtime.                                                                                           |
| `SKILL`     | A user-invocable runner pack (V2 `SKILL.md`): `argumentHint`, `userInvocable`, `classification`.                                                                                               |
| `TEMPLATE`  | An authored scaffold (V2 `core/templates`).                                                                                                                                                    |

Phases are **not** a block type — they are defined inline on each workflow's
phase tree.

### Three orthogonal verification axes on a stage

A stage can carry all three at once: deterministic `sensors[]`, an LLM-judged
`reviewer` agent (`reviewer` + `reviewerMaxIterations`, READY/NOT-READY,
clean-room), and the human `humanValidation` gate (required on every non-init
stage by V2 default).

## Where things are stored

**DynamoDB single table `aidlc-blocks`** + the existing **`artifacts` S3 bucket**
under a `blocks/` prefix. (Note: the rest of the app uses Neptune for domain
data and DynamoDB only for infra — this table follows the V2 spec's
DynamoDB-first model and sits beside the others.)

```
Blocks
  PK = BLOCK#<tenant>#<TYPE>#<id>   SK = V#latest      ← current metadata
                                    SK = V#<n>          ← immutable version snapshots
  GSI1PK = TENANT#<tenant>#<TYPE>   GSI1SK = <name>     ← catalog browse

Workflows (same table)
  PK = WF#<tenant>#<id>            SK = META | PHASE#… | PLACEMENT#… | RULEREF#…
                                    SK = V#<n>#…        ← immutable workflow snapshots
  GSI1PK = TENANT#<tenant>#WORKFLOW

S3 (artifacts bucket)
  blocks/bodies/sha256/<hash>      ← block markdown bodies (content-addressed)
  blocks/scripts/sha256/<hash>     ← sensor scripts (content-addressed)
  aidlc-runtime/<ref>/<repo-path>  ← internal runtime snapshot (see Seed)
  aidlc-runtime/<ref>/manifest.json
```

Bodies and scripts are never stored inline — DynamoDB holds a `bodyRef` /
`scriptRef` pointer; identical content reuses the same hashed S3 object. They
load lazily via `GET /blocks/{type}/{id}/body` and `…/script`.

### Ownership namespace

The `<tenant>` key segment is an **ownership split, not a team/org boundary**:

- **`SYSTEM`** — the imported vendor baseline. Read-only through the API,
  replaceable by the seed job.
- **`default`** — the shared user library: everything created or forked in the
  app. A user copy shadows the SYSTEM block of the same id on read; writes never
  fall back to SYSTEM.

## Workflows & compiled views

A workflow composes blocks: an inline **phase tree** (nestable, ordered by SK
path), one **placement** per stage (homed under a phase, carrying a
`scopeMembership` map of `{scope → EXECUTE|SKIP}`), and **rule refs** per layer.
Every mutation writes an immutable `V#<n>#…` snapshot so a future intent→workflow
link can pin an exact composition.

`GET /workflows/{id}/compiled` serves views computed on demand by pure functions
in `lambda/shared/compile.js`:

- **scope grid** — `{scope → {stage → EXECUTE|SKIP}}`, transposed from placements.
- **autonomy profile** — per-stage self-halting / mixed / human-gated, read from
  the three verification axes, plus a roll-up.
- **stage graph** — produces→consumes + requires edges, with cycle and
  orphan/unknown-artifact detection.
- **rules** — the universal layer stack + per-stage applicable rules (a phase
  rule attaches where its `phase` matches the stage's phase).

## Seed: import the methodology from the pinned repo

`lambda/seed-blocks` is the single import point. It **fetches
`awslabs/aidlc-workflows` at a pinned commit** and seeds the full methodology, so
the SYSTEM baseline can never drift from upstream.

- **Fetch** — downloads the codeload tarball for the ref, gunzips + untars it in
  memory (`lambda/shared/repo-fetch.js`), reads every `core/**` file. Public
  repo, no auth. **Hard-fail, no fallback.**
- **Pin** — `AIDLC_REPO_REF` env var (a Terraform variable, default a full SHA),
  overridable per-invoke with `{"ref":"<sha|tag|branch>"}`.
- **Parse, don't transcribe** — `frontmatter.js` + `block-mappers.js` derive each
  block's structured fields from the real file: frontmatter where it exists
  (stages, agents, scopes, sensors, skills), the repo **path** where it doesn't
  (rules → layer/phase from filename; knowledge → agentRef/doc from directory).
  Bodies and sensor scripts are stored to S3.
- **Compose** — the `aidlc-v2` default workflow (phase tree + one placement per
  stage + rule refs) is derived from the parsed stages and rules.

### Editable blocks vs. internal runtime

The dividing line is **"would a user tailor this?"**

- **Editable blocks** (library, forkable, in the editor): the nine types above,
  each with its markdown body; a sensor also carries its check script.
- **Internal runtime** (not blocks, not in the editor): the harness engine tools
  (`core/tools/*`, minus the `data/` scaffold), lifecycle hooks (`core/hooks/*`),
  protocols (`core/aidlc-common/protocols/*`), and `conductor.md`. Pure machinery
  a user never edits to customize a workflow. Seeded to the commit-pinned S3
  snapshot `aidlc-runtime/<ref>/…` + a manifest, so execution loads the exact
  files this baseline was seeded from and injects the right one at the right
  time.

### Seed invocation

Admin one-shot via `aws lambda invoke` (no API route):

- `{"dryRun":true}` — preview what would be written.
- `{}` — insert-only (adds blocks new since the last run, skips existing).
- `{"reseed":true}` — clear every SYSTEM partition and rewrite fresh (used after
  bumping the pin). Scoped to SYSTEM only; `default` forks are never touched.
- `{"ref":"<sha>"}` — seed from a specific ref instead of the pinned default.

## Code map

| Path                                                               | Responsibility                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `lambda/shared/blocks.js`                                          | Block model: types, key scheme, validation, `bodyRef`/`scriptRef`. |
| `lambda/shared/workflows.js`                                       | Workflow key scheme + validation.                                  |
| `lambda/shared/compile.js`                                         | Compiled views (scope grid, autonomy, stage graph, rules).         |
| `lambda/shared/repo-fetch.js`                                      | Tarball fetch + in-memory extract of `core/**`.                    |
| `lambda/shared/frontmatter.js`                                     | YAML frontmatter splitter.                                         |
| `lambda/shared/block-mappers.js`                                   | Map fetched files → blocks + the default workflow.                 |
| `lambda/building-blocks/`                                          | Block CRUD API (generic over type).                                |
| `lambda/workflows/`                                                | Workflow composition API + compiled views.                         |
| `lambda/seed-blocks/`                                              | The import job.                                                    |
| `frontend/src/pages/BlockLibrary.tsx`, `BlockEditor.tsx`           | Library browser + editors.                                         |
| `frontend/src/components/blocks/blockFields.ts`, `StageEditor.tsx` | Per-type form config + the rich stage editor.                      |
| `frontend/src/services/blocks.ts`                                  | Typed client over the block API.                                   |
