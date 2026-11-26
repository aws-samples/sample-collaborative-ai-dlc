# Native package dispatch documentation review

Updated 23 September 2026; original AWS documentation review dated 22 September.
**Dev activation and the dispatch-template fix are applied and verified; a fresh
authenticated public UI import succeeded through normal Pipe/SQS without replay.**
All 16 activation checks passed, including exact deployed worker hash, both
import flags, enabled consumer, running Pipe, probe/log retirement and unchanged
permissions. The fresh normal import completed in one leased attempt. The earlier
diagnostic replay is historical evidence. No native agents were executed.

The original five AWS pages were retrieved over HTTPS with their expected page titles.
Local HTML/text evidence is under
`/tmp/aidlc-plan-tools/aws-pipes-primary-20260922/`. For that 22 September change,
Terraform 1.16.3 formatting and configuration validation passed, with the two existing
Git binding-table deprecation warnings. This does not validate service-side
filtering, transformation, or delivery.

## Filter correction

The previous filter required `eventName=INSERT` and
`dynamodb.NewImage.state.S=QUEUED`. AWS's filtering guide lists `eventName`
among fields unavailable to filters, while its DynamoDB-to-SQS tutorial
explicitly uses that field. These references conflict. [D1, D2]

The configuration now filters only the documented DynamoDB record data:

```json
{
  "dynamodb": {
    "NewImage": {
      "state": { "S": ["QUEUED"] }
    }
  }
}
```

This removes dependence on the disputed metadata field. The job store currently
creates `QUEUED` rows and moves them to `RUNNING` or a terminal state; it does
not return worker updates to `QUEUED`. A delete lacks a new image. A future
metadata update to a queued row could emit another pointer, which the worker
must handle through its existing conditional claim and duplicate-delivery
logic. The filter is not an authorization or exactly-once guarantee.

## Pointer transformation

The target remains SQS, without enrichment. The template references the string
partition/sort keys under `dynamodb.Keys`. The applied correction uses a raw HCL
heredoc to preserve literal delimiters and quoted scalar substitutions:

```hcl
input_template = <<-JSON
  {"schemaVersion":1,"projectId":"<$.dynamodb.Keys.projectId.S>","jobId":"<$.dynamodb.Keys.jobId.S>"}
JSON
```

Live `DescribePipe` now exactly matches this reviewed raw-heredoc template,
including literal `<$.` tokens. Historically, the `jsonencode` template contained
literal `\u003c`/`\u003e` backslash sequences and no literal `<$.` tokens.
Terraform's documented HTML escaping explains those earlier bytes. Parsing that
template as JSON reconstructs the expected three-key object, so that check alone
misses the delimiter defect. The plan check must inspect
the raw final string for literal path tokens as well as exact parsed keys and
values. [D6]

The pinned AWS provider v6.56.0 declares `input_template` as an optional string
with length validation only: no `DiffSuppressFunc`, `StateFunc` or `ForceNew`.
The parent block has no such hooks, and the resource has no `CustomizeDiff`.
Its expand/read paths preserve the string, and a changed `target_parameters`
block is sent through `UpdatePipe`. The raw-versus-escaped difference is not
suppressed; the reviewed and applied change was an in-place update. [D7, D8]

AWS's transformation page inconsistently describes quotes as required and
optional, but both descriptions permit quoted string substitutions. The same
page warns that paths are not validated at creation and extracted values are
not escaped. The corrected syntax avoids relying on automatic string quoting;
it does not make transformation an input validator. [D3]

The application constrains job keys before persistence. The worker independently
validates the pointer shape and keys, then reloads the authoritative actor,
source, selection, and lease state from its protected table. Missing, malformed,
or extra fields must not become authority. The worker parser is unchanged.
AWS documents per-record transformation into the SQS batch API, including batch
size one. Singleton-array delivery applies to direct Lambda/Step Functions
targets; batching alone does not establish a wrapped or double-encoded SQS
body. The original body's shape remains unknown. [D3, D9]

## Position, retention, and retries

The DynamoDB source documentation recommends `TRIM_HORIZON` to cover the
eventual-consistency window during Pipe creation or source-polling updates.
It also describes at-least-once delivery to SQS and recommends a record-age
cutoff below the documented 24-hour stream retention. [D4]

Keep `TRIM_HORIZON`, batch size one, parallelization one, and maximum record
age 82,800 seconds (23 hours). `MaximumRetryAttempts=-1` is a supported value,
but does not extend source retention. This is dispatch retry behavior, separate
from worker attempts and SQS receive counts. [D5]

A failed filter can advance past records rather than keeping them available
for later processing. Existing durable jobs therefore remain necessary for
recovery; changing a filter is not sufficient to recover all missed jobs. [D1]

## Applied fix and normal delivery — 23 September 2026

The user applied `/tmp/aidlc-native-dispatch-fix-dev.tfplan`: exactly one
in-place Pipe input-template change, with no other resource/output/deletion
changes. All 11 review assertions passed. Live verification at **10:56:26.659Z**
confirmed exact raw-template agreement, Pipe `RUNNING`, unchanged
role/source/target/filter and an enabled SQS consumer. The
[deployment record](native-package-import-checkpoint.md#current-deployment--dispatch-fix-applied-and-verified)
retains the applied plan's hash and review evidence.

At **10:57:37.216Z**, a fresh authenticated UI official public `latest` job,
`61f63842-1ce8-4b1e-b145-b3efdf6c3075`, used **normal Pipe/SQS delivery only,
without diagnostic replay**. It reached `SUCCEEDED`, attempts **1**, at
**10:57:46.439Z** (`updatedAt=1790161066439`); worker duration was
**7,516.43 ms**, maximum memory **738 MiB**, initialization **340.20 ms**.
UI Download verified v2.9.0, commit
`22f5d1b15a064c9ae80046e5b1761d5877e2f69f`, with Claude, Codex, Kiro and OpenCode.
The complete job pin, materialization and S3 receipt match the earlier import.
The manifest was reread and verified; all five file versions are unchanged,
with exactly six object versions and no delete markers.

Evidence under `/tmp/aidlc-plan-tools/`:
`native-dispatch-fix-deployed-20260923.json` and
`native-normal-import-live-20260923.json`, plus
`native-normal-import-archive-verification-20260923.json`. The
[import checkpoint](native-package-import-checkpoint.md#live-results--23-september-2026)
records package identifiers and historical archive verification.

**Historical initial finding.**

At 06:18:41Z, the authenticated UI submitted official `latest`
job `b17f3cc4-d556-43bd-9cd2-7693f77c8d0e`. A normal SQS invocation took
8.34 ms, leaving `QUEUED`, attempts 0; no body was captured. At 06:22:54Z,
one direct-Lambda canonical-pointer replay of that same authoritative job
succeeded in 8,073.01 ms, using 724 MiB of 8,192 MiB and one leased attempt.
The UI Download preview and independent exact-version S3 manifest/five-file
verification passed for v2.9.0 and all four projections. Signatures remain
`not_checked`, native execution `not_qualified`.

The fresh normal success after the template-only update **supports the
escaped-template explanation** for the earlier failure. The original SQS body
was never captured, so its exact shape remains unknown. At the historical
checkpoint the unread message was in flight; no SQS delete or visibility mutation
was performed. The correction does not rewrite an existing message.

The subsequent [local initialization test](native-initialization-probe.md)
passed for all four harnesses on Linux ARM64. Model-driven interaction remains
the next experiment. Broader public/private provider,
duplicate/malformed-pointer, filter-exclusion, retry/DLQ, restart and recovery
cases remain acceptance work.

## Primary references

- **D1 — Event filtering in Amazon EventBridge Pipes**:
  `https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-event-filtering.html`
- **D2 — Tutorial: Create an EventBridge pipe that filters source events**:
  `https://docs.aws.amazon.com/eventbridge/latest/userguide/pipes-tutorial-create-dynamodb-sqs.html`
- **D3 — Amazon EventBridge Pipes input transformation**:
  `https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-input-transformation.html`
- **D4 — Amazon DynamoDB stream as a source for EventBridge Pipes**:
  `https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-dynamodb.html`
- **D5 — PipeSourceDynamoDBStreamParameters API reference**:
  `https://docs.aws.amazon.com/eventbridge/latest/pipes-reference/API_PipeSourceDynamoDBStreamParameters.html`
- **D6 — Terraform `jsonencode` escaping**:
  `https://developer.hashicorp.com/terraform/language/functions/jsonencode`
- **D7 — AWS provider v6.56.0 target schema and string mapping**:
  `https://github.com/hashicorp/terraform-provider-aws/blob/v6.56.0/internal/service/pipes/target_parameters.go`
- **D8 — AWS provider v6.56.0 Pipe update handling**:
  `https://github.com/hashicorp/terraform-provider-aws/blob/v6.56.0/internal/service/pipes/pipe.go`
- **D9 — Amazon EventBridge Pipes batching and concurrency**:
  `https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-batching-concurrency.html`
