# AI-DLC v2 Building Blocks — Integration Plan

> Integrates the AI-DLC **v2 building blocks** model (authoring/editing of
> composable workflow blocks — **not** execution) into this platform. Source
> spec: the three documents in `collab-v2-blocks/` (`01-building-blocks.md`,
> `02-dynamodb-data-model.md`, `03-ui-idea.md`).

## Decisions (locked with the product owner)

| Decision            | Choice                                                                    | Rationale                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Datastore**       | **DynamoDB single-table `aidlc-blocks` + S3**                             | Follow the spec's data model literally. A _new_ table — the project's existing DynamoDB tables are infra-only (locks/sessions/cursors); domain data lives in Neptune, but the spec is DynamoDB-first and we honor it.                                                             |
| **Content storage** | **Reuse the existing `artifacts` S3 bucket** under a `blocks/` key prefix | Avoids a new bucket + lifecycle/policy. Bodies/scripts are content-addressed (`blocks/bodies/sha256/<hash>`).                                                                                                                                                                     |
| **Tenancy**         | **Per-tenant global library**, single-tenant resolution for now           | No org/tenant entity exists in the app today (tenancy is structural via `Project` membership). `resolveTenant(claims)` returns a constant; `SYSTEM` is reserved for the shipped baseline. Seam to later derive tenant from a Cognito group/attribute without a data-model change. |
| **First slice**     | **Library block CRUD only**                                               | Smallest self-contained slice; everything else builds on it. No workflow composition yet.                                                                                                                                                                                         |
| **S3 bodies**       | **In slice 1**                                                            | The content-addressed pointer is core to the spec; small to include now.                                                                                                                                                                                                          |
| **Seed**            | **Establish the pattern now, minimal data; full baseline later**          | Mirror the repo's existing operational-data-job convention (`migrate-tracker-fields`, `purge-neptune`): a standalone lambda invoked via `aws lambda invoke`, idempotent, dry-run support.                                                                                         |

### Note on the intent → workflow link (future slice)

A workflow will later be referenced by an _intent_. That reference must **pin a
version** (`{workflowId, version}`), not a bare id — the spec's immutable
published versions (`V#n`) make this safe. Recorded here so we don't design it
out; it is a slice-2+ concern.

## Datastore conflict, resolved

The app uses **Neptune** for all domain data and **DynamoDB** only for
infra (locks, sessions, WS connections, cursors). The spec is a DynamoDB
single-table design. Per the owner's decision we follow the spec: a brand-new
`aidlc-blocks` table, sitting beside the existing tables. There is no existing
domain-data DAL to follow, so the lambda owns its own `DynamoDBDocumentClient`
inline — consistent with how every other lambda in this repo uses DynamoDB.

---

## Slicing roadmap

| Slice | Scope                                                                     | Status      |
| ----- | ------------------------------------------------------------------------- | ----------- |
| **1** | **Library block CRUD** (this plan)                                        | in progress |
| 2     | Workflow + placements + grouping tree (+ intent→workflow version pin)     | later       |
| 3     | Scope × skill matrix + compiled views (skill-graph, scope-grid, autonomy) | later       |
| 4     | Learnings queue + fork/clone + 3-way baseline merge                       | later       |

The single-table + S3 pointer design makes slices 2–4 **additive** (new SK
types + GSI2/3/4), never rewrites.

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

Cross-cutting: **SYSTEM read-only guard** (reject writes to `SYSTEM` /
non-owned), inline validation (block-type enum, kebab-case id, length caps,
per-type required fields — no schema lib, matches the codebase), and
`lambda/shared/tenant.js` (`resolveTenant(claims)` — constant for now).

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
  `{"dryRun":true}` previews; `{}` applies. Writes to `tenantId: SYSTEM`.
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
