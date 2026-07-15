# Git and Tracker Integration

AIDLC Collaborative integrates with external systems on two independent axes:

- **Code host** — GitHub, GitLab, or Bitbucket. The repository is cloned into the agent workspace and all code changes flow back as a pull request (GitHub, Bitbucket) or merge request (GitLab).
- **Issue trackers** — GitHub Issues, GitLab Issues, Bitbucket Issues, and Jira Cloud. A sprint can be started from any tracker issue; the issue's title, body, and comments become the sprint's brief for the agent.

A project can bind to _one_ code host and to _zero or more_ trackers. Both are configured per project in **Project Settings**.

GitHub, GitLab, and Bitbucket each span both axes: a single connection serves as the code host **and** backs that provider's issue tracker (GitHub Issues / GitLab Issues / Bitbucket Issues), so you authenticate once per provider. Jira Cloud is a tracker only.

## Operator setup (one time per deployment)

Before users can connect their accounts, an administrator registers OAuth apps with each provider and pastes the credentials into the platform. See [Setup → Configure provider OAuth apps](../getting-started/setup.md#configure-provider-oauth-apps) for the full walkthrough.

The status of each provider is visible in **Admin → Tracker OAuth Apps**. Until a provider shows **Configured**, the corresponding **Connect** button in Project Settings stays disabled with a hint pointing back to the admin panel.

## Connecting your account

Each user connects their own GitHub / GitLab / Bitbucket / Atlassian account once; the connection is reused across every project that needs that provider.

- **GitHub**: from the dashboard (or the project-creation flow), click **Connect GitHub** and approve the OAuth flow. The button stays disabled if your administrator hasn't configured GitHub OAuth credentials yet.
- **GitLab**: choose **GitLab** as the provider in the project-creation flow, then click **Connect GitLab** and approve the OAuth flow. The button stays disabled until your administrator has configured GitLab OAuth credentials. GitLab access tokens are short-lived; the platform refreshes them automatically using the stored refresh token, so you don't need to reconnect periodically.
- **Bitbucket**: choose **Bitbucket** as the provider in the project-creation flow, then click **Connect Bitbucket** and approve the OAuth flow. The button stays disabled until your administrator has configured Bitbucket OAuth credentials. Bitbucket access tokens are short-lived (~2 hours); the platform refreshes them automatically using the stored refresh token, so you don't need to reconnect periodically.
- **Jira Cloud**: open **Project Settings → Trackers → Connect Jira Cloud**. After the Atlassian consent screen, if your account has access to multiple Atlassian sites you'll be asked to pick one. The chosen site is remembered; you can disconnect and reconnect later to change it.

A connection is scoped to its provider: connecting GitHub does not satisfy a GitLab or Bitbucket project (and vice versa). Each project uses the connection matching its selected code host.

## Selecting a code repository

1. Click **Create new Project** in the project overview.
2. Choose the code host — **GitHub**, **GitLab**, or **Bitbucket**.
3. The platform checks for an active connection to that provider and prompts you to connect if one is missing.
4. Pick the repository (GitHub, Bitbucket) or project (GitLab) that should back the collaborative project.

The repository is cloned into the agent workspace and becomes available to the LLM assistant and agents during inception, construction, and review.

## Binding a tracker to a project

A tracker binding tells the platform which external project to list issues from when starting a sprint. The same collaborative project can be bound to multiple trackers — for example, GitHub Issues for the platform's own bug tracker plus Jira Cloud for the team's product backlog.

In **Project Settings → Trackers**:

- **GitHub Issues**: click **Add GitHub Issues for `<owner>/<repo>`**. The repository name comes from the project's code-host setting. Shown for GitHub-backed projects.
- **GitLab Issues**: click **Add GitLab Issues for `<group>/<project>`**. The project path comes from the project's code-host setting. Shown for GitLab-backed projects.
- **Bitbucket Issues**: click **Add Bitbucket Issues for `<workspace>/<repo>`**. The repository name comes from the project's code-host setting. Shown for Bitbucket-backed projects.
- **Jira Cloud**: click **Add Jira project**, pick the Jira project to bind, and confirm. You can repeat this to bind multiple Jira projects to the same collaborative project.

You can also enable the matching git-issues tracker in one step at project creation by checking **Enable GitHub/GitLab/Bitbucket issue integration**.

When a project has more than one tracker bound, the project page renders a tab strip above the issue list — one tab per binding, labeled with the provider and external project key.

## Starting a sprint from an issue

On the project page, the **Start a sprint from a … issue** panel lists open issues from the bound tracker. Click **Start sprint** on any issue. The sprint is created with:

- The issue title as its name
- The issue body and any comments rendered as Markdown into the sprint description (Jira's ADF body is converted to Markdown server-side; comments are appended in chronological order)
- A polymorphic link back to the originating tracker resource so the agent can reference it

Issues already linked to an existing sprint show **Open sprint** instead of **Start sprint**, scoped per binding so the same numeric ID across two trackers (`PROJ-1` vs `OTHER-1`) doesn't collide.

The Jira and GitLab Issues integrations are **read-only** — the agent never writes back issue comments or status changes. (On the code-host side, the agent does open a pull request / merge request and posts review results back to it — see [Reviews](#reviews).)

## Reconnecting a tracker

If a provider refresh token is revoked (for example, a user logs out of Atlassian or GitLab, or a workspace admin revokes the app), the tracker panel surfaces a **Reconnect** banner for that provider. The binding is preserved — only the user's authentication needs renewing — so reconnecting restores access without losing the project↔tracker relationship.

For GitLab specifically, routine token expiry does **not** require reconnecting: access tokens are refreshed automatically from the stored refresh token. A reconnect is only needed if that refresh token itself is revoked.

## Migrating from legacy issue integration

If your install pre-dates the tracker provider abstraction (issue #194), some projects may still carry the old `issue_integration_enabled` boolean and the GitHub-specific `issue_number` / `issue_url` fields on their sprints. The platform reads both shapes side-by-side, so legacy projects keep rendering exactly as before — but they cannot bind a Jira project (or any future provider) until they're migrated onto the new shape.

Migration is **always optional** and **fully reversible-by-omission**: nothing is deleted. The legacy fields, the dual-shape readers, the migration banner, the per-project endpoint, and the bulk Lambda all stay deployed indefinitely. There is no deprecation cycle.

Three paths exist, all idempotent and equivalent:

- **Per project, in-product**: open the affected project's page or settings. A "Migrate to the new tracker data model" banner appears for owners and admins. Click **Migrate now**. The banner self-dismisses on success.
- **Bulk, from the Admin page**: open **Admin → Tracker Migration**. The card displays a count of projects + sprints still on the legacy shape; click **Migrate all** to convert everything in one shot. Re-clicking is a no-op.
- **Bulk, from the CLI**: invoke the `migrate-tracker-fields` Lambda directly for installs that prefer shell access. Supports a `{"dryRun": true}` payload for previewing.

  ```bash
  aws lambda invoke \
    --function-name "$(terraform output -raw migrate_tracker_fields_lambda_name)" \
    --payload '{"dryRun":true}' --cli-binary-format raw-in-base64-out /tmp/out.json
  ```

All three paths share the same shared core (`lambda/shared/tracker-migration.js`), so they cannot drift. After migrating, [GitHub Issues](#binding-a-tracker-to-a-project) and [Jira Cloud](#binding-a-tracker-to-a-project) bindings can be added on the affected project's settings page like any other.

Why nothing is removed: this is open source. Downstream forks are on their own upgrade timelines, and we cannot tell when (or whether) a fork has finished migrating its own data. Removing the safety nets would risk silently emptying sprint pages on installs that haven't yet caught up, so they stay forever.

## Reviews

The platform opens a pull request (GitHub) or merge request (GitLab) on the bound code host once construction finishes. You can start a review on the platform; the review results are written back as a comment on that pull/merge request.
