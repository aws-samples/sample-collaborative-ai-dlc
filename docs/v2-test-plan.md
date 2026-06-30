# AI-DLC v2 — Test Plan

How the v2 feature set (v1/v2 project discriminator, intent CRUD, the durable
orchestrator, `intent:` realtime, the dynamic IntentView, intent-scoped
discussions, per-project model selection, park-release) is tested. Pairs with
[`v2-open.md`](./v2-open.md) (the behaviors under test) and the implementation
in `lambda/intents`, `lambda/v2-orchestrator`, and `frontend/src`.

The strategy is **two tiers**: a hermetic tier that gates every PR with no AWS,
and a live tier that proves the seam to AWS on demand.

```
Tier 1  HERMETIC (every PR — GitHub Actions, no AWS)
        • backend unit/integration (vitest + gremlin + dynamodb-local containers)
        • frontend unit/component (vitest + jsdom + React Testing Library)
        • terraform fmt + validate (-backend=false)
Tier 2  LIVE (local / nightly — AWS + Bedrock creds)
        • scripts/v2-e2e.sh: create→start→park→answer→resume→succeed, asserted
```

The split exists because the true end-to-end path (a real AgentCore microVM + a
live LLM agent) is non-deterministic, slow, and credential-bound — it cannot gate
a PR. Tier 1 proves every seam we own with mocks/containers; Tier 2 proves the
wiring to AWS is correct.

---

## Tier 1 — hermetic (CI)

### Backend (`npm test` at the repo root)

Runs every lambda's vitest project against one shared `gremlin-server` + one
`dynamodb-local` testcontainer (`vitest.config.js`, `test/*-setup.js`). Two
harness styles are reused, never reinvented:

- **Real gremlin + `aws-sdk-client-mock`** — `lambda/intents/test/intents.test.js`.
- **Pure DI + a fake `DurableContext`** — `lambda/v2-orchestrator/test/orchestrator.test.js`.
- **In-memory DDB conditional fakes** (guards/CAS) — `lambda/discussions/test/discussions.test.js`.

Coverage by area (✓ = covered):

**`lambda/intents`** — `test/intents.test.js`

- ✓ create: DRAFT row, workflow version pinned, repos/branch defaulted,
  `cliModels`/`parkReleaseSeconds` snapshotted; non-member 403; v1 project 400.
- ✓ get (assembled DTO): `stages/gates/metrics/outputs/sensorRuns/artifacts`
  present; `cliModels`/`parkReleaseSeconds` surfaced; cross-project 404.
- ✓ list: project-scoped, `?status` filter, empty when nothing matches.
- ✓ start: DRAFT→CREATED + orchestrator invoke; 409 non-DRAFT; 400 no prompt;
  404 cross-project; 403 non-member.
- ✓ answer-gate: 200 CAS answer; resume callback sent **only** when the gate
  carries a `callbackId` (D3 sibling gate sends nothing); 409 double-answer;
  404 unknown gate.
- ✓ realtime-token: `['intent:<id>','project:<id>']` scopes; 403 non-member;
  404 cross-project.

**`lambda/v2-orchestrator`** — `test/orchestrator.test.js`

- ✓ ignore non-start; init-ws→stages→SUCCEEDED.
- ✓ **replay discipline**: a tracking `ctx` proves no `store.*`/`invokeRuntime`
  side effect runs outside a `ctx.step` (the one real durable-function risk).
- ✓ 3-stage advance in `plan.order` on ONE reused session id.
- ✓ D3 re-park: two `WAITING_FOR_HUMAN` (h1, h2) before SUCCEEDED — each gate
  bound + resumed.
- ✓ park-release: timer wins → `StopRuntimeSession`; answer wins → no stop;
  `parkReleaseSeconds:null` → never stops.
- ✓ `cliModels` forwarded to run-stage; FAILED stage short-circuits to FAILED.
- ✓ plan-invalid fails closed.

**`lambda/shared`** — `test/v2-process.test.js`, `test/v2-workflow-plan.test.js`

- ✓ key scheme + GSI projections; stage/human-task builders.
- ✓ `createExecution` CAS; `updateExecution` re-stamps both indexes;
  `answerHumanTask` CAS; `getExecutionRecords` grouping.
- ✓ `listProjectExecutions` newest-first + status prefix; `patchExecutionConfig`
  partial set; `setGateCallbackId` stamps the callback id.
- ✓ `buildExecutionMeta` carries prompt/branch/baseBranch/repos/cliModels/
  parkReleaseSeconds + DRAFT.
- ✓ `loadExecutionPlan`: ordered stages; version-not-found + unknown-scope fail
  closed; default-tenant workflow **shadows** the SYSTEM baseline.

**`lambda/discussions`** — `test/discussions.test.js`

- ✓ 64 v1 sprint tests pass **byte-identical** after the scope-neutral refactor.
- ✓ intent scope: create intent + per-artifact threads; artifact-not-in-intent
  404; sprint entityType rejected under intent; post/read messages;
  realtime-token intent scope; non-member 403; assist refused (sprint-only);
  resolve/reopen + redact target `intent_id`.

**`lambda/yjs-server`** — `test/realtime-token.test.js`

- ✓ the standalone copy and `lambda/shared/realtime-token.js` enumerate the same
  `intent:` channel + `intent-…` Yjs-doc vectors (parity pinned).

### Frontend (`npm --prefix frontend test`)

Vitest + jsdom + React Testing Library (`frontend/vitest.config.ts`,
`frontend/src/test/setup.ts`). Pure logic and reducer-style hooks are favored;
DOM tests stub heavy leaves (Yjs-backed editors) to stay fast and flake-free.

- ✓ `src/lib/realtimeToken.test.ts` — the client mirror of the backend scope
  extractor: intent channel/doc recognizers, and `getRealtimeToken` builds
  `/projects/{pid}/intents/{id}/realtime-token`.
- ✓ `src/services/discussions.test.ts` — `discussionBasePath`/`discussionScopeId`
  - every method routes both scopes through the base path.
- ✓ `src/services/intents.test.ts`, `projects.test.ts` — request paths/payloads
  (incl. v2 create fields) against a mocked `api`.
- ✓ `src/hooks/useIntentEvents.test.ts` — connects with the explicit
  `{intentId,projectId}` scope target; forwards each `agent.question` (D3 — the
  consumer accumulates by `humanTaskId`); filters other intents.
- ✓ `src/pages/IntentView.test.tsx` — DRAFT define-form+Start; running stage
  tree = union of plan + STAGE rows (plan-only ⇒ PENDING); one QuestionEditor
  per pending gate; per-artifact DiscussButton.
- ✓ `src/pages/Project.test.tsx` — a `kind:'v2'` project renders IntentsView,
  not the sprint UI.
- ✓ `src/components/CreateProjectModal.test.tsx` — the v1/v2 type choice renders.

> Note: a `useDiscussion` hook test was intentionally **not** added — the
> Yjs-backed hook keeps the jsdom worker alive and is better proven by the
> backend discussions tests + the `realtimeToken` doc-name unit. The
> intent-doc-name behavior is asserted there instead.

### Terraform (`terraform fmt` + `validate`)

`terraform validate` re-parses the real `backend "s3" {}` block, so CI stages a
throwaway `ci_backend_override.tf` (auto-merged `*_override.tf`) swapping in a
`local` backend, then runs `init -backend=false` + `validate` — no AWS creds.
Catches malformed lambda/route/IAM blocks, missing variable wiring, and bad
provider arguments (e.g. the v2 lambdas' `durable_config_*` + the intent API
Gateway routes).

---

## Tier 2 — live end-to-end (`scripts/v2-e2e.sh`)

Drives the **product path** (intents REST API + durable orchestrator) against a
deployed stack and asserts each transition; non-zero exit on any failure.

```
API_BASE_URL=$(terraform -chdir=terraform output -raw api_gateway_url) \
E2E_ID_TOKEN=<cognito id token> REPO=owner/repo AWS_REGION=us-east-1 \
  ./scripts/v2-e2e.sh
```

Asserts: create v2 project (`kind=v2`) → create intent (DRAFT, version pinned) →
start (202) → execution reaches RUNNING + Neptune Intent anchor exists (via
`phaseb.sh inspect`) → if parked, answer the gate (200) and a double-answer is
rejected (409) → poll to terminal SUCCEEDED (auto-answering any re-park, D3) →
≥1 artifact produced → cleanup (drop intent subgraph + delete project).

Reuses `scripts/phaseb.sh` (inspect/drop-intent) and the same v2 table the
runtime writes. Wired (not gated) in `.github/workflows/v2-e2e.yml` as
`workflow_dispatch` + nightly cron with repo secrets.

### Manual realtime smoke (not automated)

True multi-client realtime is impractical to automate cheaply. Open one intent
in two browsers and confirm: the phase/stage pointer advances live; `agent.output`
streams; a collaborative gate answer syncs; multiple pending gates each render a
QuestionEditor; reconnecting mid-run replays durable output/stage/metric rows.

---

## CI workflows

| Workflow              | Trigger                            | Runs                                               |
| --------------------- | ---------------------------------- | -------------------------------------------------- |
| `test.yml`            | push main / PR                     | `npm test` (all lambda projects, node 22+24)       |
| `lint.yml`            | push main / PR                     | `oxlint` + `oxfmt --check`                         |
| `frontend.yml`        | push/PR on `frontend/**`           | `npm run test` **+** `npm run build`               |
| `terraform.yml` (new) | push/PR on `terraform/**`          | `fmt -check` + `init -backend=false` + `validate`  |
| `v2-e2e.yml` (new)    | `workflow_dispatch` + nightly cron | `scripts/v2-e2e.sh` (AWS creds; **not** a PR gate) |

## Acceptance criteria

- `npm test` green incl. the v2 backend gap tests.
- `npm --prefix frontend test` green under jsdom.
- `terraform validate` green with `-backend=false` + the local-backend override.
- `scripts/v2-e2e.sh` exits 0 against a deployed stack and leaves no residue.
- Every assertion maps to a documented v2 behavior: D1 park-release, D3
  multi-gate, DRAFT→Start lifecycle, scope-keyed collaboration, `intent:` realtime.

## Running it

```
npm test                         # backend (root) — needs Docker for containers
npm --prefix frontend test       # frontend — hermetic, no Docker
cd terraform && terraform fmt -check -recursive   # + init -backend=false && validate
./scripts/v2-e2e.sh              # live, needs AWS creds + a deployed stack
```
