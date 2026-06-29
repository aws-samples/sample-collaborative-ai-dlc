# AI-DLC v2 — Session park/resume & persistent workspace

How the v2 AgentCore Runtime should reuse the git checkout across invocations and let
a session go **inactive** while waiting on a human, then **resume** — for waits that
may last hours to days.

Pairs with [`v2-agent.md`](./v2-agent.md) (agent-execution layer),
[`v2-open.md`](./v2-open.md) (the missing trigger/resume lambda), and the runtime
HTTP contract in `lambda/agentcore/http-server.js`.

## TL;DR

- **Reuse the checkout?** Yes — configure AgentCore **managed session storage** at
  `/mnt/workspace`. It survives stop/resume for the same `runtimeSessionId`.
- **Mark a session inactive when asking a question?** There is no "mark inactive" API.
  A session goes idle when the invocation **returns** and `/ping` reports `Healthy`
  (not `HealthyBusy`). Today `ask_question` blocks forever, which pins the session
  busy — that's the core bug. The orchestrator can also call `StopRuntimeSession` to
  free compute immediately.
- **How to resume?** Re-invoke `run-stage` with the **same `runtimeSessionId`** in a
  new resume mode; the persistent mount restores the checkout + the CLI's conversation
  store, and the CLI continues via its resume flag.
- **Longest inactive window?** Bounded by managed session storage's **14-day** idle
  expiry, and invalidated earlier by any runtime **image redeploy**. The microVM's 8h
  `maxLifetime` cap stops being fatal once park/resume works.

---

## Current state (what the investigation found)

1. **`ask_question` blocks the session open.**
   `lambda/agentcore/mcp/process-bridge.js:75-82` polls the answer gate in an
   **infinite loop** until answered. While it waits, the headless CLI subprocess and
   the MCP stdio server stay alive, the `POST /invocations` request stays open, and
   `busy.enter()` keeps `GET /ping` at **`HealthyBusy`**
   (`lambda/agentcore/http-server.js:24-37,57-66`). AWS treats `HealthyBusy` as an
   active background task, so **the session can never go idle during a pending
   question**.

2. **No filesystem persistence.** The runtime resource
   (`terraform/modules/compute/agentcore/main.tf:374-411`) has **no
   `filesystem_configurations`**. The `/workspace` checkout lives only on the
   ephemeral microVM, and the CLI's own conversation store lives under
   `HOME=/home/node` (`Dockerfile:56`) — also ephemeral. Nothing survives stop/resume.

3. **No lifecycle configuration.** Same resource has **no `lifecycle_configuration`**,
   so AWS defaults apply: idle **900s (15 min)**, max compute lifetime **28800s (8h)**.

**The collision:** because the session is pinned `HealthyBusy` for the whole wait, a
pending question that outlives the 8h `maxLifetime` cap (which AWS **cannot reset**)
gets its microVM terminated mid-wait, destroying the in-memory CLI conversation and
any uncommitted `/workspace` state. A multi-day wait is impossible today.

## AWS AgentCore Runtime limits (authoritative, from AWS docs)

| Setting                           | Default       | Range / note                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idleRuntimeSessionTimeout`       | 900s (15 min) | 60–28800s; resets on each invoke. Idle only when not processing a request **and** not reporting `HealthyBusy`.                                                                                                                                                                              |
| `maxLifetime`                     | 28800s (8h)   | 60–28800s; per microVM; **cannot be reset**. On hit, microVM terminates; next invoke gets a fresh one.                                                                                                                                                                                      |
| Session validity                  | —             | The `runtimeSessionId` stays valid until the runtime ARN is deleted. A stopped session goes Active again on the next invoke.                                                                                                                                                                |
| Managed session storage (Preview) | —             | `filesystemConfigurations:[{sessionStorage:{mountPath:"/mnt/workspace"}}]`. Survives stop/resume, isolated per session, **no VPC required**, **14-day** idle expiry, **wiped on runtime version update**. POSIX (git/npm work); no hard links/xattr. Mount present only at invocation time. |

`idleRuntimeSessionTimeout` must be ≤ `maxLifetime`. Mount path must be under `/mnt/`
with exactly one subdirectory level.

---

## CLI headless-resume capability (both verified locally)

Park/resume requires the headless CLI to exit when a question is parked and later
continue the same conversation from filesystem-persisted state. Both CLIs were tested
end-to-end on this machine (seed a codeword in a fresh run → resume in a **separate
process** → confirm recall).

### Claude Code — verified (`claude 2.1.187.441`)

- **Force session id at start:** `claude --session-id <uuid> -p "<prompt>" --mcp-config …`
  → the orchestrator picks the UUID up front; **no need to scrape it back**. ✅ Verified:
  the on-disk JSONL filename equals the forced UUID.
  - ⚠️ `--session-id` is **new-session-only** — re-passing the same id errors
    `Session ID <id> is already in use`. Resume MUST use `--resume`, never `--session-id`.
- **Resume headlessly:** `claude --resume <uuid> -p "<answer>" --mcp-config …`. ✅ Verified:
  a separate process recalled the seeded codeword. `--mcp-config` re-attaches MCP servers.
- **Store:** `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`; relocatable via
  **`CLAUDE_CONFIG_DIR`** — ✅ verified the store moved to the configured dir.
- **cwd-scoped — strict.** ✅ Verified: resuming from a **different cwd** returns
  `No conversation found with session ID …`. Resume must run from the identical cwd
  (the slug is derived from cwd).

### Kiro CLI — verified (`kiro-cli 2.10.0`)

- **Resume headlessly:** `kiro-cli chat --no-interactive --trust-all-tools --resume-id <id> "<answer>"`
  — ✅ Verified: a separate process recalled the seeded codeword, exit 0. `-r/--resume`
  resumes the most-recent conversation **from the current directory**; `--resume-picker`
  is interactive (not for headless).
- **No flag to force a session id at start** (unlike Claude). Discover it **after** the
  fresh run: `kiro-cli chat --list-sessions --format json` →
  `[{cwd, sessions:[{sessionId, source, title, updatedAt, messageCount}]}]` keyed by
  cwd — take the newest by `updatedAt`. ✅ Verified the id is listed for the cwd.
- **cwd behavior differs from Claude:** `--resume-id <id>` resolves the session
  **regardless of cwd** — ✅ verified recall from a different cwd. Only `--list-sessions`
  / `-r` are cwd-keyed. We still keep cwd identical (required for capture + for Claude).
- **Store:** a SQLite DB (`data.sqlite3`). macOS: `~/Library/Application Support/kiro-cli/`
  (`XDG_DATA_HOME` ignored). **Linux (the container): honors `XDG_DATA_HOME`** —
  ✅ **verified inside a Linux image mirroring the agentcore Dockerfile's Kiro install**:
  with `XDG_DATA_HOME=/home/node/xdg`, the store landed at
  `$XDG_DATA_HOME/kiro-cli/data.sqlite3`. `~/.kiro/settings/cli.json` is config only
  (regenerable), **not** conversation data. So a single Dockerfile
  `ENV XDG_DATA_HOME=/mnt/workspace/.kiro-data` persists Kiro conversations onto the
  mount — **no symlink needed**.

**Net:** both CLIs park/resume. Differences the implementation absorbs: Kiro has no
start-time session-id flag (capture via `--list-sessions`, cwd-keyed), `--session-id`
(Claude) is new-only, and Kiro persists to one SQLite data dir vs. Claude's per-project
JSONL — so the whole Kiro data dir (not just a project subdir) must sit on the mount.

---

## Design: Park + Resume

When the agent asks a question, the MCP tool records the gate and returns a **parked
sentinel** promptly instead of looping. The agent is instructed to stop immediately, so
the CLI exits 0, the invocation returns, `/ping` drops to `Healthy`, and the session
goes idle (or is explicitly stopped). The checkout and CLI conversation store persist on
`/mnt/workspace`. A later `run-stage` in **resume mode**, reusing the same session id,
re-spawns the CLI with its resume flag feeding the human's answer; the original
`ask_question` call site re-reads the now-answered gate and returns it inline.

### Part A — Infra: persistent mount + lifecycle

**`terraform/modules/compute/agentcore/main.tf`** (resource
`awscc_bedrockagentcore_runtime.stage_executor`, lines 374-411) — add the blocks below.
✅ **Verified against the locked provider** (`hashicorp/awscc 1.90.0`, the version in
`terraform/.terraform.lock.hcl`): both attributes exist on the resource with exactly
this shape — `filesystem_configurations` is a **list** whose elements accept
`session_storage = { mount_path }` (also `efs_access_point` / `s3_files_access_point`),
and `lifecycle_configuration` is a **single** block with `idle_runtime_session_timeout`

- `max_lifetime` (both numbers). No provider bump needed.

```hcl
filesystem_configurations = [{ session_storage = { mount_path = "/mnt/workspace" } }]
lifecycle_configuration   = { idle_runtime_session_timeout = 900, max_lifetime = 28800 }
```

Both attributes are `optional + computed` in the schema, so omitting them keeps AWS
defaults (idle 900 / max 28800) — setting them explicitly is what we want for intent.

- Add `V2_WORKSPACE_DIR = "/mnt/workspace"` to `environment_variables` (lines 396-408).
- **Rationale:** idle 900s — with park/resume a parked question lets the session idle
  and free compute after 15 min (the resume lambda may also `StopRuntimeSession`
  immediately). maxLifetime 28800 — keep at max so long _active_ stages have headroom;
  a reap mid-park is now recoverable.
- Comment the two failure modes: **14-day** session-storage idle expiry and **wipe on
  runtime version update** (every image deploy invalidates in-flight parked sessions).

**`lambda/agentcore/Dockerfile`**

- ENV (lines 56-59): `V2_WORKSPACE_DIR=/workspace` → `/mnt/workspace`.
- Relocate CLI stores onto the mount so they survive termination (both ✅ verified):
  - Claude: `CLAUDE_CONFIG_DIR=/mnt/workspace/.claude` → `projects/<cwd-slug>/<uuid>.jsonl`.
  - Kiro: `XDG_DATA_HOME=/mnt/workspace/.kiro-data` → `kiro-cli/data.sqlite3` (Linux honors
    XDG; no symlink needed). `~/.kiro/settings` is regenerable config — leave it on HOME.
  - These can be plain Dockerfile `ENV` (the env is what matters; the dirs are created on
    first write). The mount only exists at invocation time, but no boot-time write needs
    it — all CLI writes happen inside the handlers.
- Keep a defensive `mkdir -p /mnt/workspace` fallback for local/non-AgentCore runs.

**`lambda/agentcore/http-server.js:140`** — change default `'/workspace'` →
`'/mnt/workspace'` (env now sets it explicitly; this is belt-and-suspenders).

### Part B — `ask_question` park contract

`lambda/agentcore/mcp/process-bridge.js`, `askQuestion` (38-83). Replace the infinite
poll (keep all logic in the MCP layer — no new IPC, unit-testable):

1. Keep gate create / Question mirror / `pendingHumanTaskId` / `agent.question`
   broadcast / `v2.question.asked` (lines 42-71).
2. **New:** set stage `WAITING_FOR_HUMAN` (`STAGE_STATE` already has it,
   `v2-process-keys.js:84`) and execution `WAITING`.
3. **Bounded grace poll** (a few 3s iterations, `V2_QUESTION_PARK_GRACE_MS`) so a
   near-instant answer still returns inline (preserves today's fast-path UX).
4. If still pending: return
   `{ parked: true, humanTaskId, message: 'Question parked. STOP NOW — end your turn with no further tool calls; you will be resumed with the answer.' }`.
5. If answered in grace: clear `pendingHumanTaskId`, restore `RUNNING`, return the
   answer as today.

- Inject `parkGraceMs`/`maxPolls` for deterministic tests (mirror the existing `sleep`
  injection).

### Part C — `run-stage` resume mode

`lambda/agentcore/commands/run-stage.js`.

- **C1.** New payload fields (~line 196): `resumeFrom` (a `humanTaskId`) and
  `cliSessionId`. For Claude, generate `cliSessionId` (UUID) on the **fresh** run and
  pass `--session-id`. For Kiro, leave it null on the fresh run and **capture** it after
  exit via `--list-sessions --format json` (newest by `updatedAt`).
- **C2. Resume branch** (before "Mark RUNNING", ~line 293): read the gate
  (`store.getHumanTask`) + stage row to recover `cliSessionId`/`cli`/`stageInstanceId`;
  fail `gate_not_answered` if still pending; re-resolve the **same** stage (reuse
  `loadLibrary`+`resolveStage` so scope/rules/`stageInstanceId` match); re-materialize
  **only the MCP config** (factor a small `materializeMcpConfig` out of
  `stage-materializer.js`); spawn the resume invocation; then share the sensors +
  terminal-state tail (lines 411-452) with the fresh path.
- **C3. Drivers** (`lambda/agentcore/cli/drivers.js`):
  - Claude: add `--session-id <uuid>` to the fresh invocation (26-39); add
    `buildResumeInvocation` → `claude --resume <uuid> -p "<answer msg>" --mcp-config … --permission-mode bypassPermissions --model <id> --output-format stream-json --verbose`.
  - Kiro: fresh stays as-is (57-68) but the orchestrator captures the id post-exit;
    `buildResumeInvocation` → `kiro-cli chat --no-interactive --trust-all-tools --mcp-config … --resume-id <sessionId> "<answer msg>"`.
- **C4. Persist session linkage:** add `cliSessionId` + `cli` to `buildStageRow`
  (`v2-process-keys.js:127-151`) and persist/read them in `v2-process-store.js`.
- **C5. Park vs. succeed at exit:** after the CLI exits 0, re-check for a still-pending
  HUMAN# gate for this stage. If present → **parked**: keep `WAITING_FOR_HUMAN`, append
  `v2.stage.parked`, broadcast `agent.stage` state `WAITING_FOR_HUMAN`, return
  `{ ok:true, state:'WAITING_FOR_HUMAN', humanTaskId, cliSessionId, cli }`. Only with no
  pending gate do sensors + `SUCCEEDED` (lines 411-452) run.
- **C6. `/ping`** (`http-server.js`): no dispatcher change — `ask_question` now returns
  promptly so `busy.leave()` fires and `/ping` reports `Healthy`, letting the idle timer
  run. Add a test asserting `busy.status==='Healthy'` after a parked dispatch.

### Part D — Prompt/annex contract

- `lambda/agentcore/mcp/server.js` `ask_question` description (217-228): replace
  "BLOCKS until answered" with the parked contract (on `{parked:true}` → stop
  immediately, no further tool calls; on an answer → continue).
- `lambda/agentcore/prompts/mcp-execution-annex.md` (`ask_question` row ~line 41): teach
  parked semantics + a short "Parked questions" note under "Finishing a stage" (parking
  ≠ failure/completion; do not `send_output` or summarize on park).

### Part E — Trigger/resume lambda implications

Document in [`v2-open.md`](./v2-open.md) (the "Trigger / resume Lambda" section) that the
(still-unbuilt) lambda owns the full cycle:

- On human answer → CAS the gate via `store.answerHumanTask`
  (`v2-process-store.js:238-270`, exists) → issue a resume `run-stage` with the **same
  `runtimeSessionId`** and `resumeFrom=<humanTaskId>`.
- **D1 — release-on-park (configurable):** after a park, schedule a `StopRuntimeSession`
  after the project's `park_release_seconds` (read from the project vertex in DynamoDB,
  set in `Admin.tsx`; **default 300s**; `0` = stop immediately). Needs a
  `bedrock-agentcore:StopRuntimeSession` IAM grant.
- **D2 — missing store on resume:** branch on the gate's `askedAt` — **< 14 days** →
  re-run `init-ws` + re-run the stage fresh with the answered Q&A injected; **≥ 14 days**
  → hard-fail + UI warning on the stale project.

---

## Verification

**Unit:** `process-bridge.test.js` (answered-in-grace inline vs. parked sentinel +
`WAITING`); `run-stage.test.js` (fresh parks → `WAITING_FOR_HUMAN` + persists
`cliSessionId`; resume reads answered gate, builds the resume argv per CLI, reaches
`SUCCEEDED`); `drivers.test.js` (Claude + Kiro resume argv); `http-server.test.js`
(`Healthy` after parked dispatch).

**End-to-end (`scripts/phaseb.sh` + `phaseb-answer.mjs`):**

1. `init-ws` — confirm the checkout lands on `/mnt/workspace`.
2. `run-stage` on a question-asking stage — expect a prompt return
   `{ ok:true, state:'WAITING_FOR_HUMAN', humanTaskId, cliSessionId }` (no hang);
   `/ping`=`Healthy`; gate + `cliSessionId` written.
3. `StopRuntimeSession` for `SESSION_ID` (or wait out idle) to prove the microVM is
   reaped and persistence survives.
4. `phaseb-answer.mjs "<answer>"` — CAS the gate to `answered`.
5. New `run-stage-resume` case in `phaseb.sh` (same `SESSION_ID`,
   `resumeFrom=<humanTaskId>`) — the CLI resumes the prior conversation, the artifact
   reflects the answer, sensors run, `SUCCEEDED`.
6. Negative (D2): delete the persisted CLI store before resume → for a recent gate the
   control plane re-runs `init-ws` + the stage fresh with the Q&A injected (no re-ask);
   for a gate dated ≥14 days, resume hard-fails with `resume_store_expired` and the UI
   shows a stale-project warning. Neither path produces a corrupt run.

## Resolved by verification (no longer open)

These were the original plan's risks; each was checked empirically and is now settled.

1. ✅ **awscc provider support** — the locked `hashicorp/awscc 1.90.0` exposes both
   `filesystem_configurations` (list; `session_storage.mount_path`) and
   `lifecycle_configuration` (`idle_runtime_session_timeout` + `max_lifetime`). No
   provider bump / no CloudControl escape hatch. (Schema dumped from the locked provider.)
2. ✅ **Claude resume mechanics** — `--session-id <uuid>` forces the id (new-session-only;
   reuse errors "already in use"), `CLAUDE_CONFIG_DIR` relocates the store, JSONL filename
   = the UUID, and a separate process recalled a seeded codeword. **Strictly cwd-scoped**
   (different cwd → "No conversation found").
3. ✅ **Kiro resume mechanics** — `--resume-id <id>` recalled a seeded codeword from a
   separate process; works **across cwd** (only `--list-sessions`/`-r` are cwd-keyed).
   Capture the id post-run via `kiro-cli chat --list-sessions --format json` (newest by
   `updatedAt`).
4. ✅ **Kiro store relocation on Linux** — verified inside a Linux image mirroring the
   agentcore Dockerfile: `XDG_DATA_HOME` is honored; store at
   `$XDG_DATA_HOME/kiro-cli/data.sqlite3`; `~/.kiro/settings` is config only. A Dockerfile
   `ENV XDG_DATA_HOME=/mnt/workspace/.kiro-data` suffices — no symlink.
5. ✅ **cwd identity** — both paths spawn with `cwd = V2_WORKSPACE_DIR`; keep it
   byte-identical between fresh and resume (required for Claude's slug + Kiro's capture).

## Decisions (resolved)

- **D1 — Compute release on park = configurable per project, default 5 min.** After a
  park the session goes idle. How long to keep its compute warm before releasing it (via
  `StopRuntimeSession`) is a **per-project setting** the trigger/resume lambda reads from
  DynamoDB (set in `Admin.tsx`, alongside the existing per-project `cliModels`). **Default
  300s (5 min).** `0` = stop immediately; larger = keep warm longer, **bounded by the
  runtime-level `idle_runtime_session_timeout` backstop** (a per-project value above it has
  no effect — the runtime reaps first). The runtime backstop stays at 900s so normal
  between-stage gaps (which the lambda doesn't manage) stay warm. Requires a
  `bedrock-agentcore:StopRuntimeSession` IAM grant on the lambda. This lives in the
  **not-yet-built** trigger/resume lambda — captured as a requirement in
  [`v2-open.md`](./v2-open.md); no runtime-side code in this change.

- **D2 — Wipe/expiry handling = split by cause (re-init for redeploy, hard-fail for
  expiry).** Managed session storage is wiped both on **runtime version update** (every
  image redeploy) and after **14 days** idle. The durable artifacts/answers live in
  DynamoDB/Neptune; only the in-progress CLI conversation + uncommitted working-tree edits
  are on the mount. **Redeploy is not survivable for parked sessions** — version
  stickiness keeps only _live_ compute on the old version; a parked session's compute is
  already terminated, so its next invoke after a version update gets a fresh (wiped) file
  system (AWS-documented; not locally verifiable). So resume handles a missing store by
  the age of the gate (`askedAt` in DynamoDB):
  - **gate asked < 14 days ago** → treat as a redeploy wipe → **graceful re-init**: typed
    `resume_store_missing` → re-run `init-ws` (re-clone at branch) + re-run the stage
    fresh, **injecting the answered gate's Q&A into the prompt** so the agent does not
    re-ask. Routine deploys never strand work.
  - **gate asked ≥ 14 days ago** → storage idle-expiry → **hard fail** the resume and
    surface a **UI warning** on the stale/old project.

- **D3 — Support both CLIs now.** Implement park/resume for **both** Claude (forced
  `--session-id`) and Kiro (post-run `--list-sessions --format json` id capture). Both are
  verified above; no CLI is out of scope.

## Remaining implementation notes

- **Multiple parked questions per stage** — `cliSessionId` is stable across resumes (same
  conversation); resume targets the latest answered, unprocessed gate.
