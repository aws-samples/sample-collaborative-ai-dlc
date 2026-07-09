# Workflows and Building Blocks

The AI-DLC methodology is not hard-coded into the platform. It is imported as data — a library of **building blocks** — and composed into executable **workflows**. This page explains the model; for the hands-on authoring guide see [Managing workflows](../using-the-platform/workflows.md).

## Building blocks

A **block** is the atomic, editable unit of the methodology. There are nine block types, mirroring the upstream [AI-DLC source](https://github.com/awslabs/aidlc-workflows):

| Type          | What it is                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stage**     | The atomic unit of work. Declares its phase, execution mode, lead/support agents, the artifacts it produces/consumes/requires, its sensors, reviewer, and human-validation gate |
| **Agent**     | A domain-expert persona (lead, support, or reviewer) with optional model override and examples                                                                     |
| **Scope**     | A run profile — e.g. feature, bugfix, greenfield. Decides which stages execute for a given intent                                                                  |
| **Rule**      | A layered guardrail on the chain `org → team → team-learnings → project → project-learnings → phase → stage`                                                        |
| **Sensor**    | A deterministic post-stage check: a command plus file-glob matches, backed by an executable script                                                                  |
| **Artifact**  | A named output that wires stages together (produces → consumes); derived from the stage graph so it can't drift                                                     |
| **Knowledge** | A methodology corpus attached to an agent (or shared); team-tier knowledge is accrued at runtime                                                                    |
| **Skill**     | A user-invocable runner pack                                                                                                                                        |
| **Template**  | An authored scaffold                                                                                                                                                |

Phases are not a block type — they are defined inline on each workflow's phase tree.

### The SYSTEM baseline and your library

Blocks live in two ownership namespaces:

- **SYSTEM** — the vendor baseline imported from the upstream AI-DLC repository at a **pinned commit** (`aidlc_repo_ref` in the Terraform variables). Read-only in the API and UI (shown with a lock badge); replaced wholesale when an operator re-seeds against a new upstream ref.
- **Default (user library)** — everything created or forked in the app. A user copy of a block **shadows** the SYSTEM block with the same id, so you can tailor a stage prompt or an agent persona without forking the whole methodology.

Because the baseline is commit-pinned, the platform inherits upstream methodology improvements by re-pinning the ref and re-seeding — your forks are never touched.

## Workflows

A **workflow** composes blocks into an executable plan. It consists of:

- An inline **phase tree** — nestable, ordered phases that group stages for humans (progress bars, diagrams).
- One **placement** per stage — the stage's home phase plus a **scope membership** map: for each scope, `EXECUTE` or `SKIP`.
- **Rule references** per layer of the rule chain.

Every mutation writes an immutable version snapshot. When an intent starts, it **pins the exact workflow version**, so a running intent is never affected by later edits.

### Scopes gate execution

Scope membership is the single execution gate: when an intent starts with scope `bugfix`, the run projects the workflow onto that scope and executes only the placements marked `EXECUTE` for it. This is what lets one workflow serve a two-stage bugfix and a thirty-stage greenfield build.

The platform protects authors from dead configurations:

- A new placement defaults its scope membership from the SYSTEM baseline's placement for the same stage.
- A placement with no `EXECUTE` in any scope can never run — the composer badges it ("No scope — never runs") and the plan builder emits a warning.

### Compiled views

The API serves compiled projections of a workflow that both the composer and the intent UI consume:

- The **scope grid** — which stages execute in which scope.
- The **stage graph** — produces/consumes and requires edges, with cycle and orphan detection.
- The **autonomy profile** — per-stage human-gating roll-up.
- The **rule stack** — the layered rules applicable per stage.

## Verification: three orthogonal axes

Every stage carries three independent safety nets:

1. **Sensors** — deterministic checks (advisory or blocking) run by the engine after the stage exits. A blocking sensor failure fails the stage.
2. **Reviewer** — an LLM-judged reviewer agent that renders a READY / NOT-READY verdict in a clean-room pass, with a bounded iteration count.
3. **Human validation** — an approval gate, required by default on every non-init stage. The run parks at zero compute until a human answers.

## Parallel construction

Construction stages that are marked to run **per unit of work** form a parallel section. At the fan-out point, the methodology's own unit-of-work dependency DAG — produced by an inception stage and approved by a human gate — becomes the schedule:

- Each unit runs as a **lane**: its own agent session, its own workspace, its own git branch.
- A lane starts only when the lanes it depends on have merged.
- The first lane is the **walking skeleton**: it runs solo, with a mandatory approval gate, before the rest fan out.
- After the skeleton, you choose the autonomy level once: continue fully autonomously, or gate every batch.
- Completed lanes are merged back into the intent branch by the engine — serialized, deterministic, in dependency-safe order. Merge conflicts trigger a scoped conflict-resolution stage; a failed lane blocks only its dependents and surfaces a retry / skip / abort gate.

The scheduling is entirely deterministic — no LLM decides what runs when. Concurrency is capped by the project's `maxParallelUnits` setting.

## Where this lives in the product

- **[Managing workflows](../using-the-platform/workflows.md)** — the block library and the visual workflow composer (platform administrators).
- **[Creating intents](../using-the-platform/creating-intents.md)** — where scope selection meets the workflow.
- **[Execution model](execution.md)** — how the compiled plan actually runs.
