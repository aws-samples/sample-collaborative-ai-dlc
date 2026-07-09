# Managing Workflows

Platform administrators can tailor the methodology: fork building blocks, edit stage prompts, and compose custom workflows in a visual composer. This page is the hands-on guide; for the underlying model see [Workflows and building blocks](../concepts/workflows-and-blocks.md).

!!! note "Requires the platform-admin role"

    The **Workflows** entry in the sidebar, the block library, and all workflow/block mutations require membership in the Cognito `platform-admin` group — see [Setup](../getting-started/setup.md#bootstrap-the-first-platform-administrator). Reading workflows and blocks is open to all users.

## The block library

**Workflows → Blocks** opens the library, tabbed by block type: stages, agents, scopes, rules, sensors, artifacts, knowledge, skills, and templates.

- **SYSTEM blocks** (the imported AI-DLC baseline) are read-only and marked with a lock badge. They are pinned to an upstream commit and replaced only when an operator re-seeds.
- **Forking** a SYSTEM block creates an editable copy in the shared user library. The copy **shadows** the SYSTEM block of the same id — every workflow that references the id picks up your version.
- **Creating** a block from scratch works the same way; the stage editor is the richest, covering the stage prompt body, phase, execution mode, lead/support agents, produced/consumed artifacts, sensors, reviewer, and the human-validation flag.

Editing a block affects future intents only — running intents pinned an earlier workflow version.

## The workflow list

**Workflows** lists all workflows. The SYSTEM default (`aidlc-v2`) is read-only; creating your own offers two paths:

- **Start blank** — an empty phase tree to build up.
- **Fork an existing workflow** — reuse its phase tree and placements as a starting point (forked workflows show their origin).

Workflow ids are kebab-case. Deleting a workflow never touches library blocks.

## The composer

Opening a workflow launches the **composer**:

### Phase lanes

The workflow renders as horizontal **phase lanes**, one per phase in the tree. You can:

- Add, rename, reorder, and remove phases (or apply the default phase skeleton).
- Drag stages between lanes and reorder them within a lane.
- Add stages from the **block palette** — a searchable popover over the stage library, with shortcuts to create a new stage or open the library.
- Click a stage chip to edit its placement or the stage block itself.

### Scope wiring

Each placement carries a **scope membership** map: for every scope, whether the stage **executes** or is **skipped**. This is what makes one workflow serve bugfixes and greenfield builds alike.

- New placements default their membership from the SYSTEM baseline for the same stage.
- A placement with no `EXECUTE` in any scope can never run — the composer marks the chip with a warning badge ("No scope — never runs") so dead configuration is caught while authoring, not in a run.

### Scope graph and insights

The composer includes the **workflow scope graph** — the compiled stage DAG (produces → consumes and requires edges) filtered per scope — plus an insights panel surfacing compiled warnings: cycles, orphaned artifacts, zero-scope placements, and the per-stage autonomy profile.

## Versioning and pinning

Every save writes an immutable workflow version. Intents pin the exact version at creation, so edits never disturb runs in flight; the next intent picks up the latest version.

## Re-seeding the baseline

The SYSTEM baseline is imported from [`awslabs/aidlc-workflows`](https://github.com/awslabs/aidlc-workflows) at the commit pinned by the `aidlc_repo_ref` Terraform variable. Operators inherit upstream methodology updates by re-pinning the ref and re-running the seed job — SYSTEM blocks are replaced, user-library forks are never touched.
