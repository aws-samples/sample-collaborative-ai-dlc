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
- Jira attachment references are replaced with their corresponding filenames in
  the original text position when they can be resolved. Unresolved references
  keep a placeholder.
- A source badge links back to the originating issue, and the link is stored on the intent.
- After the draft opens, supported issue attachments are imported automatically.
  Imported files appear in the attachment list. **Files from the source issue**
  shows pending, skipped, or failed files and disappears when every file has
  imported successfully, including after reopening the draft. **Retry import**
  checks again and imports only files missing from the draft.

You can edit the imported prompt freely before starting.

File imports use the same [formats and limits](#reference-attachments) as manual
uploads. A file failure leaves the imported title, prompt, and comments intact.
Each imported file retains the source issue, attachment URL, and, where the
provider exposes it, the comment that referenced it. Stay on the draft while
import runs; if you leave, the remaining files are shown when you return and can
be retried manually. Previous error messages are not stored; missing files show
as **not imported** until retried.

| Tracker       | Attachment support                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Issues | Uploaded files and images referenced in the description or comments, including older repository `/files/` URLs. Private images use temporary signed URLs from GitHub's rendered issue/comment content when available, including with GitHub App connections. Other files must be accessible with the project's connected credential. |
| GitLab Issues | Project Markdown uploads (`/uploads/<secret>/<filename>`) in the description or comments, downloaded through the project's authenticated uploads API.                                                                                                                                                                                |
| Jira Cloud    | Native issue attachments, including files embedded in the description or comments, using the importing user's Jira connection. Jira does not identify the originating comment in its attachment list.                                                                                                                                |

Links to arbitrary external storage are not downloaded. Links to supported file
formats outside GitHub's and GitLab's upload locations are shown as skipped;
Jira import uses its native attachment list. Legacy Office files (`.doc`, `.xls`) and
OpenDocument files remain unsupported. The importer copies original files; it
does not convert them.

### Scope

The scope decides **which workflow stages execute** — it comes from the pinned workflow's compiled scopes. A `bugfix` scope runs a lean subset; a `greenfield` scope runs the full methodology. Pick the smallest scope that honestly covers the work.

### Base branch

Optional — collapsed by default, and defaulting to each repository's own default branch. Expand the section to pick a different base branch **per repository**: the platform fetches the live branch list from the code host (GitHub and GitLab) and marks each repository's actual default. The intent branch is created off the chosen base, and the pull request opens back onto it.

Only repositories where you explicitly picked a branch are overridden; all others use their default.

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

### Reference attachments

While composing a draft, choose **Attach files** to provide reference material
for the agents. Supported formats are PDF, DOCX, XLSX, TXT, Markdown, CSV,
HTML, PNG, JPEG, WebP, and SVG. You can attach up to **50 files**, each at most
**5 MB**, with **25 MB** combined (limits use 1 MB = 1,048,576 bytes).

The original files are made available read-only in the agent workspace.
Agents decide when to read them; the platform does not automatically convert
them. For PDF, DOCX, and XLSX, the runtime includes MarkItDown to extract text
and tables. This does not include OCR for scanned PDFs or guarantee extraction
of images, charts, or visual layout. Attach important visuals separately as
images and explain their relevance in the prompt.

MarkItDown requires an updated runtime image. For custom environments created
before it was included, an administrator must rebuild on the updated Standard
base and publish the new revision before you create the intent. Existing
intents keep their pinned environment.

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
