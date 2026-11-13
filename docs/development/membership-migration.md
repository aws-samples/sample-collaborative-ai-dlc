# Space membership migration

Space membership is authoritative in DynamoDB. Space lifecycle, names, users,
repositories, and knowledge remain in Neptune. Each membership has one access
record, keyed by `SPACE#<spaceId>` / `MEMBER#<userId>`. Its `membershipRole` is
`owner` or `member`; existing Owners and Admins become Space Owners. Several
Owners are allowed. Platform Admin remains an independent Cognito role and does
not confer space membership.

## Installation and update

Run the usual managed installer update or `scripts/deploy-terraform.sh`. There
is no separate migration command, application pause, runtime migration marker,
dual-write period, or fallback to Neptune.

Terraform performs these steps during apply:

1. Provision `${project_name}-access-${environment}` and
   `${project_name}-audit-${environment}`, the access table's `by-user` GSI, and
   the migration Lambda's permissions.
2. Invoke `membership_copy` using `aws_lambda_invocation`. Copy memberships with
   stable space/user IDs, converting `admin` to `owner`. Read each space's edges
   in one query so concurrent removal cannot shift an offset page past an
   unchanged member. Each copy and its audit
   baseline commit in one transaction. Verify baselines, current memberships,
   user-space index propagation, and Owner coverage. Spaces with no source
   memberships are skipped and logged. Spaces without an Owner keep their
   existing Member access and produce a warning; migration does not grant
   ownership. Duplicate valid membership edges become one record with the
   strongest existing grant (Owner/Admin takes precedence over Member).
   Malformed identities, invalid roles, or failed copy verification block
   deployment. Migration logs identify affected spaces, and its result reports
   skipped and ownerless space counts.
3. Deploy all membership readers/writers with DynamoDB table names and scoped
   IAM grants. Every access check reads the base record consistently and checks
   that the space still exists. DynamoDB errors deny access.
4. After application Lambdas have deployed, invoke `membership_report`. Log each
   space/user pair whose graph grant is missing from DynamoDB, whose DynamoDB
   grant is missing from the graph, or whose roles differ. This detects missed
   additions, removals, role changes, and grants in spaces created after copying.
   The report does not modify either source. Report failures are logged without
   blocking deployment. Retain all `HAS_MEMBER` edges for rollback; cleanup is
   deferred to a later release.
5. Deploy the frontend through the usual update process. Reload existing browser
   tabs to load the Owner/Member controls and paginated API client.

The copy invocation has stable, versioned input and runs once when its Terraform
resource is created. Later ordinary updates do not import old graph edges again.
A failed copy can be retried through the same installation/update command.
Conditional writes preserve any existing destination membership. Retained
migration audit baselines prevent a retry from restoring a membership subsequently
removed in DynamoDB, even though the old graph edges are retained.

Before application deployment, Neptune remains the source for the old application.
After deployment, DynamoDB is the only authority. **Membership changes and space
creation/deletion made in the old application during copying and deployment may
not carry over.** This tradeoff is accepted for this migration; there is no write
blocking or synchronization. Avoid administrative membership changes during the
update when possible. This window includes Lambda builds and uploads after the
copy, not just the time needed to update function configurations. **Re-apply
immediately after a partial failure.** The window lasts until the remaining
application Lambdas deploy; it can last hours or days if the update is left
unfinished. New code already deployed uses DynamoDB while old code still writes
Neptune. Re-applying after a successful copy does not repeat it, so old-app
revocations can leave an active DynamoDB grant and new-space creators can lack a
DynamoDB grant.

After the update, inspect the migration Lambda logs and the `membership_report`
result. Its counts are `missingDestination`, `missingSource`, and `roleMismatches`;
warnings identify each affected space/user and the observed roles. Reconcile
differences against membership history before correcting access. A difference
can also reflect a legitimate DynamoDB change after cutover, because graph edges
are no longer synchronized. The report describes the observed mismatch and does
not decide which source should win. Review it before restoring graph-based code,
especially for removals that may otherwise restore revoked access.

If the report returns `reported: false`, correct the reported read/setup failure
and invoke the read-only report again. For the default development deployment
(adjust the function name and AWS region/profile for your installation):

```bash
aws lambda invoke \
  --function-name collaborative-ai-dlc-migrate-memberships-dev \
  --cli-binary-format raw-in-base64-out \
  --payload '{"action":"report"}' \
  membership-report.json
```

This invocation only reads memberships and writes diagnostic logs.

The migration Lambda has a fifteen-minute invocation limit. A large copy or
delayed index propagation can require retrying the ordinary update. Already
committed rows and baselines remain safe. Infrastructure verification does not
make Neptune and DynamoDB a transactionally consistent snapshot.

## API and compatibility

`GET /projects` and `GET /projects/{projectId}/members` preserve the legacy array
response unless the client sends `paged=1`. The new frontend sends that parameter
and receives `{ items, nextToken }`, with up to 50 items per page. Keep `paged=1`
and supply `nextToken` as query parameters to continue, including after an empty
page. Requests without pagination opt-in follow all DynamoDB pages on the backend
and return one array, so existing browser bundles remain usable while the
frontend deploys. The frontend domain service follows all opted-in pages and
also accepts legacy arrays from an older backend after rollback.
A newly added space can take time to appear in the
eventually consistent user-space index; direct access checks use the consistent
base-table record. Removed members and stale projected roles cannot authorize
protected space content or actions.

Member mutation inputs accept legacy `admin` as an alias for `owner` so older
clients can still submit role changes during the rollout. Responses and stored
values only contain `owner` and `member`. Former Admins gain full membership
management and space deletion authority. Older browser bundles can have outdated
role controls until reloaded.

Permission history is retained in the audit table. The shared membership store
supports internal queries with optional, inclusive ISO timestamp bounds and
returns newest-first pages of up to 50 records with a continuation token.
Space members can read it through `GET /projects/{projectId}/membership-history`
(`from`, `to`, and `nextToken` query parameters). No history screen exists yet.

Business-role assignments are stored as `localRoles` on the membership item: a
sorted list of unique IDs from the shared catalog in
`lambda/shared/business-roles.js`. An update changes only `localRoles`,
`updatedAt`, and `revision`, and writes a `local-roles-changed` audit item in
the same transaction. That item's `before` and `after` hold the old and new role
lists.

Each change records its actor, space, target user, timestamp, change ID, and
before/after membership. Revision conditions reject stale changes. Actor
authority is checked with the mutation transaction. The last-owner safeguard
consistently queries all member pages; it rejects on a missing other Owner or
query failure. It is a read before the transaction, so simultaneous removals of
different Owners can still remove the last two Owners. This release adds no
counter or lock.

## Revocation and deletion

REST operations and new realtime-token requests deny removed members immediately
after the membership transaction commits. Existing signed realtime scope tokens
last at most ten minutes. Yjs sockets close on expiry; application WebSocket
fan-out filters expired connections, and clients obtain fresh authorization on
reconnect. A removed member can retain an existing realtime read/edit session
until that token expires. Membership is not cached by the access helper.

Removing a member first invalidates their delegated tracker and source-control
bindings. A cleanup failure leaves membership intact for retry. Re-adding the
person creates a fresh membership and does not restore invalidated bindings.

Space deletion retains the existing intent, credential, and collaboration
cleanup. It queries memberships in bounded pages and removes each membership
with its audit entry transactionally. Other members are removed before the
deleting Owner so a failure preserves that Owner's retry permission. The space
vertex is deleted before the final Owner record; if that last transaction fails,
the same Owner can retry deletion to drain the remaining record. Ordinary access
still rejects the missing space. DynamoDB removes GSI entries after propagation.
Audit records are retained. Neither table uses TTL.

## Rollback

Before application cutover, the old Neptune source can be used for rollback.
Once DynamoDB has received application writes, reverting to graph membership
would lose new grants or restore revoked access. Preserve both tables and
reconcile their changes before any rollback to an older application. This release
retains all old graph edges, so the prior application's membership source remains
available. Those edges stop being updated at cutover and are not an up-to-date
copy of DynamoDB. Restore the matching frontend when rolling back; existing new
browser bundles can read legacy array responses until reloaded. A Terraform
state backup alone is not an application-data backup.
