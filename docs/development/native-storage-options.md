# Native execution: persistent filesystem options

24 September 2026 — investigation on `feat/native-aidlc-execution`.

Historical storage assessment. Subsequent EFS and native interaction tests are
recorded in the [current checkpoint](native-interaction-probe.md#runtime-110--current-kiro-verification).
As of 25 September, Kiro's bounded two-turn loop passed on runtime 110; real
project isolation and cold recovery still require implementation/qualification.

**Current direction: AgentCore microVMs with an EFS working directory; harness
executables and active databases remain on AgentCore local disk. EC2/Instances
is explicitly excluded by the user.**

The earlier EBS recommendation assumed we needed a single persistent filesystem
for both working files and active harness databases. That assumption was too
broad. The user's split avoids the active-database/NFS conflict and closely
matches the existing backend's local-store/durable-export pattern. Live EFS
filesystem tests now pass; native interaction, recovery and access-point
isolation still require qualification.

The EFS retry was deployed successfully. Runtime **104** is READY with
`/mnt/native` on EFS, `/mnt/workspace` retained and scoped discovery permissions
unchanged. Live hard links, symlinks, rename, executable permissions and a
**1 GiB + 8 MiB** write/sync/readback passed with matching checksums and cleanup.
Signed AI-DLC installation/configuration also passed on EFS for all four
harnesses (13 commands, 67 filesystem checks). Our mount check needs a
correction for AgentCore's backing-overlay/EFS mount stack, and the 137-second
installation requires a longer setup timeout before model interaction. Both
corrections are locally built and tested. The evidence is in the
[EFS verification checkpoint](native-efs-probe-checkpoint.md). No EC2 resource
was provisioned and provider versions are unchanged.

## What has actually been verified

The original interaction recovery deployment was verified at runtime 103,
including its image and seven remaining Lambda bundles. The subsequent EFS
deployment was verified at runtime 104 and Terraform state serial 1103.

The first Codex operator probe stopped before starting a model. Native
AI-DLC v2.9.0 uses hard links for transaction locks during both installation and
project pinning. Direct diagnostics in that AgentCore session established:

- `/mnt/workspace` rejects hard links with errno `-524`.
- `/tmp` supports hard links, symlinks and rename.
- Moving only the installation to `/tmp` lets `aidlc use` succeed, but project
  pinning still fails for all four harnesses on `/mnt/workspace`.
- Moving both installation and project to local disk passes actual AgentCore
  initialization for all four harnesses: 13 commands and 67 filesystem checks.

This is a filesystem compatibility finding, not a Codex-specific failure.
No model-driven question, answer or cold recovery has been demonstrated.
See [the interaction checkpoint](native-interaction-probe.md).

## Comparison

| Option | Native hard-link requirement | Capacity | Main implication |
| --- | --- | --- | --- |
| Current managed session storage | Unsupported; reproduced live | Fixed 1 GB per session; not adjustable | Does not meet our active native workspace requirements |
| S3 Files access point | Explicitly unsupported | Larger storage backed by S3 | Suitable for some input/output datasets, not the unmodified native workspace |
| EFS access point | Supported | Elastic filesystem capacity | Fits current microVM compute, but storage is shared and uses NFS |
| EBS / Instances | Excluded by user | Not being pursued | Keep AgentCore microVM compute |

The 1-GB limit is the existing managed **disk** limit, not a RAM setting. AWS
documents it as non-adjustable. The EFS working directory is a separate storage configuration,
not a request to increase that managed-session quota. [1][2][3]

## S3 Files

AWS explicitly lists hard links as unsupported. It therefore reproduces the
operation that currently blocks native installation and project configuration.
More capacity would not fix the incompatibility. [1]

S3 remains useful as an object archive for packages, published artifacts and
recovery exports. That does not require using S3 Files as the active filesystem.
This distinction preserves the original native-filesystem model.

## Selected filesystem separation

The proposed native layout is:

| Data | Active location | Persistence behavior |
| --- | --- | --- |
| Coding harness binaries | Existing container image / AgentCore local disk | Recreated from the pinned image |
| Active harness homes, SQLite databases, sockets and process-local caches | Per-execution local directories | Restore required durable state before starting a resumed harness |
| Native AI-DLC installation/workflow files and project metadata | Per-execution EFS paths | Native commands operate on real files supporting hard links |
| Git worktree, `.git`, native artifacts, questions, state, audit and memory | EFS working directory | Retained independently of microVM local disk |
| Large dependency and build-output directories | EFS by default; measured exceptions for host-local scratch | Avoid filling the current 1-GB managed session mount |
| Validated harness recovery exports | Durable per-execution storage, preferably on EFS alongside the recovery generation | Inactive copies, never databases opened directly by harness processes over NFS |

Use a stable working-directory path when the same execution resumes. Preserve
native project configuration and relative file layout; configure the harness
HOME/XDG paths separately instead of moving all runtime data with `cwd`.

Existing code provides concrete reuse:

- `lambda/agentcore/cli/kiro-store.js`: local SQLite storage with restore before
  execution and durable export afterward.
- `lambda/agentcore/cli/opencode-store.js`: local active store with serialized
  restore → execute → persist handling.
- `lambda/agentcore/cli/codex-store.js`: local `CODEX_HOME`, with validation and
  atomic publication of the selected resumable rollout.
- `lambda/agentcore/Dockerfile`: the existing per-harness directory assignments.

These helpers are foundations, not proof that native recovery is complete.
The native diagnostic currently keeps its CLI homes local but does not wire
these persistence helpers into cold resume. Kiro/OpenCode exports also need
stronger failure handling before they can underpin the native pilot's recovery
promise: do not remove the last good checkpoint before a replacement is ready,
and do not silently treat a failed export as a recoverable human wait.

An EFS project can survive while unexported local conversation state is lost.
After the relevant processes are quiescent, publish a consistent harness-state
export together with the matching native checkpoint generation. A live database
must not be copied piecemeal. Restore and validate the selected generation before
resuming; report an interrupted or incomplete turn explicitly.

## EFS

EFS provides the missing hard-link operation and advisory locking. AgentCore
can mount an EFS access point directly on its existing microVM compute type.
The repository's locked AWSCC 1.94.0 provider already supports the mount
configuration. [1][4]

For this repository, the infrastructure work would include an EFS filesystem,
access points, mount targets in the AgentCore subnet Availability Zones,
security-group rules for NFS, narrowly scoped filesystem permissions, and
mount ownership matching the container's UID/GID.

There are two substantial design constraints:

1. **An access point is mounted into every session of that runtime.** The
   current runtime serves multiple projects. A shared access point plus
   UUID-named subdirectories is not an authorization boundary: agent code could
   enumerate other accessible directories. We would need runtime/access-point
   boundaries aligned with the chosen project or execution trust boundary,
   together with IAM and filesystem policies. Access points are configured on
   the runtime, not supplied dynamically per invocation. [1][4]
2. **Local harness state needs explicit durable recovery.** Active homes and
   databases stay on local disk, avoiding SQLite's documented WAL/network-
   filesystem restriction. We must qualify consistent export and restore of
   each harness's required state, and check that no project-local active
   database is implicitly created on EFS. Existing helpers cover part of this
   lifecycle; a successful native installer does not prove cold resume. [5]

We would also measure dependency-install performance and large file-count
workloads. EFS semantics and latency differ from a local block filesystem;
neither its POSIX support nor a basic mount test proves all-four continuation
and recovery.

The bounded review of the installed harness versions found:

| Harness | Confirmed state behavior | Consequence |
| --- | --- | --- |
| Codex 0.145.0 | Pinned source enables SQLite WAL; database placement can be separated with `sqlite_home` / `CODEX_SQLITE_HOME` | Keep active state local and qualify the existing resumable rollout export for native recovery |
| OpenCode 1.17.20 | Actual binary and pinned source enable SQLite WAL; `OPENCODE_DB` can override database location | Keep active XDG state local and qualify consistent durable export/restore |
| Kiro 2.19.2 | Unauthenticated startup created `data.sqlite3` in DELETE mode | The actual v2 conversation store and journal mode remain unverified; do not infer them from the startup settings/auth database |
| Claude 2.1.246 | Binary contains project/session JSONL paths; our code controls `CLAUDE_CONFIG_DIR` | Keep the native active config home local and qualify required session exports and restart continuity |

Codex and OpenCode findings were checked against their exact versioned upstream
implementations and configuration schema. [11][12][13] Kiro and Claude
observations came from a network-disabled local image inspection matching the
Dockerfile's pinned versions; they are narrower observations, not complete
storage compatibility results. No authenticated Kiro conversation database was
created in that inspection.

Native AI-DLC's v2.9.0 transaction code creates hard-link locks and checks local
PIDs when identifying stale owners. Its extracted implementation matches the
pinned upstream source. Independent microVMs must not concurrently mutate a
shared project **or machine-install root** based on that local-PID check alone.
External ownership/fencing remains necessary. This reinforces the existing
serial-supervision requirement; it is not solved by changing storage.

**Assessment:** a viable working-directory design with the active harness
stores kept local. The SQLite/WAL restriction does not disqualify this split.
EFS placement and whole-execution recovery still require live qualification.

## EC2 / Instances disposition

The user explicitly ruled out EC2. The previous Instances feasibility research
is retained only in temporary evidence files; it is not an implementation path.
No capacity provider, Instances runtime, provider upgrade or EBS volume is to be
introduced for this work.

## Next verification loop

Qualify the EFS/local-harness split using one isolated synthetic workspace before
extending the native product flow:

1. Prepare an EFS access point and mount target configuration for the existing
   microVM/VPC model, with scoped mount/write permissions and matching UID/GID.
   Keep the pilot access point limited to test data; do not expose real project
   trees through a shared all-project access point. The current AWSCC 1.94.0
   provider supports EFS configuration, so an Instances-driven upgrade is not
   needed.
2. Mount EFS at a distinct path such as `/mnt/native`, retaining the existing
   managed mount for current-backend compatibility. Point only the native
   diagnostic's working directory and installation roots to its EFS test area.
   The user performs deployment after reviewing the plan.
3. Verify native hard-link locking, rename, ownership, executable permissions
   and real data writes exceeding 1 GB. Check dependency installation and
   representative build performance.
4. Keep each harness's active home/database local. Run native initialization,
   a real question, the separate test answer and continuation for all four
   harnesses against the EFS project.
5. Qualify consistent export/restore of the required harness state. Stop and
   resume the same execution; verify native file identity, session bindings and
   continuation. A stopped microVM's local state must not be assumed present.
6. Test writer ownership and project isolation before placing real project data
   on EFS. Native PID-based locks alone cannot arbitrate different microVMs.

This preserves the agreed native-filesystem model and AgentCore compute choice.
It does not replace the protected human authority or the P5 recovery inventory.
The EFS mount supports the working files; the existing local-harness pattern
supplies the starting point for conversation-state durability.

AWS's current documentation says managed session storage resets on runtime
version changes; the existing repository comment describes different historical
observations. Treat that discrepancy as unqualified. EFS-backed working files
should not depend on the managed mount's retention semantics. [1]

## Sources

Official documentation retrieved on 24 September 2026:

1. [AgentCore filesystem configurations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html)
2. [AgentCore session storage limits](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)
3. [Amazon EFS overview](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html)
4. [Amazon EFS access points](https://docs.aws.amazon.com/efs/latest/ug/efs-access-points.html)
5. [SQLite write-ahead logging](https://sqlite.org/wal.html)
6. [How Runtime Instances works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-how-it-works.html)
7. [Runtime Instances data management](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-data-management.html)
8. [Runtime Instances security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-security.html)
9. [AWSCC 1.103.0 capacity-provider resource](https://github.com/hashicorp/terraform-provider-awscc/blob/v1.103.0/docs/resources/bedrockagentcore_capacity_provider.md)
10. [AWSCC 1.103.0 runtime resource](https://github.com/hashicorp/terraform-provider-awscc/blob/v1.103.0/docs/resources/bedrockagentcore_runtime.md)
11. [Codex 0.145.0 SQLite implementation](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/state/src/sqlite.rs)
12. [Codex 0.145.0 configuration schema](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/core/config.schema.json)
13. [OpenCode 1.17.20 database implementation](https://github.com/anomalyco/opencode/blob/v1.17.20/packages/core/src/database/database.ts)
