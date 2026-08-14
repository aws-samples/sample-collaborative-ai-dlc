# Managed tools and environments

Platform administrators control the software available inside intent runtimes.
The platform ships one protected **Standard** environment and a catalog of tool
definitions. Administrators publish exact tool versions, compose those versions
into environments, and publish environment revisions that project owners can
assign.

Standard provides the protected AgentCore runtime plus Node.js and Python.
Java, Go, Rust, Maven, and Gradle are shipped as tool definitions, not as
predefined JVM, Go, Rust, or Polyglot environments. Administrators can add other
tools, such as a .NET SDK, without changing the application source.

## Access and responsibilities

The managed build views are under **Admin -> Environments** and require the
`platform-admin` role:

- **Tools** imports, builds, verifies, publishes, and recommends tool versions.
- **Environments** composes published tool versions into runtime images.

Project Owners and Admins select a published environment under **Project
Settings -> Environment**. Project Members can see the assignment but cannot
change it.

## The object model

| Object                   | Meaning                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Standard**             | The protected AgentCore base, Node.js, Python, runtime files, user, entrypoint, port, and health behavior.                                       |
| **Tool family**          | A stable capability such as `java`, `go`, `rust`, `maven`, `gradle`, or `dotnet-sdk`.                                                            |
| **Tool version**         | An immutable, verified ARM64 tool artifact for one exact version.                                                                                |
| **Environment**          | A named toolchain based on one published environment.                                                                                            |
| **Environment revision** | An immutable image recipe and runtime created from exact tool-version and base-revision snapshots.                                               |
| **Project assignment**   | The environment whose current published revision will be used by new intents.                                                                    |
| **Intent snapshot**      | The exact environment revision, image digest, runtime target, compatibility version, and verification result captured when an intent is created. |

The important invariants are:

- Only published tool versions can be added to an environment.
- Only a `READY` tool version or environment revision can be published.
- Published tool versions and environment revisions are immutable.
- Publishing or recommending a tool version never rewrites an existing
  environment revision.
- Publishing a new environment revision affects new intents for assigned
  projects. Existing intents stay pinned to their original runtime target.

## Shipped tool definitions

The catalog bootstrap creates these tool families and initial version
definitions:

| Tool           | Initial version | Dependency       |
| -------------- | --------------- | ---------------- |
| Java JDK       | `21.0.8`        | None             |
| Go SDK         | `1.24.6`        | None             |
| Rust Toolchain | `1.89.0`        | None             |
| Apache Maven   | `3.9.11`        | Recommended Java |
| Gradle         | `9.0.0`         | Recommended Java |

The scheduled bootstrap queues independent initial versions for import. Maven
and Gradle remain drafts until Java has a published recommended version because
their own functional checks require Java.

These are catalog entries only. They do not create project-selectable
environments by themselves.

## Tool-version lifecycle

The version selector in **Tools** shows every version and its status:

| Status            | Meaning                                                                        | Available action                                 |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `DRAFT`           | Definition is editable and no build is active.                                 | **Edit** or **Build**                            |
| `QUEUED`          | CodeBuild has been requested.                                                  | Wait or refresh                                  |
| `BUILDING`        | Source import, installation, normalization, and functional checks are running. | Open **Build logs**                              |
| `SCANNING`        | The immutable OCI artifact exists and ECR scan results are being evaluated.    | Wait or refresh                                  |
| `SECURITY_REVIEW` | Critical or High findings require an explicit administrator decision.          | **Accept Findings**                              |
| `READY`           | Source, artifact, scan decision, and verification evidence are complete.       | **Publish**                                      |
| `PUBLISHED`       | The immutable version can be selected by environments.                         | **Recommend** when it is not already recommended |
| `FAILED`          | Import, installation, scan processing, or verification failed.                 | Inspect evidence, **Edit**, or **Retry**         |

Refreshing the browser is not required while a build is active; the view polls
the version until it reaches a reviewable or terminal status.

## Add a new tool

### Prepare the source

Before opening the form, identify:

- An exact version.
- An official Linux ARM64 archive URL.
- The executable paths inside the installed tool.
- A command that prints the version and a stable expected substring.
- A representative functional check.
- Any exact Debian package prerequisites.
- Any dependency on another tool family.
- An optional publisher checksum and public checksum-evidence URL.

The normal import path accepts public HTTPS archives ending in:

- `.tar.gz`
- `.tgz`
- `.tar.xz`
- `.zip`

The source URL must not contain credentials, query parameters, fragments, or
embedded secrets. The platform rejects private, local, link-local, and
metadata-service destinations. The source download is bounded, redirects are
revalidated, and the archive is checked for traversal paths, unsafe links,
special files, excessive entry counts, and excessive expanded size.

Source uploads are not supported. Tool definitions import from public HTTPS
URLs so the retained source has an auditable publisher location.

Current import limits are:

| Limit                             | Maximum    |
| --------------------------------- | ---------- |
| Source archive download           | `1024 MiB` |
| Archive entries                   | `200,000`  |
| Expanded archive content          | `4096 MiB` |
| Normalized tool output            | `1536 MiB` |
| Final AgentCore environment image | `2048 MiB` |

### Create the family and first version

1. Open **Admin -> Environments -> Tools**.
2. Choose **Add Tool**.
3. Enter a human-readable **Name**, for example `.NET SDK`.
4. Enter or accept the stable lowercase **ID**, for example `dotnet-sdk`.
5. Enter the **Publisher**, **Category**, and **Description**.
6. Enter the **Exact version**.
7. Select a **Verification** preset.
8. Enter the **Official ARM64 archive** URL.
9. Review the generated installation and verification defaults.
10. Choose **Create and Build**.

Creating the family and creating its first version happen together. A tool
family can later contain multiple published versions.

The tool ID is a durable catalog key. Do not include the version in it. Use
`dotnet-sdk`, not `dotnet-sdk-8`. The version belongs to the tool-version
record.

### Choose a verification preset

Presets fill in executable paths, environment variables, dependencies, the
version command, and a representative build:

| Preset          | Functional verification                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| **Java**        | Runs `java -version`, compiles a class with `javac`, and runs it.                                      |
| **Go**          | Runs `go version`, builds a small Go program, and runs it.                                             |
| **Rust**        | Runs `rustc --version`, creates a Cargo project, builds it, and runs it.                               |
| **Maven**       | Runs `mvn --version` and validates a minimal project offline. Adds Java as a dependency.               |
| **Gradle**      | Runs `gradle --version` and executes a minimal task offline. Adds Java as a dependency.                |
| **.NET**        | Runs `dotnet --version`, creates a console project, builds it, and runs it.                            |
| **Generic CLI** | Runs the configured version command. Add a custom verifier when a version check alone is insufficient. |

Selecting a preset is a starting point, not a bypass. Review the generated
executable paths and expected version before building.

### Publisher checksum and source trust

The publisher checksum section is optional. Supply both:

- A SHA-256 or SHA-512 digest published by the vendor.
- A public evidence URL from which the platform can independently find that
  digest.

The catalog displays:

- **Publisher verified** when the downloaded archive matches the supplied
  publisher digest and the digest is also found at the independently fetched
  evidence URL.
- **Platform pinned** when the platform computed and retained its own SHA-256
  digest but no independently verified publisher evidence was supplied.

Both trust levels pin the imported source and resulting OCI artifact by digest.
Publisher verified adds independent evidence about who published the source.

The first successful source import is retained under its digest. Retrying an
installer or verifier correction reuses that retained source instead of
silently downloading a new archive.

### Generated archive installation

Use generated installation whenever the archive already contains the desired
tool layout.

Set **Root folders to remove** to the number of wrapper directories that should
be removed during extraction. For example, an archive containing
`tool-1.2.3/bin/tool` needs one root folder removed when `bin/tool` should be
at the normalized tool root.

Generated installation extracts the verified archive without executing
publisher-supplied installation code.

### Custom installation

Enable the custom installer only when extraction is insufficient. The Bash
script receives:

- `TOOL_SOURCE`: the read-only retained source archive.
- `TOOL_OUTPUT`: the writable directory that must contain the normalized tool.
- `TOOL_ARCHIVE_FORMAT`: the detected source format.

The installer runs inside a nested container with:

- No AWS credentials.
- No EC2 or ECS metadata access.
- No Docker socket.
- No host mounts other than the retained source and output directory.
- No access to private or link-local networks.
- Bounded CPU, memory, process count, temporary storage, and output size.

Public internet access is available to the installer. If the script downloads
additional mutable content, the published OCI digest remains immutable and
verified, but rerunning the script is not guaranteed to produce the same
artifact. Prefer the retained source archive and exact checksums whenever
possible.

Do not put credentials or secrets in installer scripts. The API rejects common
secret patterns, and definitions are visible to platform administrators.

### Executables and dependencies

Under **Executables, dependencies, and custom verification**:

- List each executable as `name=relative/path`, for example
  `dotnet=dotnet` or `java=bin/java`.
- Select another tool family when this tool cannot be verified or used without
  it.
- Add required Debian packages as `package=exact-version`.
- Add non-secret variables as `NAME=value`.
- Use `${TOOL_ROOT}` when a variable should point at the normalized tool root.

A dependency resolves to that family's published recommended version. A
dependent version cannot build until every dependency has a published
recommended version. The platform rejects missing families, self-dependencies,
dependency cycles, executable collisions, package-version conflicts, and
environment-variable conflicts.

### Custom verification

Every version requires a version command and expected output. Use the optional
networkless verifier for additional behavior that the selected preset does not
cover.

The verifier:

- Runs as the non-root runtime user.
- Has no network access.
- Uses isolated writable caches for SDKs and build tools.
- Can read up to 32 text fixture files supplied in the form.
- Receives fixture files read-only.
- Must complete within the build's resource and time limits.

Use fixture files for a minimal real project, configuration file, or expected
output. Do not include credentials or production data.

### Example: add a .NET SDK

1. Choose **Add Tool**.
2. Set **Name** to `.NET SDK` and **ID** to `dotnet-sdk`.
3. Set **Publisher** to `Microsoft` and **Category** to `Language SDK`.
4. Enter the exact SDK version.
5. Select the **.NET** preset.
6. Enter Microsoft's official Linux ARM64 SDK archive URL.
7. Add publisher checksum evidence when available.
8. Confirm the preset exposes `dotnet`, sets
   `DOTNET_ROOT=${TOOL_ROOT}`, and expects the exact SDK version.
9. Choose **Create and Build**.
10. Review the source, OCI artifact, scan, and console-project verification.
11. Publish the version.
12. Recommend it if it should be the default .NET SDK for new environment
    drafts.

This adds .NET as a selectable tool. It does not create or publish a .NET
environment automatically.

## What a tool build verifies

A successful CodeBuild job is only one part of the tool decision. The catalog
records evidence for:

1. **Source import**: validated public URL, resolved redirects, source size,
   platform SHA-256, and optional publisher evidence.
2. **Archive safety**: bounded entry count and expanded size, safe relative
   paths, safe links, and no special files.
3. **Installation**: generated extraction or sandboxed installer output.
4. **Artifact normalization**: executable paths exist, symlinks remain inside
   the tool root, and output stays within the tool-artifact size limit.
5. **OCI publication**: an immutable ARM64 tool image and digest.
6. **SBOM**: an SPDX document generated from the normalized payload.
7. **Security scan**: ECR findings with severity, advisory, package, and
   package version where available.
8. **Runtime compatibility**: the protected core digest and compatibility
   version used for verification.
9. **Version check**: the configured command contains the exact expected
   output.
10. **Functional check**: the selected preset and optional custom verifier run
    as the non-root runtime user.

The Tools view retains the source digest, trust level, official source link,
artifact digest, compressed size, runtime contract, findings, acceptance
identity, failure detail, and CodeBuild logs.

## Review failures and security findings

### Build or verification failure

For a `FAILED` version:

1. Open **Build logs** and read the failure detail shown in the version.
2. Choose **Edit** when the archive layout, executable path, installer,
   package, variable, version command, or verifier is wrong.
3. Choose **Save and Build** to store the corrected definition and queue a new
   build.
4. Choose **Retry** only when the definition is already correct and the failure
   was transient.

The exact version string cannot be changed while editing. Create a new version
when the version number changes.

### Security review

Critical or High ECR findings move the version to `SECURITY_REVIEW`; they do
not erase a successful artifact build.

The administrator can:

- Leave the version unpublished and remediate its source or dependencies.
- Choose **Accept Findings** to record the identity and timestamp and move the
  version to `READY`.

Acceptance does not publish the version. The findings and acceptance record
remain visible after publication and in every environment revision that
snapshots that tool version.

## Publish and recommend tools

Publishing and recommending are separate decisions:

| Action        | Effect                                                                                |
| ------------- | ------------------------------------------------------------------------------------- |
| **Publish**   | Makes one exact immutable version available for explicit environment selection.       |
| **Recommend** | Makes one published version the default for new selections and dependency resolution. |

Multiple versions of the same tool can remain published. Only one version is
recommended.

Publishing a newer version does not automatically recommend it. Recommending a
new version:

- Changes the version selected when an administrator first enables that tool
  in an environment editor.
- Changes the dependency version automatically selected for tools such as
  Maven or Gradle.
- Marks affected environments with a tool-update warning.
- Does not change an existing environment revision.
- Does not change an active or completed intent.

For shipped tools, publish and recommend Java before building Maven or Gradle.

## Add or update a tool version

To add a newer version:

1. Open the tool family in **Admin -> Environments -> Tools**.
2. Choose **Add Version**.
3. Enter the new exact version, official ARM64 archive, and verification
   definition.
4. Choose **Create and Build**.
5. Review the complete evidence.
6. Publish the version.
7. Choose **Recommend** only when the new version should become the default.

The prior published version remains selectable. Environments pinned to it
remain valid.

To correct an unpublished version, use **Edit** while its status is `DRAFT` or
`FAILED`. Published versions cannot be edited; create another version instead.

## Select a specific Java, Go, Rust, or other tool version

Tool versions are selected on an environment revision, not globally:

1. Publish every exact version that administrators should be able to use.
2. Open **Admin -> Environments -> Environments**.
3. Create an environment or open an existing environment.
4. Enable the tool when it is not inherited from the base.
5. Select the exact published version from the version control.
6. Choose **Create Draft** or **Save as New Revision**.
7. Build, review, and publish that environment revision.

When a tool has only one published version, the editor shows its version badge
and an include switch; there is no redundant version selector. A selector
appears when:

- More than one published version is available.
- The base already includes the tool and a published version can override the
  inherited version.

The recommended version is preselected when a tool is enabled. It is a default,
not a restriction. Any published version shown by the selector can be chosen.

## Create an environment

Open **Admin -> Environments -> Environments** and choose **New Environment**.

1. Enter a stable environment ID, name, and description.
2. Select a published **Base environment**. Use Standard unless the new
   environment intentionally extends another published custom environment.
3. Review the protected Node.js and Python versions and any tools inherited
   from the base.
4. Enable catalog tools. The initial toggle selects the recommended published
   version.
5. Use the version selector when multiple published versions exist or when
   overriding a tool inherited from the base.
6. Review dependencies marked **Required**. They are added at their recommended
   published versions.
7. Add exact apt packages, non-secret environment variables, or restricted
   single-line build commands only when the catalog tools do not cover the
   need.
8. Review the projected compressed size. AgentCore runtime images must remain
   at or below `2048 MiB`.
9. Choose **Create Draft**.
10. Select the draft revision and choose **Build**.

Environment variables and build commands cannot replace protected runtime
behavior, inject secrets, change the runtime user, entrypoint, command, port,
or health contract, or overwrite protected platform variables.

## What an environment build verifies

The generated Dockerfile:

- Starts from the exact pinned base revision and digest.
- Copies each selected tool from its exact OCI digest.
- Installs exact apt package versions.
- Applies non-secret variables and restricted build commands.
- Restores the protected non-root runtime user.
- Retains the platform-owned runtime files, entrypoint, command, port, and
  health behavior.

The build then checks:

- ARM64 architecture and the pinned base digest.
- Protected runtime files against the base.
- Non-root execution and writable workspace behavior.
- The generated SPDX SBOM.
- Tool version commands and representative builds.
- Container startup, `/ping`, shutdown, and runtime invariants.
- Final image size.
- ECR vulnerability findings.
- AgentCore runtime and endpoint creation.
- Capability and deterministic command checks through the created endpoint.

The revision reaches `READY` only after image validation, the security decision,
and AgentCore runtime validation succeed.

## Environment-revision lifecycle

| Status            | Meaning                                                          | Available action                                |
| ----------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| `DRAFT`           | Editable recipe snapshot, not yet built.                         | **Build**                                       |
| `QUEUED`          | CodeBuild has been requested.                                    | Wait or refresh                                 |
| `BUILDING`        | The composed image and local checks are running.                 | Open **Build logs**                             |
| `SCANNING`        | ECR scan results are being evaluated.                            | Wait or refresh                                 |
| `SECURITY_REVIEW` | Critical or High findings require a recorded decision.           | **Accept Findings & Continue**                  |
| `VERIFYING`       | AgentCore runtime and endpoint validation are running.           | Wait or refresh                                 |
| `READY`           | All required checks passed or findings were explicitly accepted. | **Publish**                                     |
| `PUBLISHED`       | This is, or was, a published immutable revision.                 | Create another revision for changes             |
| `SUPERSEDED`      | A newer revision is now published.                               | Existing intent snapshots remain valid          |
| `FAILED`          | Image build, scan processing, or runtime validation failed.      | Inspect evidence and **Retry** when appropriate |
| `RETIRED`         | The environment no longer accepts changes or new assignments.    | No restore action is currently available        |

The evidence view separates image-build success, security findings, and runtime
validation. A successful image can therefore remain visible even when it is
waiting for security review or later runtime validation fails.

## Publish an environment

Select a `READY` revision and choose **Publish**.

Publication atomically moves the environment's published-revision pointer. The
previous published revision becomes superseded but remains retained while
active intent snapshots reference its runtime artifacts.

After publication:

- The environment appears in **Project Settings -> Environment**.
- New intents in projects already assigned to that environment use the newly
  published revision.
- Existing intents continue using their snapshotted revision and endpoint.
- Draft, failed, and ready revisions do not affect project execution until one
  is published.

## Update an environment

Environment revisions are immutable. Every change creates another draft
revision.

### Use a newer tool version

1. Publish the new tool version.
2. Recommend it when it should become the default. Affected environments show
   a recommended-tool update warning.
3. Open the environment.
4. Select the desired exact version in the catalog-tool list.
5. Choose **Save as New Revision**.
6. Build, review, and publish the new revision.

The warning is informational. No revision changes until the administrator
selects versions and saves a new revision.

### Use a newer base revision

When the published base changes, dependent environments show an update
warning. Choose **Rebuild on Latest Base** to clone the current recipe and
change only its pinned base revision.

The rebuilt revision still requires image validation, security review when
applicable, runtime validation, and manual publication.

When both base and tool updates are available, edit the environment and use
**Save as New Revision** so the exact tool selections are explicit.

### Retry a failed revision

Use **Retry** only when the same recipe and pinned base are still valid. If a
newer base is required or the pinned digest is unavailable, use **Rebuild on
Latest Base** instead.

A failed attempt never replaces the currently published revision and never
changes project assignments.

## Select an environment for a project

1. Open the project.
2. Open **Project Settings -> Environment**.
3. Select a published environment.
4. Review its included tools, exact published revision, image digest, and
   runtime compatibility version.
5. Review repository compatibility warnings.
6. Choose **Assign Environment**.

Compatibility warnings compare detected repository stacks with the tools in
the selected environment. They are advisory; assignment is still allowed.

Projects without an explicit assignment use Standard.

The assignment stores the environment ID, not a mutable container reference.
When an intent is created, the platform resolves that environment's current
published revision and snapshots:

- Environment ID and name.
- Revision ID.
- Image digest.
- AgentCore runtime ARN and version.
- Runtime endpoint.
- Runtime compatibility version.
- Verification result.

Changing the project assignment affects only intents created afterward.
Running, waiting, rewound, cancelled, and resumed intents continue to target
their original snapshotted runtime and endpoint.

Choose the environment before creating the intent that should use it.

## Audit an intent's environment

Intent details and audit output show the immutable environment snapshot used by
the run. Use those values when diagnosing a difference between two runs:

- A project may have been reassigned after the older intent was created.
- A newer revision may have been published for the same environment ID.
- A tool recommendation may have changed without that tool version being
  incorporated into the published environment.

The project setting describes what the next intent will use. The intent
snapshot describes what that specific intent actually uses.
