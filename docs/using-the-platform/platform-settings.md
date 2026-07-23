# Platform Settings

The **Admin** page holds all platform-wide settings: users, agents, source control, and issue trackers. It is visible in the sidebar only to members of the Cognito **`platform-admin`** group (see [Setup](../getting-started/setup.md#bootstrap-the-first-platform-administrator) for bootstrapping the first admin); every underlying API is independently gated on the same group.

The page is organized into four tabs.

## Users

**User Management** — grant or revoke the platform-admin role for any Cognito user. Changes apply at the user's next sign-in. Self-demotion is blocked, so an installation can never lock itself out of administration.

Day-to-day project access is _not_ managed here — it lives in each project's [Members tab](projects.md#members).

## Agents

Everything the agent runtime needs to run:

- **Agent Credentials** — the **Bedrock Bearer Token** (used by Claude Code, OpenCode, and Codex) and the **Kiro API Key**. Both are stored as SecureString parameters in SSM; the AgentCore runtime reads them at container startup. The card reports which credentials are set and which CLIs are therefore available to projects. See [Prerequisites → Agent authentication](../getting-started/prerequisites.md#agent-authentication).
- **Default Models** — the platform-wide default model per CLI (Kiro, Claude Code, OpenCode, Codex), selected from a dropdown of models discovered from the runtime (or "No default — use CLI built-in"). Codex uses Bedrock's OpenAI models with exact `openai.*` IDs (e.g. `openai.gpt-5.5`) — the chosen model must be available in the deployment Region. Projects can override these per-CLI in [Project Settings → Agent](projects.md#agent).
- **Graph Enrichment** — a switch controlling whether the platform adds LLM-generated summaries to derived artifacts in the knowledge graph (`llm` or `off`). The setting takes effect for the _next_ intent, never mid-run; enrichment spend is metered and surfaced on each intent's Audit page.

## Source Control

Platform-wide code-host configuration:

- **GitHub** — the OAuth app credentials plus the runtime-switchable **authentication mode**: **OAuth** (each user connects their own account; activity attributed to the user) or **GitHub App** (the platform acts as an App installation — a bot; users connect nothing). Switching to App mode is validated live against GitHub before it lands. See [Git integration → GitHub authentication mode](git-integration.md#github-authentication-mode).
- **GitLab** — the GitLab OAuth app credentials.
- **Default PR strategy** — **Intent PR** opens only the final intent-to-base review; **PR per unit** also opens draft unit-to-intent reviews and integrates them in dependency order. Projects may inherit or override this default. The default is **Intent PR**.

## Trackers

Issue-tracker OAuth apps and data migrations:

- **Jira Cloud** — the Atlassian OAuth 2.0 integration credentials.
- **Source-control trackers** — configuration status of GitHub Issues and GitLab Issues (these reuse the Source Control OAuth apps).
- **Tracker Migration** — the one-time bulk migration for installs with pre-#194 data; shows a live count of legacy records and a **Migrate all** action. See [Git integration → Migrating from legacy issue integration](git-integration.md#migrating-from-legacy-issue-integration).

Until a provider shows **Configured** here, its **Connect** buttons across the product stay disabled with a hint pointing back to this page.

## Related operator surfaces

Not everything operator-facing lives on the Admin page:

- **Workflow and block authoring** — the [Workflows](workflows.md) area, also gated on `platform-admin`.
- **Infrastructure-level settings** — the upstream methodology pin (`aidlc_repo_ref`) and deployment configuration live in Terraform; see [Setup](../getting-started/setup.md).
