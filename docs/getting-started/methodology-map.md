# AI-DLC Terms, Mapped to the Platform

The upstream [AI-DLC methodology](https://github.com/awslabs/aidlc-workflows) ships as markdown files and CLI tools with its own vocabulary. This platform implements the same methodology — but as a collaborative product, so several terms show up under different names or behind different buttons.

Use this page as a translation table: if you know AI-DLC, it tells you where each concept lives here; if you're new, it doubles as a plain-language tour of the methodology.

## Quick reference

| AI-DLC term                      | In this platform                      | Where you find it                                              |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| Intent                           | **Intent**                            | Project page → _New Intent_                                    |
| Phase / Stage                    | **Phase / Stage**                     | Workflow composer, intent progress view                        |
| Scope                            | **Scope**                             | Compose page (scope picker)                                    |
| Scope grid (EXECUTE/SKIP)        | **Composed stage grid**               | Compose page → _Customize stage grid_                          |
| Composer agent                   | **Compose with AI**                   | Compose page → _Compose_ button                                |
| Keyword scope inference          | **Deterministic keyword match**       | Automatic; toggle in Admin → _Composer_                        |
| Report compose                   | **Compose from report**               | Compose page → upload button next to _Compose_                 |
| Validate-grid / stage counts     | **Run-shape summary**                 | "Runs N of T stages · G approval gates" under the scope picker |
| Approval gate                    | **Gate** (question / validation)      | Intent view → _Questions for you_                              |
| "Skip to stage X"                | **Skip option on a gate**             | Validation gate → skip select                                  |
| Stage deselection                | **Skip stages**                       | Compose page → _Skip stages_ checkboxes                        |
| In-flight recompose              | **Reshape remaining stages**          | Intent view (parked or failed run)                             |
| Rewind / "Add skipped stage"     | **Rewind**                            | Intent view → stage list                                       |
| Unit of work / Bolt              | **Unit lane**                         | Intent view → unit lane board                                  |
| Walking skeleton                 | **Walking skeleton lane**             | First lane of parallel construction, with its own gate         |
| Autonomy mode (gated/autonomous) | **Autonomy choice**                   | One-time gate after the skeleton merges                        |
| Sensor                           | **Sensor**                            | Stage results in the intent view; blocks in the library        |
| Reviewer                         | **Reviewer**                          | Stage review verdicts in the intent view                       |
| Memory rules (org/team/project)  | **Rule blocks** (layered)             | Block library; attached to workflows                           |
| Learnings                        | **Learning rules**                    | Accrued automatically on the project graph                     |
| Knowledge                        | **Knowledge blocks + team knowledge** | Block library; accrued at runtime                              |
| Agent tiers                      | **Tier → model mapping**              | Admin / project settings → model configuration                 |
| Workspace detection              | **Initialization stages**             | Run automatically at the start of every intent                 |
| Conductor / state file           | **The execution engine**              | Invisible — surfaced as the intent timeline                    |
| Mob elaboration / construction   | **Real-time collaboration**           | Shared editing on drafts, gates, and artifacts                 |

The sections below walk through the same mapping in the order you meet it as a user.

## Starting work

### Intent

Unchanged in meaning: an intent is one piece of work — a prompt plus a projection of the workflow to run for it. Upstream you type `/aidlc <prompt>`; here you press **New Intent**, enter a title and prompt (or import a tracker issue), and land on the **compose page**. Details: [Creating intents](../using-the-platform/creating-intents.md).

Everything on the compose page is **collaborative** — teammates who open the same draft edit the prompt and the stage selection together, live.

### Scope

Identical concept: a scope (like `feature` or `bugfix`) decides **which stages execute** for this intent. Upstream stores scopes as markdown files with keyword lists; here they are Scope blocks in the [block library](../concepts/workflows-and-blocks.md), and the compose page offers them in a picker.

### The composer — "Compose with AI"

Upstream v2 calls this **Adaptive Workflows**: a composer agent that proposes the projection that fits your task instead of making you pick one. Here it is the **Compose** button:

1. **Deterministic first.** If your prompt cleanly matches exactly one scope's keywords (say, "hotfix" → `bugfix`), the platform answers instantly with no AI call — the same keyword routing upstream does. An administrator can turn this bypass off (Admin → _Composer_), forcing every compose through the agent.
2. **The composer agent otherwise.** The AI reads your prompt, the compiled run shapes of every stock scope, and (optionally) your steering instructions, then proposes either a stock scope (_matched_) or a custom stage grid (_custom_), with a rationale per skipped stage.
3. **You decide.** A proposal is never applied automatically. It shows the _validated_ run shape — real numbers from the plan compiler, not the AI's claims — and you press **Apply proposal** (or ignore it).

### Composed stage grid

Upstream custom scopes are new markdown files plus a grid entry. Here a custom selection is a **composed grid** that lives on the intent itself: open **Customize stage grid** on the compose page and flip any stage between run and skip, grouped by phase. Rules the platform enforces for you:

- **Initialization stages always run** (they set up the workspace) — they are locked in the editor.
- Every change is **re-validated instantly**: the run-shape summary updates, and a grid that would starve a stage of its required inputs blocks Start with a clear error.
- Picking a stock scope again discards the grid; **reset to scope** does the same from the editor.

### Compose from a report

Upstream's _report compose_ (`/aidlc compose --report`) triages an external analysis report — for example a code-scanner export — into a compact fix-and-ship run. Here: press the upload button next to _Compose_, pick a JSON report, and the composer proposes a projection that addresses its findings.

### Run-shape summary

Upstream's `validate-grid` prints "N of T stages, G approval gates". Here that exact summary — computed by the same plan compiler that will run the intent — appears live under the scope picker: **"Runs 24 of 32 stages · 18 approval gates"**. What you confirm is what runs.

### Skip stages

Independent of grids, you can deselect individual **CONDITIONAL** stages for one intent (upstream's create-time deselection). Only stages the methodology marks optional are offered; required stages and initialization never appear. If a grid later excludes a stage you had deselected, the grid simply absorbs the redundant skip.

## Steering a running intent

### Gates

Upstream stages stop and print numbered options in the terminal. Here every stop is a **gate** in the intent view: structured questions with options and free-text, validation gates with **Approve** / **Request changes**, and engine gates (fan-out approval, autonomy choice, failure handling). A parked intent consumes **zero compute** until someone answers — and gates are answered collaboratively, with shared drafts and steering notes.

Validation gates also name the **computed next stage** ("approve to continue to code-generation"), never a guess — same as upstream 2.2.6.

### Skip to stage X

An approved validation gate can jump ahead: pick a later stage from the skip select and every skippable stage in between is marked skipped. Same rules as upstream — only CONDITIONAL stages can be jumped over, and the target stage always runs in full.

### Reshape remaining stages (in-flight recompose)

Upstream's in-flight recompose lets you flip pending stages while a workflow runs. Here it is the **Reshape remaining stages** panel, visible when a run is parked or failed:

- **Ask composer** — the composer agent sees the live progress and proposes flips for pending stages only.
- **Or edit by hand** — the same grid editor, with everything that already ran locked.
- Applying **relaunches** the run at the first not-yet-done stage. The past is frozen: completed stages stay completed, and un-skipping something that already got skipped is the job of…

### Rewind

…the **rewind**: restart the run from an earlier stage, optionally with corrective guidance the restarted stage receives. Rewinding to a stage you deselected at creation un-skips it — upstream calls this "Add Skipped Stage".

One guardrail applies everywhere, exactly as upstream: while construction runs **autonomously**, reshaping is disabled — let the swarm finish or drop back to gated first.

## Construction at scale

### Units of work and lanes

Upstream's Bolt swarm becomes **unit lanes**: the methodology decomposes construction into units of work with a dependency graph, a human approves the fan-out, and then each unit runs in its own agent session, workspace, and git branch. The **unit lane board** in the intent view shows every lane's live state.

- The **walking skeleton** — the foundational unit — runs solo first, with its own approval gate.
- Then you make the **autonomy choice** once: run the remaining lanes fully autonomously, or gate every batch.
- The engine merges finished lanes back **deterministically**, in dependency order. No AI decides scheduling.

## Quality and memory

### Sensors, reviewer, human validation

The three verification axes are identical to upstream:

1. **Sensors** — deterministic scripted checks after each stage (advisory or blocking).
2. **Reviewer** — a clean-room reviewer agent rendering READY / NOT-READY with bounded retries.
3. **Human validation** — the approval gate on every non-initialization stage.

All three surface in the intent view per stage, with the sensor detail explaining any non-pass verdict.

### Rules, learnings, knowledge

Upstream's memory files (`org.md` → `team.md` → `project.md` plus phase rules) are **Rule blocks** on the layered chain `org → team → project → phase → stage`, attached to workflows. **Learnings** — corrections agents record during runs — accrue as learning rules on the project graph and are injected into every later relevant stage, so nothing gets re-explained. **Knowledge** blocks carry each agent persona's methodology expertise, and **team knowledge** accrues alongside at runtime.

### Agent tiers

Upstream authors each agent with a work-shaped tier — `judgment`, `balanced`, or `templated` — and projects it to a concrete model per tool. Here the same tiers map to models in the Admin (or project) model settings, so a templated planner never burns your most expensive model.

## What you never have to touch

Some upstream machinery has no user-facing counterpart here because the platform does it for you:

| Upstream mechanism                          | Here                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The conductor / forwarding loop             | A durable execution engine drives the plan; you only ever see gates and the timeline                           |
| Markdown state file + audit log             | The process store and the intent **timeline** ([observability](../using-the-platform/intent-observability.md)) |
| Workspace detection / scaffolding stages    | Run automatically as the first (initialization) stages of every intent                                         |
| `aidlc doctor`                              | Plan validation happens **before** an intent can start; problems are synchronous, explained errors             |
| Manual git (branches, commits, merges, PRs) | Engine-owned: branches per intent and per lane, commits after every stage, the PR at fan-in                    |

## Related pages

- [Methodology](methodology.md) — why AI-DLC, and what the platform adds over markdown-only setups
- [Workflows and building blocks](../concepts/workflows-and-blocks.md) — the block model behind these terms
- [Creating intents](../using-the-platform/creating-intents.md) — the compose page, hands-on
- [Execution model](../concepts/execution.md) — how a run actually executes
