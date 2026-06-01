# Git and Tracker Integration

AIDLC Collaborative integrates with external systems on two independent axes:

- **Code host** — currently GitHub. The repository is cloned into the agent workspace and all code changes flow back as a pull request.
- **Issue trackers** — GitHub Issues and Jira Cloud. A sprint can be started from any tracker issue; the issue's title, body, and comments become the sprint's brief for the agent.

A project can bind to *one* code host and to *zero or more* trackers. Both are configured per project in **Project Settings**.

## Operator setup (one time per deployment)

Before users can connect their accounts, an administrator registers OAuth apps with each provider and pastes the credentials into the platform. See [Setup → Configure tracker OAuth apps](../getting-started/setup.md#configure-tracker-oauth-apps) for the full walkthrough.

The status of each provider is visible in **Admin → Tracker OAuth Apps**. Until a provider shows **Configured**, the corresponding **Connect** button in Project Settings stays disabled with a hint pointing back to the admin panel.

## Connecting your account

Each user connects their own GitHub / Atlassian account once; the connection is reused across every project that needs that tracker.

- **GitHub**: from the dashboard, click **Connect GitHub** and approve the OAuth flow. The button stays disabled if your administrator hasn't configured GitHub OAuth credentials yet.
- **Jira Cloud**: open **Project Settings → Trackers → Connect Jira Cloud**. After the Atlassian consent screen, if your account has access to multiple Atlassian sites you'll be asked to pick one. The chosen site is remembered; you can disconnect and reconnect later to change it.

## Selecting a code repository

1. Click **Create new Project** in the project overview.
2. The platform checks for an active GitHub connection and prompts you to connect if one is missing.
3. Pick the repository that should back the project.

The repository is cloned into the agent workspace and becomes available to the LLM assistant and agents during inception, construction, and review.

## Binding a tracker to a project

A tracker binding tells the platform which external project to list issues from when starting a sprint. The same collaborative project can be bound to multiple trackers — for example, GitHub Issues for the platform's own bug tracker plus Jira Cloud for the team's product backlog.

In **Project Settings → Trackers**:

- **GitHub Issues**: click **Add GitHub Issues for `<owner>/<repo>`**. The repository name comes from the project's code-host setting.
- **Jira Cloud**: click **Add Jira project**, pick the Jira project to bind, and confirm. You can repeat this to bind multiple Jira projects to the same collaborative project.

When a project has more than one tracker bound, the project page renders a tab strip above the issue list — one tab per binding, labeled with the provider and external project key.

## Starting a sprint from an issue

On the project page, the **Start a sprint from a … issue** panel lists open issues from the bound tracker. Click **Start sprint** on any issue. The sprint is created with:

- The issue title as its name
- The issue body and any comments rendered as Markdown into the sprint description (Jira's ADF body is converted to Markdown server-side; comments are appended in chronological order)
- A polymorphic link back to the originating tracker resource so the agent can reference it

Issues already linked to an existing sprint show **Open sprint** instead of **Start sprint**, scoped per binding so the same numeric ID across two trackers (`PROJ-1` vs `OTHER-1`) doesn't collide.

The Jira integration is **read-only** — the agent never writes back to Jira. Comments and status changes stay in your team's normal Jira workflow.

## Reconnecting a tracker

If a Jira refresh token is revoked at the provider (for example, a user logs out of Atlassian or the workspace admin revokes the app), the tracker panel surfaces a **Reconnect Jira** banner. The binding is preserved — only the user's authentication needs renewing — so reconnecting restores access without losing the project↔tracker relationship.

## Reviews

The platform creates a pull request on the bound code host once construction finishes. You can start a review on the platform; the review results are written back as a comment on the pull request.
