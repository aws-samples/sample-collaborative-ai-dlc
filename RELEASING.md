# Releasing Collaborative AI-DLC

The root `package.json` is the sole product version. Component manifests are private and must not contain a `version`. Versions follow strict SemVer; stable tags are `vX.Y.Z`, and preview tags use forms such as `vX.Y.Z-preview0`. Never move or recreate a published tag.

The installer lists stable and preview tags by default and selects the highest tag by SemVer precedence. A stable `v2.0.0` supersedes every `v2.0.0-*` preview. Use numeric prerelease identifiers after a dot when a sequence can exceed nine, for example `v2.1.0-preview.10`.

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
- If deployment testing fails, keep `aidlc-v2` unmerged and preserve the previous managed `current` checkout.
- If tagging succeeds but GitHub Release creation fails, rerun only release publication against the existing immutable tag.
- If a published release is defective, prepare and publish the next patch version. Never force-update a tag.

## Ongoing Releases

Normal work branches from and merges to `main`; releases are tagged from `main`. Prepare v2 patches such as `2.0.1` on `main`, then dispatch the release workflow. Preview releases use explicit versions such as `v2.1.0-preview0` and participate in installer discovery by default.

`release/1.x` remains frozen. An exceptional v1 security fix branches from and returns to `release/1.x`; v2 code must not be merged into it.
