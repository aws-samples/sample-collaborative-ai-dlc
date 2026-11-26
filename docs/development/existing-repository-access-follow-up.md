# Existing repository access after account reconnect

Status: deferred follow-up, separate from native AI-DLC execution.

Scope decision: 18 September 2026. The user chose to track this separately.
The migration policy has not been chosen; this record does not authorize
requiring existing projects to confirm access again.

This concerns application code repositories that a project accesses through
someone's connected GitHub, GitLab or Bitbucket account. It is separate from
the read-only AI-DLC workflow-source bindings in the
[native execution plan](native-execution-plan.md).

The existing code already attempts to revoke project access when an account
is disconnected. However, an application binding identifies the person and
provider rather than the particular connection they approved. If dependency
invalidation misses a binding, or verification overlaps disconnect/reconnect,
an old grant can refer to the newly connected account without fresh consent.
This is an existing access-control gap, not a requirement introduced by native
execution.

The native branch already contains shared connection and invalidation race
fixes, with regression tests. Those fixes do not constitute a migration of
existing application grants to connection fingerprints.

Future work:

- Record the connection fingerprint when a project owner/admin authorizes
  application repository access. Reject verification results if the connection
  changes while provider checks are running.
- Check that fingerprint whenever application credentials are resolved,
  including refresh and cached/grant-based paths. Correctness must not depend
  on an eventually consistent index finding every dependent binding.
- Agree the treatment of existing bindings with the user before implementing
  a rollout: whether and when owners/admins must confirm access again, and how
  affected running or scheduled work should behave. Do not manufacture consent
  by silently attaching an old grant to whichever account is connected now.
- Provide clear project-level status and a recovery action for members with
  permission to configure repository access.
- Verify all three providers and preserve the separate GitHub App installation
  authorization path.

Acceptance scenarios should include reconnect without reverification, delayed
verification after revocation, missed index entries, delayed invalidation after
a fresh authorization, concurrent refresh, and normal uninterrupted connections.
An unchanged old grant must not authorize a replacement connection; newly
verified access must survive delayed work from the old connection.

Implementation entry points:

- `lambda/shared/source-control-credentials.js`
- `lambda/shared/source-control-bindings.js`
- `lambda/shared/git-connection-store.js`
- `lambda/shared/git-connection-identity.js`
- `lambda/credential-broker/index.js`
- `lambda/source-control/index.js`
- Project repository-access configuration in the frontend

This follow-up is not a prerequisite for continuing the native execution work.
New native workflow-source bindings retain their required connection
fingerprints, isolated authorization, and lifecycle checks. No existing-project
reconfirmation requirement is introduced by the native milestone.
