# Releasing Collaborative AI-DLC

The root `package.json` is the sole product version. Component manifests are private and must not contain a `version`. Versions follow strict SemVer; stable tags are `vX.Y.Z`, and prerelease tags use forms such as `vX.Y.Z-rc.N`. Never move or recreate a published tag.

## Prepare v2 on `aidlc-v2`

1. Merge `origin/main` into `aidlc-v2`; never rebase the shared release branch.
2. Keep all v2 release work on `aidlc-v2` and freeze features before final validation.
3. Prepare metadata with `npm run release:prepare -- 2.0.0`.
4. Complete `CHANGELOG.md`; `TBD` is allowed during preparation.
5. Run `npm run release:check -- 2.0.0`.
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

## Release v2

1. If `main` changed after final testing, merge it into `aidlc-v2` and rerun all checks.
2. Replace `TBD` in the `2.0.0` changelog heading with the release date in `YYYY-MM-DD` form.
3. Run `npm run release:check -- 2.0.0 --final --tag-must-not-exist`.
4. Merge the `aidlc-v2` PR into `main` with a merge commit.
5. Confirm the resulting `main` commit is green and reports root version `2.0.0`.
6. Dispatch **Publish Stable Release** from `main` with version `2.0.0`.

The workflow rejects non-stable versions, branch mismatches, package/lockfile mismatches, component versions, missing or undated changelog entries, and existing tags. It creates annotated tag `v2.0.0` at the dispatched `main` commit and publishes the GitHub Release.

Verify that the tag equals current `main`, the installer selects `2.0.0` as latest stable, the deployed status bar shows `AI-DLC v2.0.0`, and the README v1.1.0 link resolves. Then delete or lock `aidlc-v2`.

## Failure Handling

- If validation fails, fix the release branch and rerun CI. Do not bypass the check.
- If deployment testing fails, keep `aidlc-v2` unmerged and preserve the previous managed `current` checkout.
- If tagging succeeds but GitHub Release creation fails, rerun only release publication against the existing immutable tag.
- If a published release is defective, prepare and publish the next patch version. Never force-update a tag.

## Ongoing Releases

Normal work branches from and merges to `main`; releases are tagged from `main`. Prepare v2 patches such as `2.0.1` on `main`, then dispatch the stable release workflow. Prereleases use explicit tags such as `v2.1.0-rc.1` and are excluded from installer defaults.

`release/1.x` remains frozen. An exceptional v1 security fix branches from and returns to `release/1.x`; v2 code must not be merged into it.
