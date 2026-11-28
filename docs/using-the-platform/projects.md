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

## Finding your way

You land on the **Spaces** dashboard after signing in. It shows your spaces as cards (switch to a table from the view buttons; the choice is remembered): each card names the repository, what needs someone, and folds its active intents behind one line. Space owners delete a space from the card's menu.

On large screens the sidebar has a **My work** entry and two sections:

- **My work** lists every intent that needs you, across your spaces: questions and resumes first, then failed runs, then runs that have stalled. Each row says what it waits on and in which space, and opens the intent where you are needed. Spaces where you are a Viewer are not listed.
- **Pinned** appears once you **Pin** a space from its row; the pin is remembered for your account in this browser.
- **Spaces** lists the rest of your spaces. Its label opens the Spaces dashboard; click it again there to fold or unfold the list. The chevron next to the label folds or unfolds the list without leaving the page you are on. The right end of the row holds the sort menu and **New space**. Expand a space to see its active intents, most recent first, five at a time with **Show more**; finished intents stay on the space page. Hover a space for its work status counts.

On narrow screens the drawer offers **My work**, **Spaces**, and the intents that need you or are running.

Open a space to see its intents in one list ordered by what to do next: failures come first, then decisions and runs that need resuming, then running work, then finished intents. The list shows 20 at a time. Select anywhere on an intent row to open it; **New intent** sits by the list. Use the filters or the search for a narrower list; the filter, the search and the page are kept in the address, so Back returns to them and a link shares them. An intent in an automatic wait does not ask for your input. **Activity & cost** counts the intents and the average time to completion from the list; owners can compute the total and average tokens and cost, a read of every run that can take up to a minute.

## Creating a space

Choose **New space** on the Spaces dashboard or at the end of the sidebar's **Spaces** row. Enter a name, pick the code host (**GitHub**, **GitLab**, **Bitbucket** or **AWS CodeCommit**), connect your account if prompted, and select the repository. CodeCommit needs no connection step: once a platform admin has set the CodeCommit connection, you pick repositories from the usual list; if it is not configured yet, you can still select it, but a note asks you to contact a platform admin and **Next** stays disabled. You can optionally enable the provider's issue tracker in the same step. See [Git and Tracker Integration](git-integration.md) for details on connections and auth modes.

## Roles and permissions

Two independent layers govern access:

### Space roles

Every space has members with one of three roles, managed in **Space Settings → Members**:

| Role       | Can do                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| **Owner**  | Everything, including managing all members, all settings, and deleting the space           |
| **Member** | Create and start intents, answer gates, steer runs, participate in discussions             |
| **Viewer** | Read content, questions, reviews, discussions, and history; cannot change work or settings |

Non-members have no access to a space's intents, discussions, or real-time channels.
Viewers see “You have view-only access to this space.” Editing and execution
controls are disabled.

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

Add or remove members and assign their space access (Owner / Member / Viewer).
Enterprise users appear after their first successful sign-in. The picker labels
accounts by provider and includes only enabled accounts that can sign in.

Removing a member revokes API access immediately. An open stage editor can accept
edits for up to 30 more seconds. Reconnecting checks access again, including
before syncing offline edits. Existing notification sessions expire within ten
minutes. Re-adding someone does not restore their locally assigned roles or
delegated integration access.

#### Business roles

Business roles describe responsibilities, such as Developer, Architect, or
Product Owner. A stage uses these roles to determine who can edit and decide
among the space's Owners and Members. The same person can have different roles
in each space.

Everyone can see roles in the member list. Owners can select a member's roles
to edit them:

- Add or **Remove** roles assigned in this space.
- **Exclude** a role inherited from [enterprise SSO](../getting-started/enterprise-sso.md#business-role-mappings),
  or **Restore** it later. Exclusions apply only to this space and survive sign-in.
  A role added locally stays active even if the same SSO role is excluded.

The editor shows inherited roles, local assignments, and the resulting roles.

#### Stage responsibilities

The **Stage responsibilities** table below **Members** shows **Decision Makers**
and **Contributors** for the space's workflow. It updates when you save member
roles. Click the crossed-out user icon or unassigned-role count to see missing
assignments.

**Enforce business roles** follows the [platform default](platform-settings.md#users) until a Space Owner
turns the switch on or off in this space. That choice applies to new and in-progress intents and
persists when the platform default changes. Select **Use platform default** to follow it again.
With enforcement off, Owners and Members can edit and decide.
Viewers retain read-only access, and Owner-only actions still require an Owner.

With enforcement on, when no Decision Makers are assigned, Contributors decide; if neither group is
assigned, Owners decide. Viewers are excluded.

Decision Makers and Contributors can edit the shared draft. The people who can
decide can also submit answers, revise a previous answer, and change saved
documents for that stage. Other Members can still participate in discussions.
Open **Who can act?** on a question or stage review to see who can help.

When a stage has no role mapping, including on older intents, Owners and Members
can edit and decide. Only an Owner can grant autonomy or accept an option to
override a blocking finding when the workflow offers it.

Owners and Members can start a new intent with any selected stages, even if
they have no business roles. If several units fail and Collab asks whether
to retry, skip, or stop the section, an Owner or someone who can decide for
all affected stages can answer. A question from a single stage uses that
stage’s own responsibilities.

### Agent

- **Space Agent Credentials** — optional shared Bedrock and Kiro credentials for members without personal credentials. Personal credentials take precedence; platform credentials remain the fallback.
- **Recommended CLI** — marks **Kiro**, **Claude Code**, **OpenCode**, or **Codex** as the space recommendation on the intent compose page. Each user still explicitly selects an available CLI for every new intent. CLIs a platform admin disabled in [Admin → Agents → Agent CLIs](platform-settings.md#agents) cannot be chosen. A new space recommends Kiro, or the first enabled CLI when Kiro is disabled.
- **Model Override** — pin a specific model per CLI for this space. When unset, the platform-wide default model from **Admin → Agents → Default Models** applies. Space overrides take precedence over the stage/agent-level model hints in the workflow.
- **Output Language** — the natural language agents use for prose: artifact content, gate questions and answer options, summaries and review findings. Set as a BCP 47 tag (for example `ko`, `ja`, `pt-BR`); the field previews the resolved name (`Korean (한국어)`). Code, identifiers, file paths, branch names, commit messages, keys and ids in structured YAML/JSON blocks, and upstream's preserved literals (answer tags and options, sentinels, the headings sensors and templates match, register tags, reviewer verdicts) stay in English so machine-parsed structure is unchanged. Unset (the default) keeps the current behaviour — no language instruction, so agents infer the language from the intent text (releases from v2.6.18 also consult project memory first). The value is snapshotted onto each intent at create and can be overridden per intent on the compose page while the intent is a draft; it locks when the run starts. Release-authored script sensors that match English prose may need checking before adopting a non-English language for a space.

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
max parallel units, PR strategy, and output language) are **snapshotted onto
each intent when it is created**. Changing a setting affects the next intent,
never a run already in flight.

## Deleting

- **Intents** can be deleted by space owners when they are not running. Deletion cascades through the whole footprint: graph artifacts, process state, and collaboration threads.
- **Spaces** support deep delete — the space and all of its intents and their data are removed. This cannot be undone.
