# Projects and Settings

A project is the workspace where intents run. It represents a product, service, or feature area and groups together:

- One or more **git repositories** (the code host backing the agents' workspace)
- **Members** with project-level roles
- **Tracker bindings** (GitHub Issues, GitLab Issues, Jira Cloud)
- **Runtime settings** — which agent CLI runs, which models, how parallel construction behaves
- The project's **intents** and their history

## Creating a project

From the dashboard, choose **Create new Project**. Enter a name, pick the code host (**GitHub** or **GitLab**), connect your account if prompted, and select the repository. You can optionally enable the provider's issue tracker in the same step. See [Git and Tracker Integration](git-integration.md) for details on connections and auth modes.

## Roles and permissions

Two independent layers govern access:

### Project roles

Every project has members with one of three roles, managed in **Project Settings → Members**:

| Role       | Can do                                                                           |
| ---------- | -------------------------------------------------------------------------------- |
| **Owner**  | Everything, including managing members, all settings, and deleting the project   |
| **Admin**  | Manage members, settings, repositories, and trackers; delete non-running intents |
| **Member** | Create and start intents, answer gates, steer runs, participate in discussions   |

Non-members have no access to a project's intents, discussions, or real-time channels.

### The platform-admin role

Platform-wide administration is gated by the Cognito **`platform-admin`** group — separate from project roles. Platform admins see two extra entries in the sidebar:

- **Workflows** — the [block library and workflow composer](workflows.md). Reading workflows is open to everyone; creating, forking, and editing requires `platform-admin`.
- **Admin** — the [Platform Admin page](platform-settings.md): user management, agent credentials and default models, source-control configuration, and tracker OAuth apps.

The first platform admin is bootstrapped via the CLI during [setup](../getting-started/setup.md#bootstrap-the-first-platform-administrator); after that, admins grant or revoke the role in **Admin → Users** (changes apply at the user's next sign-in, and self-demotion is blocked).

## Project settings

**Project Settings** (gear icon on the project page) is a tabbed page. Viewing is open to members; editing requires the Owner or Admin project role.

### General

- **Project Name** — rename the project.
- **Runtime** — the project's execution profile. A badge shows the pinned workflow (default `aidlc-v2`). Settings:
  - **Park release (seconds)** — how long an agent session stays warm after parking on a human question before it is stopped (0–900, default 300). Lower values save compute; higher values make near-instant answers resume faster.
  - **Max parallel units** — concurrency cap for parallel construction lanes (0 = unbounded, limited only by the unit dependency graph).
  - **PR strategy** — **Platform default**, **Intent PR**, or **PR per unit**. Existing projects remain on explicit Intent PR until changed; new projects inherit the platform default.

### Members

Add or remove members and assign their project role (owner / admin / member).

### Agent

- **Agent CLI** — which headless CLI executes stages: **Kiro**, **Claude Code**, or **OpenCode**. Availability reflects which credentials the operator has configured in [Platform Admin → Agents](platform-settings.md#agents).
- **Model Override** — pin a specific model per CLI for this project. When unset, the platform-wide default model from **Admin → Agents → Default Models** applies. Project overrides take precedence over the stage/agent-level model hints in the workflow.

### Source Control

- **Repositories** — add or remove the repositories that agents check out. Multi-repository projects are supported; at intent creation you can pick a base branch per repository.
- **PR strategy** — select whether the project inherits the platform delivery default or explicitly uses Intent PR / PR per unit.

### Trackers

- **Tracker bindings** — bind GitHub Issues, GitLab Issues, or one or more Jira Cloud projects so intents can be started from issues. See [Binding a tracker to a project](git-integration.md#binding-a-tracker-to-a-project).

## Settings snapshots

Runtime-relevant settings (CLI, models, park release, max parallel units, PR strategy) are **snapshotted onto each intent when it is created**. Changing a setting affects the next intent, never a run already in flight.

## Deleting

- **Intents** can be deleted by project owners/admins when they are not running. Deletion cascades through the whole footprint: graph artifacts, process state, and collaboration threads.
- **Projects** support deep delete — the project and all of its intents and their data are removed. This cannot be undone.
