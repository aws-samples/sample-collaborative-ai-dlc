# Git and Tracker Integration

AIDLC Collaborative integrates with external systems on two independent axes:

- **Code host** — GitHub, GitLab or Bitbucket. The repository is cloned into the agent workspace and all code changes flow back as a pull request (GitHub / Bitbucket) or merge request (GitLab).
- **Issue trackers** — GitHub Issues, GitLab Issues, Bitbucket Issues, and Jira Cloud. An intent can be started from any tracker issue; the issue's title, body, and comments become the intent's brief for the agent.

A project can attach one or more repositories and zero or more trackers. Repository authorization is configured explicitly per project in **Project Settings**.

GitHub, GitLab and Bitbucket each span both axes: a single connection serves as the code host **and** backs that provider's issue tracker (GitHub Issues / GitLab Issues / Bitbucket Issues), so you authenticate once per provider. Jira Cloud is a tracker only.

## Operator setup (one time per deployment)

Before users can connect their accounts, an administrator registers OAuth apps with each provider and pastes the credentials into the platform. See [Setup → Configure provider OAuth apps](../getting-started/setup.md#configure-provider-oauth-apps) for the full walkthrough. Admin pages require the Cognito `platform-admin` group.

The status of each provider is visible in **Admin → Trackers**. Until a provider shows **Configured**, the corresponding **Connect** button in Project Settings stays disabled with a hint pointing back to the admin panel.

### Project-bound authentication

GitHub OAuth and GitHub App configuration remain available at the same time. There is no platform-wide runtime mode:

- A project owner or admin selects **GitHub OAuth** or **GitHub App** for that project's GitHub repositories.
- A project may use only one GitHub authentication type, but different projects may choose differently.
- OAuth delegation is explicit. The owner/admin can delegate only their own connected identity and must confirm that the project may act through it.
- For GitHub App bindings, the platform discovers and stores the installation for each repository. No global installation ID is configured.
- GitLab repositories use an explicitly delegated GitLab OAuth connection.

Every repository is verified before any binding is written. Existing repository-backed projects remain unbound after upgrade and cannot start until an owner/admin completes this step. Repository-free projects are unaffected.

## Connecting your account

Each user connects their own GitHub / GitLab / Atlassian account once. A personal connection is available for repository discovery, but a project uses it only after an owner/admin explicitly delegates it.

- **GitHub**: from the dashboard (or the project-creation flow), click **Connect GitHub** and approve the OAuth flow. The connection requests `repo`, `workflow`, and `read:user` so the engine can also push workflow-file changes. After upgrading an older connection that lacks `workflow`, click **Reauthorize GitHub** when prompted. The button stays disabled if your administrator hasn't configured GitHub OAuth credentials yet.
- **GitLab**: choose **GitLab** as the provider in the project-creation flow, then click **Connect GitLab** and approve the OAuth flow. The required `api` scope covers repository writes, including `.gitlab-ci.yml`; GitLab has no separate workflow-file scope. The button stays disabled until your administrator has configured GitLab OAuth credentials. GitLab access tokens are short-lived; the platform refreshes them automatically using the stored refresh token, so you don't need to reconnect periodically.
- **Bitbucket**: choose **Bitbucket** as the provider in the project-creation flow, then click **Connect Bitbucket** and approve the OAuth flow. The connection requests the `account`, `repository`, `repository:write`, `pullrequest` and `pullrequest:write` scopes. The button stays disabled until your administrator has configured Bitbucket OAuth credentials. Bitbucket access tokens are short-lived (~2h); the platform refreshes them automatically from the stored refresh token, so you don't need to reconnect periodically.
- **Jira Cloud**: open **Project Settings → Trackers → Connect Jira Cloud**. After the Atlassian consent screen, if your account has access to multiple Atlassian sites you'll be asked to pick one. The chosen site is remembered; you can disconnect and reconnect later to change it.

A connection is scoped to its provider: connecting GitHub does not satisfy a GitLab project (and vice versa). Each project uses the connection matching its selected code host.

## Selecting a code repository

1. Click **Create new Project** in the project overview.
2. Choose the code host — **GitHub**, **GitLab** or **Bitbucket**.
3. For GitHub, choose the authentication type: **GitHub App** (uses the platform App's installations — no personal connection needed) or **My GitHub OAuth identity** (delegates your own connection). GitLab and Bitbucket always delegate your OAuth identity. On the OAuth paths the platform prompts you to connect if no active connection exists.
4. Pick the repository (GitHub / Bitbucket) or project (GitLab) that should back the collaborative project. On the App path the picker lists the repositories the App is installed on; on the OAuth paths it lists your own.
5. Confirm the binding (OAuth delegation requires an explicit confirmation). If verification fails, the project is created unbound — rebind it in **Project Settings → Repositories** before starting intents.

The repository is cloned into the agent workspace and becomes available to the agents while an intent executes. Additional repositories can be added later in **Project Settings → Repositories**; the project binding must then be reverified.

## Branches

All git operations are owned by the engine — agents never run git and never hold credentials:

- Each intent works on its own branch, `aidlc/<title-slug>`, derived from the intent title.
- The branch is created off the **base branch** — by default each repository's own default branch, overridable per repository at intent creation (see [Creating intents → Base branch](creating-intents.md#base-branch)).
- During parallel construction, each unit of work gets a section-specific per-unit branch. Intent PR delivery merges it through the engine; PR-per-unit delivery opens draft unit-to-intent reviews and serializes readiness in dependency order.
- The engine commits and pushes after every stage, so work is durable even if a run is cancelled.
- On success, the pull/merge request opens from the intent branch onto the base branch.

## Binding a tracker to a project

A tracker binding tells the platform which external project to list issues from when starting an intent. The same collaborative project can be bound to multiple trackers — for example, GitHub Issues for the platform's own bug tracker plus Jira Cloud for the team's product backlog.

In **Project Settings → Trackers**:

- **GitHub Issues**: click **Add GitHub Issues for `<owner>/<repo>`**. The repository name comes from the project's code-host setting. Shown for GitHub-backed projects.
- **GitLab Issues**: click **Add GitLab Issues for `<group>/<project>`**. The project path comes from the project's code-host setting. Shown for GitLab-backed projects.
- **Jira Cloud**: click **Add Jira project**, pick the Jira project to bind, and confirm. You can repeat this to bind multiple Jira projects to the same collaborative project.

You can also enable the matching git-issues tracker in one step at project creation by checking **Enable GitHub/GitLab issue integration**.

When a project has more than one tracker bound, the project page renders a tab strip above the issue list — one tab per binding, labeled with the provider and external project key.

## Starting an intent from an issue

On the **New Intent** page, use the **Import from tracker** panel to browse open issues from the bound tracker(s). Selecting an issue seeds the intent:

- The issue title becomes the intent title
- The issue body and any comments are imported into the intent prompt (Jira's ADF body is converted to Markdown server-side; comments are appended in chronological order)
- A polymorphic link back to the originating tracker resource is stored so the intent can reference it

On read-only v1 projects, issues that were already linked to a sprint keep their **Open sprint** link, scoped per binding so the same numeric ID across two trackers (`PROJ-1` vs `OTHER-1`) doesn't collide. New sprints can no longer be started from issues.

The Jira and GitLab Issues integrations are **read-only** — the agent never writes back issue comments or status changes. (On the code-host side, the platform does open a pull request / merge request — see [Reviews](#reviews).)

## Reconnecting a tracker

If an OAuth token or refresh token is revoked, every dependent project source-control binding is marked invalid. Reconnect the personal account, then have a project owner/admin explicitly rebind the affected repositories. Removing the delegating member or uninstalling a GitHub App installation also invalidates dependent bindings.

For GitLab and Bitbucket specifically, routine token expiry does **not** require reconnecting: their short-lived access tokens are refreshed automatically from the stored refresh token. A reconnect is only needed if that refresh token itself is revoked.

## Migrating from legacy issue integration

If your install pre-dates the tracker provider abstraction (issue #194), some projects may still carry the old `issue_integration_enabled` boolean and the GitHub-specific `issue_number` / `issue_url` fields on their sprints. The platform reads both shapes side-by-side, so legacy projects keep rendering exactly as before — but they cannot bind a Jira project (or any future provider) until they're migrated onto the new shape.

Migration is **always optional** and **fully reversible-by-omission**: nothing is deleted. The legacy fields, the dual-shape readers, the migration banner, the per-project endpoint, and the bulk Lambda all stay deployed indefinitely. There is no deprecation cycle.

Three paths exist, all idempotent and equivalent:

- **Per project, in-product**: open the affected project's page or settings. A "Migrate to the new tracker data model" banner appears for owners and admins. Click **Migrate now**. The banner self-dismisses on success.
- **Bulk, from the Admin page**: open **Admin → Trackers → Tracker Migration**. The card displays a count of projects + sprints still on the legacy shape; click **Migrate all** to convert everything in one shot. Re-clicking is a no-op.
- **Bulk, from the CLI**: invoke the `migrate-tracker-fields` Lambda directly for installs that prefer shell access. Supports a `{"dryRun": true}` payload for previewing.

  ```bash
  aws lambda invoke \
    --function-name "$(terraform output -raw migrate_tracker_fields_lambda_name)" \
    --payload '{"dryRun":true}' --cli-binary-format raw-in-base64-out /tmp/out.json
  ```

All three paths share the same shared core (`lambda/shared/tracker-migration.js`), so they cannot drift. After migrating, [GitHub Issues](#binding-a-tracker-to-a-project) and [Jira Cloud](#binding-a-tracker-to-a-project) bindings can be added on the affected project's settings page like any other.

Why nothing is removed: this is open source. Downstream forks are on their own upgrade timelines, and we cannot tell when (or whether) a fork has finished migrating its own data. Removing the safety nets would risk silently emptying sprint pages on installs that haven't yet caught up, so they stay forever.

## Reviews

The platform supports two delivery strategies:

- **Intent PR** — completed unit branches are engine-merged into the intent branch. After shared stages pass, one pull request (GitHub / Bitbucket) or merge request (GitLab) opens from intent to base.
- **PR per unit** — every changed repository gets a draft unit-to-intent PR/MR. Draft reviews may happen concurrently, but the platform promotes one dependency-ready unit at a time after reconciling it with the latest intent branch. The final intent-to-base PR/MR still opens after all units and shared stages complete.

In the intent view, each unit card shows repository-specific review state and links. Project members can open **Address feedback**, select up to 20 current human-authored comments, and queue a targeted revision. The backend refetches selected comments by provider ID, records their versions, and ignores provider comments unless a member explicitly selects them. The agent does not automatically resolve discussion threads.

If a unit PR closes without merging, or only part of a multi-repository unit merges, the run enters halt-and-ask with retry, skip, and abort outcomes. Already merged work is preserved.
