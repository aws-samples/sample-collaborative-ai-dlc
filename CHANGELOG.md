# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Optional custom domains. `app_domain` puts the application on your own hostname; leaving it empty keeps the CloudFront-assigned domain and creates no additional resources. Because every public path is served by a single CloudFront distribution, this needs only one `us-east-1` ACM certificate and one distribution change — no API Gateway custom domain, no Cognito hosted-UI domain and no load balancer certificate. Supply an existing certificate with `acm_certificate_arn` for centrally managed, imported, wildcard or private-CA certificates and manage DNS anywhere, or supply `route53_zone_id` to have Terraform request, validate and publish everything. `app_domain_aliases` adds further hostnames to the same distribution. The installer gains `--domain`, `--domain-alias`, `--certificate-arn`, `--hosted-zone-id` and `--no-domain`, persists them across updates, reports them in `status`, and validates certificate region, status and hostname coverage, hosted-zone containment, and CloudFront alias availability before applying. New `application_domain`, `application_aliases`, `custom_domain_enabled`, `acm_certificate_arn`, `dns_managed_by_terraform`, `dns_target` and `dns_target_hosted_zone_id` outputs; the deployment summary prints the exact records to create when DNS is managed externally.
- A read-only deployment strip on the Platform Admin page showing the canonical application URL, environment and region, and warning when the page is being browsed on a hostname other than the canonical one.
- `deploy-terraform.sh --var KEY=VALUE` (repeatable) overrides individual Terraform variables without editing the environment `tfvars`. `TF_VAR_*` environment variables cannot serve this purpose because Terraform ranks `-var-file` above them, so any key already present in the file wins silently. The flag applies at plan time and is rejected with `--phase apply`, since a saved plan already has its variables resolved.

### Changed

- The OAuth callback URL shown in the Admin UI is now built from the deployment's canonical origin instead of the browsing origin. A deployment answers on the CloudFront domain and on every alias, so an admin could previously be shown a callback URL that did not match the redirect URI the backend sends, which providers reject at sign-in time.
- The application hostname is now derived once and reused by the OAuth redirect URIs, the CORS allowlists, the artifacts bucket CORS rules, the `application_url` output and the frontend build, replacing seven separate recomputations. The CloudFront domain stays in the CORS allowlists alongside any custom hostname, so enabling a custom domain does not break already-loaded bundles.
- The installer now updates the environment `tfvars` on every run instead of only writing it once, so deployment settings can be changed or removed by an update rather than requiring a hand edit.
- Terraform now requires 1.4 or later.

### Notes

- Changing the canonical hostname of a running deployment requires updating the **Authorization callback URL** in every configured OAuth provider, and every GitLab connection must be reauthorized: GitLab requires `redirect_uri` on the refresh-token grant to match the original authorization request, so stored GitLab refresh tokens become unusable. GitHub OAuth tokens, GitHub App bindings and Jira connections are unaffected. Setting the domain at initial install avoids this entirely.

## [2.0.0-preview0] - 2026-07-17

### Added

- Managed installer with SemVer release discovery, immutable tagged checkouts, persistent deployment configuration, existing-v1 adoption, guarded updates, status reporting, Terraform state backups, and downgrade protection.
- Useful deployment completion summaries with the environment, region, and public CloudFront application URL for managed and standalone installs.
- Guarded managed and standalone environment destruction with typed confirmation, pre-destroy state backups, custom local environment support, and reliable cleanup of versioned S3 buckets.
- Cognito administrator configuration now uses the Terraform deployment region and reports actionable AWS account/profile diagnostics when the deployed user pool is inaccessible.
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
