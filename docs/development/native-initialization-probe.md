# Native initialization probe contract

Status, 23 September 2026: **real v2.9.0 installation and configuration passed
for all four harnesses in a local Linux ARM64 container**. This is an operator
experiment using public package bytes, not a deployed native execution service.
No model-driven workflow, human-response transport or execution recovery has
been exercised.

## Observed initialization result

The normal authenticated UI import completed first through Pipe/SQS, without
diagnostic replay. The experiment then used that exact package:
`sha256:0399ab50fa7ed00eae5a246159fdb1d594c8fd4946c6aeb72452d9d6e2770ce0`,
commit `22f5d1b15a064c9ae80046e5b1761d5877e2f69f`.

The production loader, signature adapter, command runner and filesystem
inspector ran against real files and subprocesses. GitHub CLI 2.101.0 verified
the supplied attestation against the selected repository, release workflow,
tag and commit. The local authority callback used the selected public source;
production broker membership/revocation enforcement is not qualified by this
experiment.

The final run completed **18/18 commands in 34.1 seconds**, from
11:16:47Z to 11:17:21Z:

| Harness | Native configuration | Doctor failures | Doctor warnings | Filesystem checks |
| --- | --- | --- | --- | --- |
| Claude Code | Passed | 0 | 4 | 16 passed |
| Codex | Passed | 0 | 4 | 18 passed |
| Kiro CLI | Passed | 0 | 4 | 17 passed |
| OpenCode | Passed | 0 | 4 | 16 passed |

All doctor commands returned native code 0. The retained warnings concern the
installed command's login-independent PATH, uncommitted workspace records,
offline update discovery, and plugin host inventory before SessionStart.
These are not proof that hooks will execute correctly in a coding session.
Resolve or exercise PATH and SessionStart behavior in the interaction test.

Live failures led to two local code corrections: the signature adapter now
accepts additional upstream distributions while requiring our four supported
harnesses, and the filesystem inspector checks Kiro CLI's `agentSpawn`
registration instead of an obsolete separate session-start hook file.
Their regression suites passed **56 + 170 tests**. These code corrections and
the added GitHub CLI dependency are not yet deployed to AgentCore.

An initial network-disabled attempt could not initialize Sigstore verification.
The successful run allowed public verification traffic while retaining
`--offline` release installation, a non-root user, read-only image/inputs,
isolated writable workspaces, and no mounted account credentials.

Evidence and native files are retained under:

- `/tmp/aidlc-plan-tools/native-g1-live-20260923/verification-summary.json`
- `/tmp/aidlc-plan-tools/native-g1-live-20260923/container-output-final/probes/initialization-REhUkr/`
- `/tmp/aidlc-plan-tools/native-g1-live-20260923/container-invocation-final.json`
- `/tmp/aidlc-plan-tools/native-g1-container-20260923/evidence.json`

The local probe image is
`sha256:c48d5f858251826f2a539acb4a95438f6fdc475e4d8b343b44ad7edc102d5183`.
The original failed attempts are retained separately. No AWS deployment was
performed for this experiment.

## Contract and remaining integration

This is the G1 command/evidence contract for all four harnesses. It does not
qualify native question delivery, protected approval, hook trust or recovery.
The user performs deployment after the broker/runtime integration is ready.
D17 now trusts owner/admin-configured sources, with mandatory pins/checksums and
signature verification when available. Missing signatures are permitted by
platform policy. Deployable enforcement and deployment inputs D8 are still
required before exposing a probe through the deployed runtime.

Original source inspection: upstream commit
`c8262851e50252865bb8882b43769a3348c9ec49`, principally
`core/tools/aidlc-release.ts`, `aidlc-lifecycle.ts`, `aidlc-init.ts`,
`aidlc-command.ts`, `aidlc-doctor.ts`, `aidlc-config-diagnostics.ts`,
`aidlc-utility.ts`, and `docs/guide/18-install-and-lifecycle.md`.
The selected v2.9.0 distributed binary passed the local contract above.

## Inputs and isolation

The protected supervisor supplies:

- Exact native version without the leading `v`.
- A verified Linux ARM64 release directory containing the binary, complete
  runtime archive, `version.json`, `checksums.txt`, and original attestation
  when supplied. Explicit absence is preserved; the selected native installer
  must independently support that package layout.
- The package and materialization identities, source commit and binding revision.
- A fresh probe root belonging to the project and immutable package.
- The approved package-trust/signer environment. An input verification report
  saying `attestation: not-verified` is not evidence of a verified signature.

Use sibling machine and project directories:

```text
G1_ROOT/
  machine/
    data/
    bin/
  projects/
    claude/
    kiro/
    opencode/
    codex/
  evidence/
```

Install and bin roots need a writable common parent. Run the machine-level
command from a neutral working directory; project paths must neither contain
nor sit inside machine roots. Start each project as an empty Git repository
with `git init --quiet`. No remote or initial commit is needed for this probe.
Git is required for Codex host hook discovery even though core configuration
itself can accept a directory without a repository.

Set these environment values for the probe subprocesses:

```sh
AIDLC_INSTALL_ROOT="$G1_ROOT/machine/data"
AIDLC_BIN_DIR="$G1_ROOT/machine/bin"
AIDLC_OFFLINE=1
PATH="$AIDLC_BIN_DIR:$PATH"
```

Pass these as process environment entries, not unexported shell variables.
Use `--mcp none` for this isolated initialization probe. Production MCP
configuration remains separate.

`AIDLC_RELEASE_REPOSITORY` and `AIDLC_RELEASE_WORKFLOW` select signer trust.
They are not generic Git-provider download coordinates. Do not turn a
GitLab/Bitbucket source name into a GitHub signer identity. Supply the approved
signer identity when applicable, and record the policy/evidence used.
For verified GitHub packages the implemented probe derives the repository from
the authorized source and the workflow from the verified signer evidence.
Conflicting explicit host values fail before execution. Unsigned GitHub packages
use that source's standard release/preview workflow names without claiming
signature verification. GitLab/Bitbucket coordinates are never converted into
GitHub identities; any applicable signer mapping belongs to their qualified
adapter. Leaving those variables empty still leaves upstream's official
defaults in effect, which is not evidence that a fork's signer was resolved.
Do not point `AIDLC_GH_BIN` at a missing command to bypass verification.
The native `--offline` flag does not itself prove that a provenance subprocess
will make no network requests.

## Implemented host services

`lambda/shared/native-package-intake.js` exposes `loadForExecution` separately
from byte-only `loadPinned`. It reauthorizes project/source access, reverifies
the immutable cache, evaluates the D17 policy using a trusted signature adapter,
and rechecks authorization before returning. Request-supplied trust objects have
no authority. A present proof with no applicable verifier is denied.
Each awaited credential lookup is followed by another source authorization
check, including the final lookup before returning execution access. D18 reuses
existing Neptune membership; it does not add a protected membership store.
The source service checks project/delegator graph identities and the current
connection, while retaining the existing graph-writer risk.

When constructed with `archive`, intake persists a version-pinned manifest
receipt before returning a preparation result. A cold local cache can restore
only that manifest and its exact S3 object versions. Complete filesystem and
trust checks still run before a probe receives executable paths. A damaged
cache is an error rather than a trigger to select another package.
The protected archive worker, resource limits and permissions are deployed in
dev. On 23 September, normal UI/Pipe/SQS import succeeded after the template
correction; exact-version reads verified the retained package. See the
[import checkpoint](native-package-import-checkpoint.md). Execution authority
and initialization in the deployed runtime remain separate integration work.
If the worker died after committing a package but before recording the receipt,
`recoverPreparation` can reconcile that committed package from the original
candidate pin. The job host must persist that candidate before upload;
reconciliation does not rediscover a release or create a missing commit.

`lambda/agentcore/native/initialization-probe.js` requires that protected
`loadForExecution` callback. It creates a fresh installation and four projects,
uses an explicit environment with isolated HOME and temporary files, and records
each command plus filesystem evidence. It never inherits source credentials,
model credentials or the parent process's CLI configuration. Its Linux ARM64
preflight cannot qualify a release by running fixture commands on another host.

`command-runner.js` bounds output and command time, runs without a shell or
interactive stdin, and kills ordinary process-group descendants. If cleanup
cannot be confirmed, the probe stops and its instance rejects later runs.
The host must replace/quarantine that runtime; constructing another probe object
in the same unhealthy runtime is not recovery. Escaped descendants and hostile
same-UID code require container/runtime isolation.

`initialization-evidence.js` checks the actual filesystem using bounded regular
file reads and rejects observed symlinks, unsafe ancestors and changed files.
The supervisor must quiesce writers. These checks establish configuration
evidence, not an authorization boundary or proof that the harness accepted hooks.

The dedicated source configuration API, isolated binding/job tables and private
package bucket are deployed in dev, with protected worker grants. Defaults for
other environments remain off. There is no exposed native start route yet.
Probe deployment still requires execution authorization and broker/runtime
integration, an applicable signature verifier and its runtime dependencies,
and an isolated Linux ARM64 host. The user selected dev for verification.

## Commands

Run installation once in the fresh machine roots:

```sh
"$RELEASE_DIR/aidlc-linux-arm64" use "$VERSION" \
  --from "$RELEASE_DIR" --offline --json

"$AIDLC_BIN_DIR/aidlc" version --json
```

For each of `claude`, `kiro`, `opencode`, and `codex`, use a separate
`PROJECT="$G1_ROOT/projects/$HARNESS"` and execute:

```sh
git init --quiet "$PROJECT"

"$AIDLC_BIN_DIR/aidlc" config --pin "$VERSION" \
  --project-dir "$PROJECT" \
  --from "$RELEASE_DIR" --offline --json

"$AIDLC_BIN_DIR/aidlc" config --harness "$HARNESS" \
  --project-dir "$PROJECT" \
  --from "$AIDLC_INSTALL_ROOT/versions/$VERSION/runtime/$HARNESS" \
  --mcp none --yes --json

"$AIDLC_BIN_DIR/aidlc" doctor \
  --project-dir "$PROJECT" --offline --json
```

These are distinct operations: pinning records the executable/version;
configuration projects one installed harness distribution. A project pin does
not prove that harness files were installed.

Stop dependent operations on a failed install, pin or configuration command.
Retain each harness's doctor result and continue with the other independent
projects. Capture stdout, stderr, exit status, command identity and elapsed
time under the probe's protected evidence directory. Do not invoke an agent
workflow or manufacture a human approval to make initialization appear complete.
The default command deadline is two minutes; the complete command/inspection
sequence has a twenty-minute budget. These are bounded probe defaults, not the
pilot's still-undecided turn/token/concurrency/retention policy. Failed evidence
is retained for protected inspection; no automatic retention policy is enabled.

Compatibility details checked in the inspected source:

- `use` takes the version before its flags and does not accept `--yes`.
- `config --pin` cannot be combined with `--harness`, `--mcp` or `--plan-token`.
- Ordinary harness configuration does not accept `--offline`; its explicit
  installed-distribution path supplies the files locally.
- `use` and `config` reject combining `--quiet` with `--json`.
- `version` supports JSON output, not quiet.
- Do not add `doctor --check-updates` or `--export` to G1.

## Required evidence

For `use` and `config`, require process exit zero and JSON with
`schemaVersion: 1`, `ok: true`, and `code: 0`. Also verify:

- Installation reports the selected version.
- Pinning reports that version, `pinned: true`, and the canonical project path.
- Configuration reports the expected distribution, version, project path and
  no conflicts. Preserve outstanding actions; they are not automatically
  satisfied by configuration success.

`version --json` has a different response: `schemaVersion`, `binaryVersion`,
and `runtimeVersion`, without `ok`/`code`. Check both versions, but do not use
embedded version constants as proof of runtime-file integrity.

Doctor supplies individual checks and passed/warning/failed counts. Warnings
can accompany exit zero; failed checks produce exit one, and invalid update
configuration can produce exit two. Store and inspect every finding.

For each project, verify:

- `.aidlc-version` contains the selected version.
- `aidlc/.aidlc-sessions/pin-target` names the installed executable.
- Machine `pins.json` registers the canonical project path.
- The harness engine's `tools/data/` contains `aidlc-stamp.json`,
  `aidlc-projection.json`, `aidlc-manifest.json`, and `harness.json` with
  appropriate version/distribution identity.
- `aidlc/spaces/default/memory/` exists.

| Harness  | Engine directory | Representative additional files                                                 |
| -------- | ---------------- | ------------------------------------------------------------------------------- |
| Claude   | `.claude`        | `settings.json`, `skills/aidlc/SKILL.md`                                        |
| Kiro     | `.kiro`          | `agents/aidlc.json`, hooks, root `AGENTS.md`                                    |
| OpenCode | `.aidlc`         | `.opencode/plugin/aidlc-opencode-adapter.ts`, root `opencode.json`              |
| Codex    | `.codex`         | `hooks.json`, `config.toml`, `trust-seed.toml`, `.agents/skills/aidlc/SKILL.md` |

Configuration does not create a workflow intent. Do not require intent-state
or audit files at this boundary. Doctor's harness availability/version probes
also do not establish that the host accepted its native hooks, configured its
model provider, or can safely resume a protected human wait. Those are later
P4/G2/G3 checks.
