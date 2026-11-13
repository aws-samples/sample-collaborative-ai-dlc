# Spaces and Settings

A space is the workspace where intents run. It represents a product, service, or feature area and groups together:

- One or more **git repositories** (the code host backing the agents' workspace)
- **Members** with space-level roles
- **Tracker bindings** (GitHub Issues, GitLab Issues, Jira Cloud)
- A published **managed environment** for new intents
- **Runtime settings** — which agent CLI runs, which models, how parallel construction behaves
- The space's **intents** and their history

!!! note "Earlier name"

    Spaces were called projects in earlier releases. API routes and stored identifiers keep that name, for example `/projects/{projectId}/…` and the `projectId` field, so you will still see it in API calls, logs, and the [data model](../concepts/data-model.md). Old `/project/…` links in the application redirect to the matching `/space/…` page.

## Creating a space

From the dashboard, choose **New Space**. Enter a name, pick the code host (**GitHub**, **GitLab**, **Bitbucket** or **AWS CodeCommit**), connect your account if prompted, and select the repository. CodeCommit needs no connection step: once a platform admin has set the CodeCommit connection, you pick repositories from the usual list; if it is not configured yet, you can still select it, but a note asks you to contact a platform admin and **Next** stays disabled. You can optionally enable the provider's issue tracker in the same step. See [Git and Tracker Integration](git-integration.md) for details on connections and auth modes.

## Roles and permissions

Two independent layers govern access:

### Space roles

Every space has members with one of two roles, managed in **Space Settings → Members**:

| Role       | Can do                                                                           |
| ---------- | -------------------------------------------------------------------------------- |
| **Owner**  | Everything, including managing all members, all settings, and deleting the space |
| **Member** | Create and start intents, answer gates, steer runs, participate in discussions   |

Non-members have no access to a space's intents, discussions, or real-time channels.

Existing space Admins become Owners during update. Space Owner and Platform Admin
remain separate roles. Several Owners are allowed; removing or demoting an Owner
requires another Owner in the space.

### The platform-admin role

Platform-wide administration is gated by the Cognito **`platform-admin`** group — separate from space roles. Platform admins see two extra entries in the sidebar:

- **Workflows** — the [block library and workflow composer](workflows.md). Reading workflows is open to everyone; creating, forking, and editing requires `platform-admin`.
- **Admin** — the [Platform Admin page](platform-settings.md): user management, agent credentials and default models, source-control configuration, and tracker OAuth apps.

The first platform admin is bootstrapped via the CLI during [setup](../getting-started/setup.md#bootstrap-the-first-platform-administrator); after that, admins grant or revoke the role in **Admin → Users** (changes apply at the user's next sign-in, and self-demotion is blocked).

## Space settings

**Space Settings** (gear icon on the space page) is a tabbed page. Viewing is open to members; editing requires the Owner space role.

### General

- **Space Name** — rename the space.
- **Runtime** — the space's execution profile. A badge shows the pinned workflow (default `aidlc-v2`). Settings:
  - **Park release (seconds)** — how long an agent session stays warm after parking on a human question before it is stopped (0–900, default 300). Lower values save compute; higher values make near-instant answers resume faster.
  - **Max parallel units** — concurrency cap for parallel construction lanes (0 = unbounded, limited only by the unit dependency graph).
  - **PR strategy** — **Platform default**, **Intent PR**, or **PR per unit**. Existing spaces remain on explicit Intent PR until changed; new spaces inherit the platform default.

### Members

Add or remove members and assign their space access (Owner / Member).
The picker includes enabled, confirmed Cognito accounts and enabled enterprise
identities that pass their provider's access gate. An enterprise user appears
after their first successful sign-in, when Cognito creates the broker identity.
Entries are labeled **Cognito account** or with the enterprise provider name so
separate identities that share an email address remain distinguishable.

Removal revokes REST access and new realtime tokens immediately; an existing
realtime session expires within ten minutes. Delegated integration access is
removed and must be configured again if the person is re-added.

### Agent

- **Space Agent Credentials** — optional shared Bedrock and Kiro credentials for members without personal credentials. Personal credentials take precedence; platform credentials remain the fallback.
- **Recommended CLI** — marks **Kiro**, **Claude Code**, **OpenCode**, or **Codex** as the space recommendation on the intent compose page. Each user still explicitly selects an available CLI for every new intent. CLIs a platform admin disabled in [Admin → Agents → Agent CLIs](platform-settings.md#agents) cannot be chosen. A new space recommends Kiro, or the first enabled CLI when Kiro is disabled.
- **Model Override** — pin a specific model per CLI for this space. When unset, the platform-wide default model from **Admin → Agents → Default Models** applies. Space overrides take precedence over the stage/agent-level model hints in the workflow.

### Environment

- **Environment** — select the published toolchain used by newly created
  intents. The panel shows the exact published revision, image digest, runtime
  compatibility version, and included tools.
- **Compatibility warnings** — detected repository stacks are compared with
  the selected tools. Warnings are advisory and do not block assignment.
- **Standard fallback** — spaces without an explicit assignment use the
  protected Standard Node.js/Python environment.

Choose **Assign Environment** before creating the intent that should use it.
Changing the assignment does not move an existing intent to another runtime.
See [Managed tools and environments](managed-environments.md#select-an-environment-for-a-space)
for publication, selection, and snapshot behavior.

### Source Control

- **Repositories** — add or remove the repositories that agents check out. Multi-repository spaces are supported; at intent creation you can pick a base branch per repository. For CodeCommit, repositories come from the shared platform connection; a space created before the connection existed (or before a connection change) keeps working on its original role and moves to the current connection the next time an owner runs **Rebind and verify**.
- **PR strategy** — select whether the space inherits the platform delivery default or explicitly uses Intent PR / PR per unit.

### Trackers

- **Tracker bindings** — bind GitHub Issues, GitLab Issues, or one or more Jira Cloud projects so intents can be started from issues. See [Binding a tracker to a space](git-integration.md#binding-a-tracker-to-a-space).

## Settings snapshots

Runtime-relevant settings (CLI, models, environment revision, park release,
max parallel units, and PR strategy) are **snapshotted onto each intent when it
is created**. Changing a setting affects the next intent, never a run already
in flight.

## Deleting

- **Intents** can be deleted by space owners when they are not running. Deletion cascades through the whole footprint: graph artifacts, process state, and collaboration threads.
- **Spaces** support deep delete — the space and all of its intents and their data are removed. This cannot be undone.
