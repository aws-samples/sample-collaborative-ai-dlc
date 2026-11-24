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

Every release — major, minor, or patch — is published from its permanent line branch, such as `release/2.5.x`; `main` is never tagged directly. Normal work keeps merging to `main`, and a release line only ever receives code that is already on `main`. The only extra step for a new minor or major version is creating its line branch.

### Start a new line (minor and major versions)

1. Confirm `main` is green and contains everything the new release needs.
2. Dispatch **Prepare Release Branch** from `main` with the line, for example `2.5`. The workflow creates `release/2.5.x` at the dispatched `main` commit; it rejects a malformed line, an existing branch, and a line that is not newer than every published line. Branch protection for `release/*.x` in the repository settings covers the new branch (no force pushes or deletion, PR required).

Nothing is tagged or published by this step, so the branch can be validated for as long as needed while `main` keeps moving. For a line that predates this process, create the branch from the line's latest tag instead, and make sure it contains the current release workflows before dispatching (a dispatch runs the workflow file of the dispatched branch):

```bash
git fetch origin --tags
git push origin v2.4.0^{commit}:refs/heads/release/2.4.x
```

### Bring fixes to an existing line (patch versions)

1. Fix `main` first: merge the fix through a normal PR into `main`. A fix branched from the release tag (for example `v2.4.0`) applies to both `main` and the release branch.
2. Bring each fix to the release branch through a PR: merge the same fix branch, or cherry-pick the merged commit with `git cherry-pick -x` so the release commit names its `main` origin. Never add a change to a release branch that is not on `main`.

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
8. Bring the release metadata back to `main` through a PR, so `main` carries the published changelog entry — and, for the newest line, the root version — into the next release.

Preparation branches use the `chore/release-X.Y.Z` form; the `release/` namespace is reserved for line branches. Creating a line or preparation branch does not publish a release; do not tag those branches manually or recreate tags owned by the release workflow. Preview releases use explicit versions such as `2.5.0-preview0` and participate in installer discovery by default.

`release/1.x` remains frozen. An exceptional v1 security fix branches from and returns to `release/1.x`; v2 code must not be merged into it.
