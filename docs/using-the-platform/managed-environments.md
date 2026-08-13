# Managed tools and environments

Platform administrators control the software available inside intent runtimes.
The platform ships one protected **Standard** environment and a catalog of tool
definitions. Administrators publish exact tool versions, then compose those
versions into environments that project owners can assign.

Standard provides the protected AgentCore runtime plus Node.js and Python. Java,
Go, Rust, Maven, and Gradle are shipped as tool definitions, not as predefined
environments. This keeps project environments explicit and avoids maintaining
separate JVM, Go, Rust, and Polyglot images.

## Publish a shipped tool

Open **Admin → Environments → Tools**. Each shipped tool begins with an exact
ARM64 version and official source URL.

1. Select a tool and start its build.
2. Follow the CodeBuild log while the platform imports the source and creates an
   immutable OCI artifact.
3. Review source provenance, SBOM, image size, vulnerability findings, and
   functional verification.
4. Accept Critical or High findings only when the risk is understood. The
   findings and acceptance identity remain attached to the version.
5. Publish the version.
6. Optionally mark one published version as **Recommended**.

Multiple versions can remain published. Recommended is an explicit
administrator choice; publishing a newer version does not move existing
environments or automatically make it recommended.

## Source provenance

Normal tool creation asks for an exact version and a public HTTPS archive URL.
The platform follows validated public redirects, downloads the source once,
computes its SHA-256 digest, and stores a content-addressed copy in the private
build-context bucket.

The catalog displays one of two trust levels:

- **Publisher verified** means an administrator supplied a publisher checksum
  and public evidence URL, and the platform independently fetched and matched
  that evidence.
- **Platform pinned** means the platform computed and retained the imported
  source digest. The artifact is immutable after import, but no independent
  publisher checksum was supplied.

Publisher URLs, resolved URLs, source digests, OCI digests, sizes, scan
findings, verification evidence, and build logs remain visible on the tool
version.

## Add a new tool

Open **Admin → Environments → Tools**, select **Add Tool**, and provide:

- A stable tool name and identifier.
- Its publisher and category.
- An exact version.
- A public HTTPS ARM64 archive.
- A verification preset.

Presets are available for Java, Go, Rust, Maven, Gradle, .NET, and generic CLI
tools. They prefill executable paths, version checks, dependencies, environment
variables, and representative builds. Most tools need no custom installer or
verification script.

For a .NET SDK:

1. Create a tool with an identifier such as `dotnet-sdk`.
2. Enter the exact SDK version and official Linux ARM64 archive URL.
3. Select the **.NET** preset.
4. Build, review, publish, and optionally recommend the version.
5. Create an environment based on Standard and include the published .NET
   version.

The .NET preset exposes `dotnet`, sets `DOTNET_ROOT`, verifies the exact version,
and builds and runs a minimal console project.

### Advanced installation

Portable `.tar.gz`, `.tar.xz`, and `.zip` archives use generated extraction.
For vendor layouts that need additional installation logic, an administrator
can provide a Bash installer. It receives:

- `TOOL_SOURCE`: a read-only retained source archive.
- `TOOL_OUTPUT`: the writable normalized tool directory.

The installer runs in a nested container with no AWS credentials, metadata
access, Docker socket, host mounts, or private-network access. It has bounded
CPU, memory, processes, and output size. Public internet access is available,
so a custom installer can download additional content; in that case the
published OCI digest is immutable and verified, but rerunning the installer is
not guaranteed to reproduce identical output.

Custom functional verification is networkless. Administrators may add bounded
fixture files and a Bash verifier. Verification runs as the non-root runtime
user with isolated writable caches.

## Compose an environment

Open **Admin → Environments → Environments** and create an environment:

1. Select a published base environment.
2. Select exact published tool versions.
3. Add exact apt packages, non-secret variables, or restricted build commands
   when needed.
4. Review automatically added dependencies and the projected compressed image
   size.
5. Build the environment.
6. Review the generated Dockerfile, SBOM, scan findings, runtime validation,
   and representative tool builds.
7. Publish the environment.

Maven and Gradle automatically include the recommended Java version. The API
rejects missing or cyclic dependencies, conflicting binaries, conflicting apt
versions, and conflicting environment variables.

Every environment revision snapshots exact tool-version records and OCI
digests. A new recommended tool version marks affected environments with an
update warning, but existing revisions and active intents stay pinned until an
administrator explicitly edits, builds, and publishes a replacement.

## Assign an environment

Project owners select a published environment in **Project Settings →
Environment**. New intents snapshot the exact environment revision, image
digest, runtime version, endpoint, compatibility version, tool definitions, and
verification result. Existing intents continue using their original snapshot.

Projects without an explicit assignment use Standard.

## Remove legacy environments

Installations that previously created predefined or custom schema-v1
environments show those records as read-only. Open **Admin → Environments →
Reset** to inspect the destructive migration before running it.

The reset:

- Reassigns projects using non-Standard environments to Standard.
- Cancels active intents using those environments and stops their sessions.
- Deletes their AgentCore endpoints and runtimes.
- Deletes managed-environment images and registry records.
- Preserves intent audit snapshots, but not the deleted runtime artifacts.

The UI requires the exact confirmation text and starts cleanup asynchronously.
Progress and final counts remain visible. A completed reset is idempotent and
cannot run twice accidentally.
