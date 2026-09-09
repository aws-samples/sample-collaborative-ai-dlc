# Creating Intents

An **intent** is the unit of agent work: a title and a prompt, scoped to a project, executed by the project's workflow. This page covers creating, starting, and managing intents. For what happens after you start one, see [Observing intents](intent-observability.md).

## The New Intent page

Inside a project, choose **New Intent**. The full-page form has these fields:

### Title

A short human name, for example "Add user authentication". The title also names the intent's git branch: the platform derives a readable slug, so this intent works on `aidlc/add-user-authentication` (name collisions get a short suffix).

### Prompt

What you want built, in free-form text. This is the brief every stage receives, so make it count:

- **What** the feature or system does
- **Who** it is for (users, roles)
- **Constraints** or technical decisions
- **Scope** — what is in and what is out

### Import from tracker

If the project has one or more trackers bound (GitHub Issues, GitLab Issues, Jira Cloud), a tracker panel appears next to the form. Browse open issues and pick one to seed the intent:

- The issue title becomes the intent title.
- The issue body and all comments are imported into the prompt (Jira's rich-text body is converted to Markdown; comments are appended chronologically).
- A source badge links back to the originating issue, and the link is stored on the intent.

You can edit the imported prompt freely before starting.

### Scope

The scope decides **which workflow stages execute** — it comes from the pinned workflow's compiled scopes. A `bugfix` scope runs a lean subset; a `greenfield` scope runs the full methodology. Pick the smallest scope that honestly covers the work.

### Base branch

Optional — collapsed by default, and defaulting to each repository's own default branch. Expand the section to pick a different base branch **per repository**: the platform fetches the live branch list from the code host (GitHub and GitLab) and marks each repository's actual default. The intent branch is created off the chosen base, and the pull request opens back onto it.

Only repositories where you explicitly picked a branch are overridden; all others use their default.

### Repository directories

Optional — leave blank for a full checkout. For a large repository, expand
**Repository directories** and enter one repository-relative directory per line
for each repository, for example `services/api` and `packages/shared`. Include
shared code and tooling needed to build and test the selected component.

The selection is fixed when you create the intent and reused by retries, parallel
unit workspaces, and restoration after session storage expires. Create a new
intent to change it. API clients can supply the same option on intent creation:

```json
{
  "title": "Update the API",
  "prompt": "Add request validation",
  "sparseCheckout": {
    "owner/monorepo": ["services/api", "packages/shared"]
  }
}
```

Omitted repositories and empty lists retain full checkout. Use directory paths,
not glob patterns or absolute paths. Git cone mode also includes root-level files
and files directly inside the selected directories' ancestors. Files outside the
selection remain in Git history; their absence is not committed as a deletion.
This is a storage optimization, not a restriction on what an agent can access.

The checkout configures the selection **before** materializing the working tree.
Git history is still downloaded in full: selected files, `.git`, and agent state
must fit together within the managed session storage limit (1 GiB), with room for
new work. Large history, large root files, or merge conflicts that materialize
additional files can still exceed it. This option mitigates oversized working
trees; it does not provide general support for repositories over the limit.

## Draft, review, start

Creating the intent opens it on the workbench in **DRAFT** state, with a **Review & start** card showing the prompt, scope, and branch (read-only — these are set at creation). Starting the intent:

1. Uses the workflow, runtime settings, and exact managed-environment revision
   snapshotted when the intent was created.
2. Compiles the execution plan for the chosen scope.
3. Checks the repositories out, creates the intent branch, and begins the first stage.

Select the desired published environment in **Project Settings -> Environment**
before creating the intent. Reassigning the project or publishing a newer
revision afterward does not change an existing intent's image, runtime, or
endpoint. See [Managed tools and environments](managed-environments.md#select-an-environment-for-a-project).

## Intent lifecycle

| State       | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `DRAFT`     | Created, not yet started — review and start it from the workbench    |
| `RUNNING`   | A stage is executing                                                 |
| `WAITING`   | Parked on a human gate — answer it to resume; no compute is consumed |
| `SUCCEEDED` | All in-scope stages passed; a pull/merge request has been opened     |
| `FAILED`    | A stage failed terminally — retry the stage or rewind with guidance  |
| `CANCELLED` | Stopped by a user; pushed work is preserved on the intent branch     |

Terminal states are not dead ends: any executed stage can be [rewound](intent-observability.md#steering-and-rewind) to iterate.

## Continue in a local agent harness

After an intent starts, you can download a point-in-time native AI-DLC workspace for Claude, Codex, Kiro CLI, Kiro IDE, or OpenCode. The export control is beside **Discuss** in the intent header. Choose the harness with the small arrow, then use the adjacent download button.

Running intents export their latest completed workflow checkpoint, so work from the active stage is not included. The handoff is one-way: local decisions, artifacts, and code changes do not synchronize back to the intent. See [Exporting a workspace](exporting-workspaces.md) for the archive contents and setup steps.

## The project intent list

The project page lists all intents with live status (Running, Waiting for input, Completed, Failed), created/updated timestamps, and sorting. The global dashboard surfaces each project's latest intent and floats projects with active work to the top.

Owners and admins can delete non-running intents from the list; deletion removes the intent's artifacts, process history, and discussions.
