# Native discovery checkpoint

29 September 2026 — `feat/native-aidlc-execution`.

M1a connects native drafts to the normal project, sidebar and dashboard lists.
Native entries open their existing native status page. `READY` means workspace
ready, not successful agent execution. Model start, work, graph, editing, human
actions and per-unit PRs remain unavailable where their native backend path is
not implemented. The first real turn, durable files/question and graph
publication are M1b; discovery alone does not complete that feature milestone.

## Authority and pagination

`GET /projects/{projectId}/native-intents` retains its capability response.
`?view=list&limit=25&cursor=…` returns `{items,nextCursor}`. Public summaries omit
the prompt, runtime pins, role/access-point identities and credentials.

The API queries `NativeByProjectCreatedAt` on the protected native binding
table, then validates each hint against a strongly consistent source read.
Membership and physical project identity are checked before and after listing.
Limits are 1–50; cursors are confined to the requested project and grant no
authority. Deleted source rows are skipped without refilling the page.
An empty page can therefore still have a continuation cursor.

The index is eventually consistent. The frontend combines protected native
summaries with platform summaries using backend/project/intent identities.
Agent-writable platform META does not establish native authority. This
increment writes neither META projections nor graph vertices.

## Local validation and applied deployment

The backend's 365 tests pass, including 70 listing cases covering pagination,
timestamp ties, stale deletion, full source validation, changed membership,
project identity and malformed/cross-project cursors. API build, targeted lint
and formatting pass. Terraform validates with zero errors and four key-field
deprecation warnings.

The frontend's 262 focused tests pass, as do typechecking, production build,
lint, formatting and diff checks. Vite retains its large-chunk warning.
Coverage includes backend/project identity collisions, native pagination,
prompt-only drafts, disabled actions, native routes bypassing platform
providers, denial clearing and late responses after account changes. Native
summaries stay out of persisted caches. An independent source review identified
four issues, all now resolved and covered by local regressions; this is not
live membership-revocation proof.

The scoped plan is based on state **1143** and contains three in-place AWS
updates:

- Add the discovery GSI to the existing protected table, retaining its primary
  keys, on-demand billing, encryption and point-in-time recovery.
- Grant the native API `dynamodb:Query` on that exact index ARN.
- Update the native API code.

The runtime, preparation worker, queue, EFS configuration and agent permissions
are unchanged. Local archive metadata is replaced. The plan destruction check,
18 parent checks and 26 independent plan checks pass. Deferred archive
preparation was run locally and the concrete ZIP was built from the reviewed
inputs. The user applied the deployment; state is now **1144**. The actual API
ZIP and bundle match the reviewed hashes below, including the logging
configuration that was deferred in Terraform.

| Item                                            | Value                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Applied plan path (historical; file now absent) | `/tmp/aidlc-native-discovery-dev.tfplan`                           |
| Plan SHA-256                                    | `4b6f317b6cb928430553ba1ea26a1ce824e9c781cd211705517e2ba71a01f817` |
| ZIP SHA-256                                     | `f167cda282f4f4a94c6218e8ae46af7ca0e651dfa5831aadc0ee3ca44ffb7b62` |
| API bundle SHA-256                              | `f524532fc04dfe0cc87f43d005e33ad999ebe88917a0d85330b4588db70c255d` |
| Frozen backend/Terraform inputs                 | 251 files                                                          |

Evidence: `/tmp/aidlc-plan-tools/native-discovery-deployment-20260929/`.
Backend validation: `/tmp/aidlc-plan-tools/native-discovery-implementation-20260929/`.
The scoped plan does not establish full-stack convergence. The original binary
plan is no longer present; its saved JSON and review receipts remain, and the
actual deployed bytes were downloaded and compared.

Before deployment, the updated frontend still opens the authenticated native
status page, an existing platform draft and a completed platform intent with
its work products and activity panel. The normal project list retains
its platform entries and shows a native-list loading error against the old
API, as expected. This is a compatibility check, not successful native
discovery. Full reload cleared one development hot-reload context error.
The final native breadcrumb stays on the native URL and the platform activity
toggle is absent. Native `READY` content remains visible with execution,
human-action, edit, unit-PR and intent-delete controls disabled.

## Verification after deployment — passed within the recorded scope

The independent backend review passes **28 deployment checks and 13 discovery
checks**. The API is Active/Successful, its configured values and exact inline
policy match the reviewed change, and the only added permission is Query on
the discovery index. The table and GSI are ACTIVE. An exhausted bounded GSI
query, consistent primary inventory and ten consistent item reads contain
exactly the original A–J fixtures, all READY. This checks actual records rather
than approximate table counts. All 251 backend/Terraform and 23 frontend source
hashes still match the predeployment review.

Lambda's managed runtime-version ARN changed while its update mode is Auto;
the configured Node.js version and other reviewed configuration did not change.
This metadata observation is recorded separately from the application ZIP
match.

With the existing flappy-bird member session, the local frontend now:

- Lists the ten original native workspaces alongside the platform intents in
  the normal project list, with distinct Native badges and workspace status.
- Opens J through the project list, sidebar and both dashboard layouts into
  its native URL; saved-URL reload retains protected status.
- Keeps unsupported native execution, answer, approval, edit, per-unit PR and
  delete controls disabled, and omits the platform activity toggle.
- Retains existing platform navigation. Opening the existing platform draft
  triggered its existing autosave timestamp behavior; no content was edited
  and no model was started.

The live listing fit in one API page. Multi-page pagination, a second member,
collection denial and loaded-to-revoked races were not exercised in this loop;
local tests and earlier item/capability denial checks are separate evidence.
No model turn, published native files/question or graph integration is claimed.
Evidence is under the deployment directory's `applied/` folder, including
`deployment-proof.json`, `discovery-index-proof.json` and
`browser-verification.json`.

## Approved first real-task draft

The user selected **“Fix the pipe visualization” in a new native draft**.
The authenticated form created
`e0d2836d-c794-48d0-8b77-52550cf3c65a` in flappy-bird, using Codex and the
already verified official AI-DLC v2.9.0 package. The prompt is preserved exactly:

```text
# Fix the pipe visualization


Pipes are looking boring - let's make them more cool!
```

The draft has reached **Workspace ready**. It appears in the normal project
list alongside the separate platform draft with the same title and opens its
own saved native URL. The protected index contains eleven native records after
creation. A separate 16-check read verifies its identity, exact prompt and
package binding; the original ten-fixture audit is retained unchanged.

The subsequent readiness review passes **15 checks**. The correlated server
Prepare POST at **09:08:15.179 UTC** to protected READY at **09:09:59.867 UTC**
is **104.688 seconds (about 1m45s)**. This uses backend events, not the later
browser observation; the exact PREPARING-write timestamp is not retained.
Five reconciliation passes include short waits for the AP, IAM propagation,
runtime and endpoint, followed by a successful readiness result. The verifier
performed no additional runtime invocation. See `applied/native-pipe-ready-proof.json`.

The project has one primary application repository, `JWThewes/flappy-bird`,
with a connected, write-verified GitHub source-control binding. Space agent
settings show an available platform credential fallback. These are connection
metadata observations, not checkout or inference proof. No replacement
credentials or repository binding are requested.

Start is still disabled. M1b must explicitly bind an execution-capable runtime
image and policy for this same draft: its existing immutable preparation image
cannot be silently replaced by deploying a new global image or repeating
Prepare. Preserve its UUID, prompt and package pin, resolve and pin the
application base commit and the actual starter's existing credential binding,
then connect the real turn, exact files/question and graph publication. The
first live execution verification stops at the workflow's first question.
