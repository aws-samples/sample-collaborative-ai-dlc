## Summary

Adds **Bitbucket Cloud** as a third git-host provider, alongside the existing GitHub and GitLab providers. The implementation follows the existing provider-abstraction pattern exactly and is purely additive — GitHub and GitLab behaviour is unchanged.

Relates to the "out of scope" note in #55 (Add GitLab support), which explicitly deferred Bitbucket.

The provider has been validated **end-to-end against a real Bitbucket Cloud repository** (`sascha242/unicorn-store-spring`): OAuth connect → repo listing → branch/tree/file browsing → construction commit & push → server-side merge detection → automated pull-request creation (a PR was opened by the AI-DLC Construction Agent on a live deployment).

## What's included

**Backend**

- New provider module `lambda/shared/git-providers/bitbucket.js` implementing the full provider contract (`listRepos`, `listBranches`, `getTree`, `getFileContents`, `createPullRequest`, PR comments, `splitWorkspaceRepo`, OAuth `buildAuthorizeUrl`/`exchangeCode`/`refreshAccessToken`, `isBranchMergedInto`, task-branch merge/cleanup).
- New lambda handler `lambda/bitbucket/` wired through the shared `git-handler` framework.
- Registered `bitbucket` in the provider registry (`lambda/shared/git-providers.js`).
- Tracker/OAuth wiring: `bitbucket-issues` registered in the trackers lambda (`lambda/trackers/index.js` `PROVIDER_OAUTH_CONFIG`) so Bitbucket appears in the Admin "Tracker OAuth Apps" panel and the project-level "Connect Bitbucket" button is gated on its configured status.
- Token-refresh support: Bitbucket access tokens expire (~2h). Refresh is handled both in the shared token store (`lambda/shared/git-token.js` — `ensureFreshGitToken`/`refreshBitbucketToken`) and in the construction-runtime refresh wrapper (`lambda/shared/git-token-refresh.js`), so long-running jobs and the PR/comment paths never authenticate with a stale token.

**Infrastructure (Terraform)**

- OAuth secret, lambda + IAM role, API Gateway routes (`/bitbucket/*`) with CORS, and main-module wiring. `BITBUCKET_OAUTH_SECRET_NAME` and `BITBUCKET_REDIRECT_URI` are wired to the bitbucket and trackers lambdas.

**Frontend**

- `gitProvider` union extended with `'bitbucket'`; provider selector, Bitbucket icon, service implementation, and Bitbucket Issues tracker.
- `bitbucket` added to `PROVIDER_META` (GitConnectButton) and `PROVIDER_URL` (GitRepoLink).
- Bitbucket OAuth callback route registered in `App.tsx`, and the post-connect provider mapping in `GitOAuthCallback.tsx` returns `bitbucket`.

**Docs**

- Setup guide (OAuth consumer registration, callback URL, scopes) and the Git & Tracker Integration page updated for Bitbucket Cloud.

## Bitbucket Cloud API specifics handled

- **OAuth scopes** are Bitbucket's **singular** scope names: `account repository repository:write pullrequest pullrequest:write`. (The REST API _path_ segments are plural — `repositories`, `pullrequests` — but the OAuth scope identifiers are singular; using the plural form causes `invalid_scope: Unknown scope: repositories` at authorize time.)
- **CHANGE-2770**: Atlassian removed the cross-workspace `GET /2.0/repositories` endpoint **and** the `GET /2.0/user/permissions/workspaces` endpoint (removal 2026-02-27; the latter returns `410 Gone`). Per Atlassian engineering guidance the only supported cross-workspace endpoint going forward is **`GET /2.0/user/workspaces`**. `listRepos` therefore uses: `GET /2.0/user/workspaces` → `GET /2.0/repositories/{workspace}?role=member`, aggregated across workspaces. Its `values[]` are workspace objects directly (slug at top level, not nested under `.workspace.slug`). A repository-scoped token cannot enumerate workspaces (401/403) — a clear, actionable error is surfaced (per-repo operations still work with a repo-scoped token).
- **Merge detection**: Bitbucket has no direct compare endpoint. `isBranchMergedInto` performs a real **ancestor check** — it walks the sprint branch's commit history (`GET /2.0/repositories/{ws}/{repo}/commits/{branch}`, paginated) and treats a task branch as merged when its HEAD commit is reachable from the sprint-branch HEAD. (A naive HEAD-equality check would report freshly-merged task branches as "not merged" — because the sprint HEAD advances past them — and block PR creation.)
- **Token storage tier**: Bitbucket access + refresh tokens are JWTs whose combined JSON can exceed the SSM Standard-tier 4096-character limit. All token writes use `Tier: 'Intelligent-Tiering'`, which upgrades to the Advanced tier only when the value is too large — GitHub/GitLab's short opaque tokens stay on the free Standard tier.
- **Directory listing**: `getTree` lists directory contents without `?format=meta` (meta returns a single directory object, not the entries) and guards against empty 404 bodies.
- Repo reference format is `workspace/repo_slug` (analogous to GitHub's `owner/repo`).
- No server-side merge API — `mergeBranch` returns a clear error suggesting PR creation.

## Testing

- Unit tests for the Bitbucket lambda handler (`lambda/bitbucket/test/`) and the shared git-providers registry/token tests (`lambda/shared/test/`).
- A level-2 integration harness (`scripts/integration/bitbucket-integration.mjs`) exercises the provider against the real Bitbucket Cloud API without deploying AWS infra. Modes: read-only (default), `--write` (PR lifecycle with cleanup), `--refresh` (token refresh), `--verbose` (HTTP-level diagnostics; never logs secrets). See `scripts/integration/README.md`.
- Verified against a real repository (`sascha242/unicorn-store-spring`): `listBranches`, `getTree` (recursive), and `getFileContents` all pass. `listRepos` requires a workspace-/account-scoped token or OAuth (repository-scoped tokens return the documented permission error by design).
- **Full end-to-end on a live eu-central-1 deployment**: OAuth connect, repo listing (post-CHANGE-2770 endpoint), branch/tree browsing, construction commit + push, ancestor-based merge detection, automatic token refresh after >2h, and an automated PR opened against `main`.

## Notes for reviewers

- Container-backed tests (Gremlin/Neptune via testcontainers) require a running Docker/Podman runtime and are best validated in CI.
- Self-hosted Bitbucket Server / Data Center is out of scope (Bitbucket Cloud only).
