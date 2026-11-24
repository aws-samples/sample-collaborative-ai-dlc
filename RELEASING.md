# Releasing Collaborative AI-DLC

The root `package.json` is the sole product version. Component manifests are private and must not contain a `version`. Versions follow strict SemVer; stable tags are `vX.Y.Z`, and preview tags use forms such as `vX.Y.Z-preview0`. Never move or recreate a published tag.

The installer lists stable and preview tags by default and selects the highest tag by SemVer precedence. A stable `v2.0.0` supersedes every `v2.0.0-*` preview. Use numeric prerelease identifiers after a dot when a sequence can exceed nine, for example `v2.1.0-preview.10`.

For current releases, follow [Ongoing Releases](#ongoing-releases). The v1 archival and v2 launch steps below document the completed transition and should not be repeated.

## Prepare v2 on `aidlc-v2`

1. Merge `origin/main` into `aidlc-v2`; never rebase the shared release branch.
2. Keep all v2 release work on `aidlc-v2` and freeze features before final validation.
3. Prepare metadata with `npm run release:prepare -- 2.0.0-preview0`.
4. Complete `CHANGELOG.md`; `TBD` is allowed during preparation.
5. Run `npm run release:check -- 2.0.0-preview0`.
6. Test a fresh install, v1 adoption, and a v1.1.0-to-v2.0.0 update.
7. Open or update the `aidlc-v2` to `main` PR and require every CI check to pass.

Do not tag `aidlc-v2`. Release tags identify commits on permanent release branches.

## Archive v1 on Release Day

Confirm `main` is green and contains the desired final v1 code, then record the remote commit:

```bash
git fetch origin
V1_SHA=$(git rev-parse origin/main)
git tag -a v1.1.0 "$V1_SHA" -m "Collaborative AI-DLC v1.1.0"
git push origin v1.1.0
git branch release/1.x "$V1_SHA"
git push origin release/1.x
```

Publish the v1.1.0 GitHub Release and verify its source commit equals `V1_SHA`. Protect `v1.1.0` from deletion and protect `release/1.x` from deletion and force pushes. This one-time legacy snapshot is exempt from root package-version validation because the release tooling is still on `aidlc-v2`.

## Publish the v2 Preview

1. If `main` changed after final testing, merge it into `aidlc-v2` and rerun all checks.
2. Replace `TBD` in the `2.0.0-preview0` changelog heading with the release date in `YYYY-MM-DD` form.
3. Run `npm run release:check -- 2.0.0-preview0 --final --tag-must-not-exist`.
4. Merge the `aidlc-v2` PR into `main` with a merge commit.
5. Confirm the resulting `main` commit is green and reports root version `2.0.0-preview0`.
6. Dispatch **Publish Release** from `main` with version `2.0.0-preview0`.

The workflow rejects branch mismatches, invalid SemVer, package/lockfile mismatches, component versions, missing or undated changelog entries, and existing tags. It creates annotated tag `v2.0.0-preview0` at the dispatched `main` commit and publishes a GitHub prerelease.

Verify that the tag equals current `main`, the installer selects `2.0.0-preview0`, the deployed status bar shows `AI-DLC v2.0.0-preview0`, and the README v1.1.0 link resolves. Then delete or lock `aidlc-v2`.

## Promote v2 to Stable

Preview fixes branch from and merge back to `main`. For another preview, prepare the next version, such as `2.0.0-preview1`, and dispatch **Publish Release** from `main` after CI passes.

For the stable release:

1. Promote the root, lockfile, and existing preview changelog heading with `npm run release:prepare -- 2.0.0`.
2. Review the preserved changelog notes and replace `TBD` with the release date.
3. Run `npm run release:check -- 2.0.0 --final --tag-must-not-exist`.
4. Merge the metadata change to `main` and require all checks to pass.
5. Dispatch **Publish Release** from `main` with version `2.0.0`.

The stable GitHub Release becomes the normal release for the same core version, and the installer selects it over all `2.0.0-*` previews.

## Failure Handling

- If validation fails, fix the release branch and rerun CI. Do not bypass the check.
- If deployment testing fails, keep the release preparation PR unmerged and preserve the previous managed `current` checkout.
- If tagging succeeds but GitHub Release creation fails, rerun only release publication against the existing immutable tag.
- If a published release is defective, prepare and publish the next patch version. Never force-update a tag.

## Ongoing Releases

Every release — major, minor, or patch — is published from its permanent line branch, such as `release/2.5.x`; `main` is never tagged directly. Normal feature work keeps merging to `main`; patch fixes are made on their release line and return to `main` through back-merge PRs. The only extra step for a new minor or major version is creating its line branch.

### Start a new line (minor and major versions)

1. Confirm `main` is green and contains everything the new release needs.
2. Dispatch **Prepare Release Branch** from `main` with the line, for example `2.5`. The workflow creates `release/2.5.x` at the dispatched `main` commit; it rejects a malformed line, an existing branch, and a line that is not newer than every published line. Branch protection for `release/*.x` in the repository settings covers the new branch (no force pushes or deletion, PR required), and the `demo-release` environment's deployment branch rules must include `release/*.x` so a publish from the branch can start the demo deployment (see [Demo deployment](docs/development/demo-deployment.md)).

Nothing is tagged or published by this step, so the branch can be validated for as long as needed while `main` keeps moving.

### Backfill a line that predates this process

Create the branch from the line's latest tag:

```bash
git fetch origin --tags
git push origin v2.4.0^{commit}:refs/heads/release/2.4.x
```

A dispatch runs the workflow files of the dispatched branch, and a branch cut from `v2.4.0` still carries the old workflows: its **Publish Release** refuses every branch except `main`, and its demo guard does not trust tags that only exist on a line branch. Before dispatching, bring the current release tooling onto the line through a PR into `release/2.4.x` that cherry-picks the commits which introduced it — the `release.yml`, `prepare-release.yml`, and `deploy-demo.yml` workflows, this document, and the matching `scripts/test/release-tools.test.mjs` assertions so the line's CI passes. Do not merge `main` into the line to get the workflows; that would pull every feature since the tag into the next patch.

Fixes then target the backfilled line like any other patch, and the cherry-picked tooling returns to `main` — as content `main` already has — with the line's first back-merge. Until that back-merge, **Prepare Release Branch** counts the line as unmerged, like any other pending fix.

### Bring fixes to an existing line (patch versions)

1. Branch from the release line, not from `main`: `git switch -c fix/<topic> release/2.4.x`. Open the fix PR against `release/2.4.x`, so the fix is reviewed and CI-tested on the exact code being patched.
2. After publishing the patch, return the line to `main` with the back-merge PR described in the publishing steps below: a dedicated `chore/back-merge-X.Y.Z` branch cut from `main`, merged into `main` with a **merge commit**, never a squash or rebase — a squash breaks the shared ancestry, so every later back-merge of that line re-conflicts on the same changes.

A fix must never exist only on a release branch. **Prepare Release Branch** refuses to start a new line while any `release/X.Y.x` line branch has commits that have not reached `main`, so a forgotten back-merge blocks the next minor instead of letting it ship without the fix. The frozen `release/1.x` and other `release/*` names, such as old preparation branches, are not lines and never block.

### Prepare and publish (identical for every release)

The steps below use a minor release, `2.5.0`; patches such as `2.4.1` and previews such as `2.5.0-preview0` use the same steps with their version and line.

1. Start with a clean working tree, update the release branch, and create the preparation branch:

   ```bash
   git switch release/2.5.x
   git pull --ff-only
   git switch -c chore/release-2.5.0
   git fetch origin --tags
   npm run release:prepare -- 2.5.0
   ```

2. Complete the new `CHANGELOG.md` entry by reviewing every change since the previous release (`git log v2.4.0..HEAD` for this release). Leave an empty `Unreleased` section for subsequent work. Record operator actions and compatibility changes, update installation examples, and replace `TBD` with the intended publication date before final validation.
3. Install the locked dependencies and run the checks used by CI. The backend tests require a running Docker-compatible container runtime for Gremlin Server and DynamoDB Local. CI tests the backend on Node.js 22 and 24; use Node.js 24 for the frontend build and lint checks.

   ```bash
   npm ci
   npm --prefix frontend ci
   npm run release:check -- 2.5.0 --final --tag-must-not-exist
   npm run test:release
   npm test
   npm run lint
   npm run format:check
   npm run sdk:check
   npm --prefix frontend test
   npm --prefix frontend run build
   ```

   When documentation changes, also run `uv sync --group docs` and `uv run zensical build`.

4. Test a fresh installation and an update from the previous stable release in a disposable deployment. For a minor or major release, also follow the [managed build environment test](docs/development/testing.md#managed-build-environment-deployed-stack-test), verify credential selection and paused-stage recovery, export a workspace, and verify tracker delivery comments. Reauthorize Jira with `write:jira-work` before testing its write-back. Keep v1 adoption and upgrade coverage when those paths change.
5. Open the preparation PR into the release branch and require every CI check to pass. If the release branch changes during validation, incorporate the changes and rerun the affected checks. Merge only after deployment testing succeeds.
6. Confirm the merged release-branch commit is green, reports root version `2.5.0`, and has the intended changelog date. Dispatch **Publish Release** from `release/2.5.x` with version `2.5.0`. The workflow refuses every other branch and any version outside the branch's line: `release/2.5.x` publishes `2.5.0`, `2.5.1`, or `2.5.0-preview0` and rejects `2.6.1`. It creates the annotated tag and GitHub Release, then starts the protected demo deployment described in [Demo deployment](docs/development/demo-deployment.md) unless a newer release line already exists, so a patch of an older line never rolls the demo back.
7. Verify that `v2.5.0` points to the dispatched release-branch commit, the installer lists and selects `2.5.0`, and the deployed status bar reports `AI-DLC v2.5.0`.
8. Back-merge the release branch into `main`, so `main` carries every fix and the published changelog entry — and, for the newest line, the root version — into the next release. Build the merge on a dedicated branch cut from `main`, never on the line itself:

   ```bash
   git fetch origin
   git switch -c chore/back-merge-2.5.0 origin/main
   git merge --no-ff origin/release/2.5.x
   ```

   An older line always conflicts with `main` on the root version and `CHANGELOG.md`. Resolve the conflicts on this branch, in favor of `main` — the back-merge carries fixes and release metadata, it never reverts newer work. When back-merging an older line, keep `main`'s root version; only the newest line's back-merge updates it. Do not resolve on the line, and do not use GitHub's **Resolve conflicts** button on a PR whose head is `release/2.5.x` itself: both merge `main` into the line, and the next patch would ship every feature from `main`.

   Open the PR from `chore/back-merge-2.5.0` into `main` and merge it with a **merge commit**, never a squash or rebase. The merge commit makes the line's tip part of `main`'s history, which keeps later back-merges small and satisfies the **Prepare Release Branch** check.

Preparation branches use the `chore/release-X.Y.Z` form; the `release/` namespace is reserved for line branches. Creating a line or preparation branch does not publish a release; do not tag those branches manually or recreate tags owned by the release workflow. Preview releases use explicit versions such as `2.5.0-preview0` and participate in installer discovery by default.

`release/1.x` remains frozen. An exceptional v1 security fix branches from and returns to `release/1.x`; v2 code must not be merged into it.
