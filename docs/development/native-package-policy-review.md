# Native package storage policy: documentation review

Reviewed: 21 September 2026, against AWS primary documentation retrieved through
the web lookup tool. The earlier shell download failure no longer blocks this
review. No AWS credentials, policy changes, or deployment were involved.

Updated after live testing on 22 September: the conditional-header guards alone
do **not** block multipart initiation. A signed `If-None-Match: *` header let
`CreateMultipartUpload` succeed with HTTP 200. This supersedes the original
documentation-based assumption below. The tested source object was unchanged;
the only residue was an empty synthetic upload session, subsequently inspected
and aborted by the operator. Imports remain off in AWS pending the next
deployment.

The correction adds `s3:ObjectCreationOperation: true` to the publisher's
`Bool` allow conditions and a separate bucket `BoolIfExists: false` denial for
the same key. The bucket denial applies when the operation context is false or
absent, even if a caller supplies the creation header and has another broad
allow. Existing condition, copy, publisher-identity and deletion guards remain.
The user deployed this change. Both policies match review, and the third live
probe completed all 20 cases with 18 passes and the two expected inconclusive
responses. Both multipart-initiation variants were denied; final inventories
were clean. This supports the first direct-upload dev import experiment while
retaining the limits described below.

Reviewed candidates:

- `terraform/modules/data/s3/policies/native-packages-bucket.json.tftpl`
- `terraform/modules/api/lambda/policies/native-package-publisher.json.tftpl`

Wiring follow-up on the same date: added an explicit denial of package writes
whose `aws:PrincipalArn` is not the dedicated worker role ARN. The root passes
that role into the S3 module; the worker grant consumes the bucket ARN only
after the protection resources. The initial documentation/wiring review did not
deploy anything. The subsequent user deployment and read-only verification are
recorded in [the deployment review](dev-native-plan-review.md#post-deployment-verification).
The code gate now permits only the dev experiment, still requiring explicit
import enablement and reviewed host readiness.

## Findings and consequences

| Check                     | Documentation finding                                                                                                                                                                          | Consequence for this implementation                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conditional creation      | `s3:if-none-match` is a String condition key supported by `s3:PutObject`. The API expects `*`; an existing current object produces a precondition failure. [S1, S2]                            | Retain the exact `StringEquals` publisher condition and the bucket's missing/wrong-condition denials.                                                                         |
| Condition evaluation      | `StringEquals` matches exactly; `Null` tests presence. Negated string conditions also match a missing key. [S3]                                                                                | The two bucket condition denials overlap for a missing header; neither creates a permission exception.                                                                        |
| Copy permission           | Destination `CopyObject` uses `s3:PutObject`. AWS documents `s3:x-amz-copy-source` as a String key for restricting copies. [S1, S4]                                                            | Retain the bucket denial whenever copy-source context is present and the publisher requirement that it be absent. Do not rely on copies being unsupported.                    |
| Multipart permission      | Creation, part upload/copy, and completion use `s3:PutObject`. AWS distinguishes initiation and part operations with `s3:ObjectCreationOperation: false`. Live initiation accepted an injected conditional header. [S1, S5, S6] | Require object-creation context in the publisher and explicitly deny false/missing context in the bucket. Header enforcement alone was insufficient. Keep direct `PutObject`. |
| Version deletion          | `DeleteObject` and `DeleteObjects` require `s3:DeleteObject` or `s3:DeleteObjectVersion`, depending on whether a version is specified. [S5]                                                    | Keep both explicit deletion denials and exercise single/batch deletion in live tests.                                                                                         |
| Current-version semantics | Conditional creation checks the current version; a current delete marker permits another write. [S7]                                                                                           | Versioning alone does not enforce create-only names. Deletion protection and the absence of lifecycle expiry remain part of the design.                                       |
| Lifecycle boundary        | A general-purpose bucket policy does not prevent lifecycle expiration or transition. [S8]                                                                                                      | Preserve the dedicated bucket without expiry and audit actual lifecycle settings before qualification. The worker must not receive lifecycle or bucket-policy administration. |
| Publisher identity        | For requests signed with an IAM role session, `aws:PrincipalArn` contains the IAM role ARN, not the STS assumed-role session ARN. AWS recommends ARN operators for this key. [S10]             | Compare the exact dedicated role ARN using `ArnNotEquals`. Do not exempt arbitrary assumed-role session names or use a wildcard principal condition.                          |

These are documentation-based conclusions. The local policy evaluator still
operates on supplied context; it does not observe S3 request authorization.
The local tests include another role, a supplied STS session ARN, a missing
principal, and an independent broad writer allow. Tests using supplied principal
context are not evidence of actual role-session behavior in AWS.

On 22 September, S1, S3 and S6 were fetched again from AWS's documentation and
retained under `/tmp/aidlc-plan-tools/aws-s3-condition-primary-20260922/`.
S1 defines the operation key as Boolean; S6 uses its false value for
`CreateMultipartUpload`, `UploadPart` and `UploadPartCopy`; S3 documents that
an `IfExists` condition evaluates true when its key is absent. The new denial
therefore also fails closed for missing operation context. Local tests supply
that context explicitly and cannot establish which value AWS actually emits.

`CompleteMultipartUpload` creates an object and can include the creation
condition. The correction does not independently deny completion. Empty
multipart inventories plus verified initiation rejection are still required
for this direct-upload qualification; it is not a claim that every multipart
API was exercised or uniquely distinguished from `PutObject`.

Bucket/role administrators remain outside this guarantee: an administrator can
change the policy, lifecycle, or role attachments. Keep the worker role dedicated
to this Lambda and inspect actual attachments and bucket configuration during
qualification. The repository review found no current agent-runtime grants to
this bucket, this role's assume/pass operations, or this worker's invocation;
that review does not establish deployed account-wide permissions.

## Copy documentation discrepancy

AWS's conditional-write enforcement page says `CopyObject` with conditional
headers returns `501 Not Implemented`. Its current `CopyObject` API reference
and conditional-write guide describe destination `If-None-Match` support.
These sources conflict on this point. [S6, S7, S9]

Treat conditional copies as a supported operation that must be denied
explicitly. This is the conservative interpretation used by the existing
candidates, not a claim that the discrepancy has been resolved by execution.
The live test must show that an otherwise authorized source copy is rejected
by our policy, with and without the destination condition.

## Remaining qualification

1. The initial environment-specific plan, AWS policy storage, and exact-template
   comparison passed in `dev`. Configuration validation passes with Terraform
   1.16.3 and the existing provider lock; CI uses 1.15.0. Review a new plan before
   activation and finish the complete role/resource-policy audit, including
   adjacent prefixes, other roles, versioning, lifecycle, and administrative
   permissions. A prefix-scoped publisher template alone does not establish
   that only this worker can publish.
2. Verify the wired dependency order in the deployment plan, with protection
   established before granting uploads. Keep imports disabled until the separate host and
   deployment checks pass.
3. In a user-approved disposable environment, verify a new conditional upload,
   rejection of an overwrite, missing/wrong conditions, copy attempts, direct
   and batch deletion, other prefixes, and unauthorized roles.
4. For the next checkpoint, verify that there are no incomplete package uploads
   immediately before and after the probe. Test ordinary initiation and an
   initiation request with a signed `If-None-Match: *` header. Do not weaken the
   existing bucket policy to seed an upload. An empty inventory plus rejected
   initiation can qualify the current direct-upload path; it does not exercise
   part upload, part copy, or completion. Completion can itself carry
   `If-None-Match`; the policy does not distinguish it from conditional
   `PutObject`. If an incomplete upload exists, stop and inspect it. A broader
   multipart-completion test still needs a separately prepared fixture.
5. Verify the actual Lambda role can upload over its deployed network path.
   Do not infer this from a service-principal example or an administrator's
   successful request.

The four qualification categories emitted by the offline renderer are live S3
semantics, Terraform/IAM validation, positive/negative upload tests, and
worker-only wiring. The first category now records that documentation has been
reviewed. The `dev` deployment adds policy acceptance and inspected inline-role
evidence, but does not complete all checks in those categories. No additional
user permission is needed to read these public pages.

## Deployed permission boundary clarification

The fetched inline documents show no direct AgentCore grants to the new
functions, package bucket, job table, or source-binding table. The source API
has no package-object or worker-invocation grants. The worker has package-prefix
reads and the exact conditional publisher grant, without inline bucket/role
administration or object-deletion permissions. Managed attachment names were
initially inspected without their documents. On 22 September the current
worker managed policies were also retrieved: they contain logging and VPC
network-interface permissions, with no additional S3, job-table, invocation,
or IAM administration grants. Other account principals and organization-level
restrictions are not covered by this inspection.

Job-state ownership is a separate application guarantee. Source API
`dynamodb:PutItem` permission does not require its create-only condition;
worker `UpdateItem` permission does not require row-existence, lease, or
immutable-field conditions. A compromised trusted service could omit them.
The API and worker are isolated from the agent runtime, but not from each
other's job-state fields by IAM. Keep this distinction in the threat model and
live submission tests; it does not establish or weaken the separate required
human-approval authority boundary.

## Primary references

All references were read on 21 September 2026; S1, S3 and S6 were re-read on
22 September for the live finding. Findings above are paraphrases.

- **S1 — Amazon S3 Service Authorization Reference**, `PutObject` action and
  condition-key table:
  `https://docs.aws.amazon.com/service-authorization/latest/reference/list_s3.html`
- **S2 — PutObject**, conditional creation and request permissions:
  `https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html`
- **S3 — IAM condition operators**, string matching and key existence:
  `https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html`
- **S4 — Bucket policy condition examples**, example 2, copy-source restriction:
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html`
- **S5 — Required permissions for S3 API operations**, object operations:
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html`
- **S6 — Enforce conditional writes**, multipart exceptions and copy note:
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html`
- **S7 — Prevent overwrites with conditional writes**, current versions and
  conditional copy examples:
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html`
- **S8 — Bucket policies for Amazon S3**, lifecycle limitation:
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-policies.html`
- **S9 — CopyObject**, destination `If-None-Match` and permissions:
  `https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html`
- **S10 — AWS global condition context keys**, `aws:PrincipalArn`:
  `https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html#condition-keys-principalarn`
