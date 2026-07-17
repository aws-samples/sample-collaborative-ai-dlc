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

## Draft, review, start

Creating the intent opens it on the workbench in **DRAFT** state, with a **Review & start** card showing the prompt, scope, and branch (read-only — these are set at creation). Starting the intent:

1. Pins the current workflow version and snapshots the project's runtime settings.
2. Compiles the execution plan for the chosen scope.
3. Checks the repositories out, creates the intent branch, and begins the first stage.

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

## The project intent list

The project page lists all intents with live status (Running, Waiting for input, Completed, Failed), created/updated timestamps, and sorting. The global dashboard surfaces each project's latest intent and floats projects with active work to the top.

Owners and admins can delete non-running intents from the list; deletion removes the intent's artifacts, process history, and discussions.
