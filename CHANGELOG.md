# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.0.0-preview0] - TBD

### Added

- Managed installer with SemVer release discovery, immutable tagged checkouts, persistent deployment configuration, existing-v1 adoption, guarded updates, status reporting, Terraform state backups, and downgrade protection.
- Composable AI-DLC v2 workflows built from versioned blocks, per-intent execution grids, stage skipping, review gates, deterministic sensors, artifact derivation, and in-flight recomposition.
- Bedrock AgentCore execution with durable orchestration, resumable human questions, scoped agent credentials and MCP servers, configurable agent tiers and models, and live execution output.
- Intent-centric workbench, observability, artifact previews and editing, discussions, multi-repository construction, and GitHub, GitLab, and Jira integrations.
- Platform administration for users, provider credentials, model defaults, migrations, workflows, and building blocks.
- Canonical application version in the root package, release validation tooling, a guarded main-only release workflow, and version/environment display in the UI.
- Runtime model override for the Claude agent CLI. Projects and the Admin default-models page can now pin a Claude model using a bare Bedrock cross-region inference profile ID (e.g. `us.anthropic.claude-opus-4-8`); the Claude driver injects it as `ANTHROPIC_MODEL` into the `claude-agent-acp` subprocess (stripping any legacy `amazon-bedrock/` prefix). Validation rejects the `amazon-bedrock/` prefix for Claude (the inverse of OpenCode). Previously Claude was pinned to the driver default.
- Jira Cloud support and a generic tracker provider abstraction (#194). A project can now bind to GitHub Issues and Jira Cloud independently of its code host; sprints can be started from any tracker issue.
- Phase 4 tracker-migration polish (#198): an Admin → Tracker Migration card surfaces the count of projects + sprints still on the legacy tracker shape and promotes the bulk migration from the CLI-only `migrate-tracker-fields` Lambda to a one-click button. Docs (`using-the-platform/git-integration.md`, `getting-started/setup.md`) gained a "Migrating from legacy issue integration" section.
- GitLab.com support as an alternative git provider (#3). GitLab can now be selected as a project's **code host** (clone/branch/file browse, push, merge-request creation, MR-comment read/write during review) and as an **issue tracker** (`gitlab-issues`) so a sprint can be started from a GitLab issue — at parity with GitHub. Backed by a shared git-provider abstraction (`lambda/shared/git-providers`) and a unified frontend git service so GitHub and GitLab share one code path. GitLab's short-lived OAuth access tokens are refreshed automatically for long-running construction jobs. Docs (`README`, `getting-started/setup.md`, `using-the-platform/git-integration.md`) updated for the new provider.

### Changed

- Replaced the fixed v1 three-phase sprint runtime and ECS agent pool with customizable intent workflows and the AgentCore stage runtime.
- Project access now uses explicit per-project owner, admin, and member roles; platform-wide administration uses the Cognito `platform-admin` group.
- Terraform deployment now supports separate plan and apply phases and rejects plans that unexpectedly destroy persistent Cognito, Neptune, S3, or DynamoDB resources.

### Removed

- Retired the v1 ECS agent runtime, agent-pool table, and v1 lifecycle execution paths. Existing v1 sprint data remains view-only.

### Notes

- V1 sprints are view-only in v2. Continue active v1 work with release `v1.1.0` before upgrading.
- The v1-to-v2 update removes the retired ECS runtime and agent-pool table. All other application data remains in place, but operators remain responsible for application-data backups beyond the automatic Terraform state backup.
- Claude runtime model override is **fully backward compatible and opt-in**. A Claude project with no model override resolves to exactly the same model as before (the static `ANTHROPIC_MODEL` task-definition default, e.g. `us.anthropic.claude-sonnet-4-6`) — `resolveModel` falls through the empty per-job `AGENT_MODEL` to that static value. Existing kiro/opencode overrides and stored `cli_models` data are untouched (the `claude` key is purely additive). Mixed-version deployments degrade safely: an old worker image ignores a dispatched Claude model and uses its driver default; an old frontend against the new backend simply doesn't render the Claude model field; a new frontend against an old backend sees `runtimeModelOverride.claude:false` and disables the field. No migration is required for OSS forks — behavior changes only when a user explicitly sets a Claude model.
- No legacy code is removed by Phase 4. The `issue_integration_enabled` boolean, `issue_number` / `issue_url` Sprint fields, dual-shape readers, the per-project `MigrateTrackerCard`, the per-project `POST /projects/:id/migrate-tracker` endpoint, and the bulk `migrate-tracker-fields` Lambda all stay deployed indefinitely as safety nets for OSS forks on their own upgrade timelines.
- GitLab support is additive and provider-scoped. Existing GitHub projects are unaffected: a git connection is bound to its provider, so a GitHub connection only serves GitHub projects and a GitLab connection only serves GitLab projects. GitLab OAuth credentials are optional — if an operator doesn't configure them, the **Connect GitLab** button stays disabled and GitHub behaves exactly as before.

## [1.0.0] - 2025-04-30

### Added

- Initial release of Collaborative AI-DLC
- Three-phase lifecycle: Inception, Construction, Review
- Real-time collaboration with Yjs/CRDT
- Parallel agent construction with dependency-aware orchestration
- Graph-based traceability (requirements → stories → tasks → code)
- GitHub OAuth integration for repository management
- Cognito authentication with optional MFA
- Neptune graph database for project knowledge
- DynamoDB for operational state
- ECS-based agent workers
- WebSocket real-time notifications
- CloudFront + S3 frontend hosting
