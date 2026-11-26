# Native workflow-source settings checkpoint

Target: existing `dev`, `us-east-1`. The user runs the frontend locally.
Status: applied by the user on 22 September 2026. Read-only checks then confirmed
source settings enabled, the tested capability bundle deployed, runtime
references updated, and package imports/dispatch disabled. The first
authenticated public-source save/list check passed. This task did not deploy.

This is the historical source-settings checkpoint. Dev package imports were
activated afterward, verified on 23 September. See the
[import checkpoint](native-package-import-checkpoint.md) for current state and
the pending dispatch correction; disabled-import statements below describe
this earlier deployment.

This checkpoint enables owner/admin configuration of workflow sources and
member viewing. It does not enable package imports or native agent execution.
No test project ID is needed to prepare the deployment. Choose an existing
space where the tester is owner/admin when performing the browser checks.

## Scope and deployment

The source API and protected infrastructure are already deployed with their
features disabled. Read-only evidence is recorded in the
[foundation deployment review](dev-native-plan-review.md#post-deployment-verification).
The applied plan uses:

```hcl
enable_native_workflow_sources     = true
enable_native_package_jobs         = false
native_package_jobs_host_qualified = false
```

This enables source settings throughout `dev`; it is not a per-project feature
switch. Existing membership still governs visibility and owner/admin mutations.
It does not create a source binding automatically or attach a workflow source
as an application repository.

The initial refreshed plan contained three Lambda environment updates and no
creates/deletes: the source flag plus two existing `CORE_RUNTIME_VERSION`
references moving from 101 to the already-deployed runtime version 102.
The runtime resource itself had no planned change. This preliminary plan is
preserved locally as `/tmp/aidlc-native-sources-dev-before-ui-fix.tfplan` and is
**not the deployment candidate**.

Rollout review found that import controls initially appeared before a rejected
request revealed that imports were disabled. This is fixed locally: source
listing returns `{ sources, capabilities: { packageImportsEnabled } }`.
The capability uses the same effective boolean as the package routes. The UI
requires explicit `true` before mounting import controls or restoring/polling
a saved package request. Older array responses and missing/invalid capability
information preserve source CRUD while hiding imports. The existing
array-returning service method remains compatible.

The fix passed 335 focused tests across five backend/frontend test files,
including disabled initial state with a saved request, explicit enablement,
late responses after disablement, and stale project responses. Frontend
typechecking, changed-file lint/formatting, the workflow-source Lambda build,
and production frontend build pass. The frontend build retains its existing
large-chunk warning.

The final saved plan contains that tested change. Preserve the general
destruction guard. A saved plan must not be reused after relevant
source/configuration changes or after another deployment changes state.

The saved plan used explicit plan-time overrides. After the user applied it,
the same three approved values were recorded in the local
`terraform/environments/dev.tfvars` so later plans preserve this checkpoint.
Shared Terraform defaults still disable the feature. This configuration-file
update does not itself change deployed resources.

## Reviewed deployment candidate

Plan generated 21 September 2026 at 15:25 UTC; final review completed
22 September. A read-only state pull on 22 September confirmed the same
Terraform lineage and serial **1083**. Relevant source files and the tested
Lambda bundle were not modified after planning.

Saved plan: `/tmp/aidlc-native-sources-dev.tfplan`

SHA256:
`94384f354f4366a0e0c659ef2721022528dc4c890e3516d6973a53f0924874a7`

The exact planned changes are:

| Resource | Change |
| --- | --- |
| Workflow-source Lambda | Deploy the capability response and enable source settings. `NATIVE_PACKAGE_JOBS_ENABLED` stays `"false"`. |
| Intents Lambda | Update `CORE_RUNTIME_VERSION` from 101 to the already-deployed 102. |
| Environment-control Lambda | Update the same existing runtime-version reference from 101 to 102. |
| Three local Terraform packaging helpers | Replace the source Lambda's archive manifest, archive build trigger, and filename/hash helper to package its changed code. |

There are no AWS resource creates/deletes/replacements, IAM or persistent-storage
changes, or AgentCore runtime changes. The package worker and SQS consumer stay
disabled, no Pipe is created, and the hard qualification gate remains false.
The normal destruction inspector passes. Terraform's aggregate counts include
three creates/deletes for **local packaging helpers**, not cloud resources.

Use the existing dev deployment credentials and run from the repository root:

```sh
terraform -chdir=terraform apply /tmp/aidlc-native-sources-dev.tfplan
```

The verification profile is read-only and cannot apply this plan. Direct apply
avoids the wrapper's extra SYSTEM reseed and legacy-agent retirement actions;
neither is part of this checkpoint. The local frontend can remain running.

Local review artifacts:

- `/tmp/aidlc-native-sources-dev.tfplan.json`
- `/tmp/aidlc-plan-tools/native-sources-dev-reviewed-20260922.json`
- `/tmp/aidlc-plan-tools/native-sources-capability-backend-build-20260921.log`
- `/tmp/aidlc-plan-tools/native-sources-capability-frontend-build-20260921.log`

State-revision agreement does not establish that no cloud resource was changed
outside Terraform after planning. Terraform will reject a saved plan whose
state is stale; regenerate and review if the deployment baseline changes.

## Applied verification

Collected 22 September 2026 at 06:49 UTC using the matching account's
`solution-read` profile. All 16 configuration/code checks passed:

- Source, intents, environment-control, and package-worker Lambda functions
  are active with successful updates.
- The source API reports `WORKFLOW_SOURCE_API_ENABLED=true` and
  `NATIVE_PACKAGE_JOBS_ENABLED=false`; its CORS allowlist includes the exact
  local frontend origin `http://localhost:5173`.
- Both existing runtime references are 102.
- Package-worker imports are disabled, its single SQS consumer is disabled,
  and no matching Pipe exists.
- The deployed source function's `CodeSha256` matches the archive created by
  the applied plan. Its `index.mjs` bytes match the locally tested build and
  contain the new capability field.

The source archive hash is
`66LWk7morTFl4e7yAIEiF46YdKl96qHT0TV7ZnsAHJw=` (base64 SHA256).
Selected metadata is retained locally at
`/tmp/aidlc-plan-tools/native-sources-applied-verification-20260922.json`.
The local Vite server is listening on port 5173.

These checks establish deployed configuration and code identity. They do
not execute the authenticated list/configure routes or establish successful
Neptune/provider connectivity. No source binding, package job, or coding-agent
run was created by this verification.

## First public-source result

The user subsequently performed the browser save using the default public
GitHub source and reported **Configured**. The UI reloads the source list after
saving. A bounded, consistent read of the protected binding table then found
one matching record, verified at `2026-09-22T06:51:02.059Z`, with:

- Repository `awslabs/aidlc-workflows`, provider `github`.
- Status `active`, authentication `public`, access `read`.
- Capabilities `repositoryRead=true`, `repositoryWrite=false`, and
  `contents=read`.
- A persisted binding revision and project/source identifiers.

This combines user-observed authenticated save/list behavior with independent
storage evidence. The read inspected one item, had no continuation page, and
did not retrieve actor or credential fields. Selected record identifiers and
metadata are retained locally in
`/tmp/aidlc-plan-tools/native-public-source-stored-20260922.json`.

The first public-source configuration check is passed. Page-refresh,
reverification/removal races, member/nonmember authorization, and private
provider coverage remain separate unverified cases. Package integrity,
release selection, archival/recovery, and harness execution have not been
tested by this source configuration.

## Browser verification after the user's deployment

1. Keep the local frontend on the checked-out native branch, sign in, and open
   an existing space's **Settings → Agent** page as an owner/admin.
2. Confirm **AI-DLC workflow sources** appears and package import controls do
   not. Loading or refreshing this section must not submit/poll package jobs.
3. Use the existing form defaults: GitHub, `awslabs/aidlc-workflows`, public
   access. Save the source. This public path needs no OAuth connection,
   delegation confirmation, or application-repository attachment.
4. Confirm the configured source survives a page refresh. Verify-access and
   removal operations must use the current binding revision; a stale request
   must not silently overwrite a newer configuration.
5. A regular project member should be able to view the source without gaining
   owner/admin configuration controls. A nonmember must not obtain its details.
6. Confirm ordinary existing-project reads still work. Check the existing
   published SYSTEM workflow before starting any new platform execution; this
   checkpoint does not require reseeding unchanged defaults.

Only record project/source IDs, expected status, and sanitized error codes.
Do not copy authentication tokens, private repository contents, or credentials
into the evidence.

Saving a public source verifies source configuration/access, not package
integrity, highest-stable selection, private credential handling, or any
harness. Public/private GitHub, GitLab, and Bitbucket coverage and positive/
negative storage checks remain part of the separate
[package import checkpoint](native-package-import-checkpoint.md).

If the source API fails, keep imports and agent execution disabled and diagnose
the returned error. Do not substitute graph membership with another authority
or broaden worker/storage grants to make the smoke check pass.
