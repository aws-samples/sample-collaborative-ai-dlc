import { createHash } from 'node:crypto';

export const TOOL_SCHEMA_VERSION = 1;
export const TOOL_VERSION_STATUSES = [
  'DRAFT',
  'QUEUED',
  'BUILDING',
  'SCANNING',
  'SECURITY_REVIEW',
  'READY',
  'PUBLISHED',
  'FAILED',
];

const TOOL_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const VERSION_PATTERN = /^[0-9][0-9A-Za-z.+:~_-]*$/;
const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;
const VARIABLE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const EXECUTABLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._+/-]+$/;
const FIXTURE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const SECRET_VALUE =
  /(-----BEGIN [A-Z ]+PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,})/;
const SECRET_NAME = /(secret|password|passwd|token|credential|private[_-]?key|api[_-]?key)/i;
const PROTECTED_VARIABLE_NAME =
  /^(AWS_|AIDLC_|AGENTCORE_|BEDROCK_|V2_|MCP_|CREDENTIAL_BROKER_|SOURCE_CONTROL_|CLAUDE_|KIRO_|OPENCODE_|CODEX_|XDG_|LD_|PATH$|HOME$|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|SHELLOPTS$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|RUNTIME_COMPATIBILITY_VERSION$)/;

const exactChecksum = (value, evidenceUrl, algorithm = 'sha256') => ({
  algorithm,
  value,
  evidenceUrl,
});

const presetVersionCommand = (preset, version) => {
  const commands = {
    java: { argv: ['java', '-version'], expected: version },
    go: { argv: ['go', 'version'], expected: `go${version}` },
    rust: { argv: ['rustc', '--version'], expected: version },
    maven: { argv: ['mvn', '--version'], expected: version },
    gradle: { argv: ['gradle', '--version'], expected: version },
    dotnet: { argv: ['dotnet', '--version'], expected: version },
    generic: { argv: ['tool', '--version'], expected: version },
  };
  return commands[preset] ?? commands.generic;
};

const archiveVersion = ({
  version,
  url,
  checksum,
  checksumAlgorithm = 'sha256',
  checksumEvidenceUrl,
  preset,
  stripComponents = 1,
  executables,
  dependencies = [],
  aptPackages = [],
  environmentVariables = {},
  installerScript = null,
}) => ({
  schemaVersion: TOOL_SCHEMA_VERSION,
  version,
  source: {
    type: 'https',
    url,
    expectedChecksum: exactChecksum(checksum, checksumEvidenceUrl, checksumAlgorithm),
  },
  installer: installerScript
    ? { mode: 'script', script: installerScript }
    : { mode: 'generated', stripComponents },
  executables,
  dependencies,
  aptPackages,
  environmentVariables,
  verification: {
    preset,
    versionCommand: presetVersionCommand(preset, version),
    script: '',
    files: [],
  },
});

const RUST_INSTALLER = `#!/usr/bin/env bash
set -Eeuo pipefail
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
tar -xzf "$TOOL_SOURCE" -C "$staging"
installer="$(find "$staging" -mindepth 2 -maxdepth 2 -name install.sh -type f -print -quit)"
test -n "$installer"
"$installer" --prefix="$TOOL_OUTPUT" --disable-ldconfig
`;

export const SYSTEM_TOOL_TEMPLATES = [
  {
    toolId: 'java',
    name: 'Java JDK',
    description: 'Eclipse Temurin JDK for ARM64 Linux builds.',
    category: 'language-sdk',
    publisher: 'Eclipse Temurin',
    version: archiveVersion({
      version: '21.0.8',
      url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.8%2B9/OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.8_9.tar.gz',
      checksum: 'e5c41a1ab0865ea5de9b4529bf8526005f1d4593090845387d14fe450ce39c33',
      checksumEvidenceUrl:
        'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.8%2B9/OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.8_9.tar.gz.sha256.txt',
      preset: 'java',
      executables: [
        { name: 'java', path: 'bin/java' },
        { name: 'javac', path: 'bin/javac' },
        { name: 'jar', path: 'bin/jar' },
      ],
      environmentVariables: { JAVA_HOME: '${TOOL_ROOT}' },
    }),
  },
  {
    toolId: 'go',
    name: 'Go SDK',
    description: 'The official Go ARM64 Linux toolchain.',
    category: 'language-sdk',
    publisher: 'The Go project',
    version: archiveVersion({
      version: '1.24.6',
      url: 'https://go.dev/dl/go1.24.6.linux-arm64.tar.gz',
      checksum: '124ea6033a8bf98aa9fbab53e58d134905262d45a022af3a90b73320f3c3afd5',
      checksumEvidenceUrl: 'https://go.dev/dl/',
      preset: 'go',
      executables: [
        { name: 'go', path: 'bin/go' },
        { name: 'gofmt', path: 'bin/gofmt' },
      ],
      environmentVariables: { GOROOT: '${TOOL_ROOT}' },
    }),
  },
  {
    toolId: 'rust',
    name: 'Rust Toolchain',
    description: 'The official Rust ARM64 Linux compiler and Cargo.',
    category: 'language-sdk',
    publisher: 'The Rust project',
    version: archiveVersion({
      version: '1.89.0',
      url: 'https://static.rust-lang.org/dist/rust-1.89.0-aarch64-unknown-linux-gnu.tar.gz',
      checksum: '26d6de84ac59da702aa8c2f903e3c344e3259da02e02ce92ad1c735916b29a4a',
      checksumEvidenceUrl:
        'https://static.rust-lang.org/dist/rust-1.89.0-aarch64-unknown-linux-gnu.tar.gz.sha256',
      preset: 'rust',
      executables: [
        { name: 'rustc', path: 'bin/rustc' },
        { name: 'cargo', path: 'bin/cargo' },
        { name: 'rustfmt', path: 'bin/rustfmt' },
      ],
      aptPackages: [{ name: 'build-essential', version: '12.9' }],
      installerScript: RUST_INSTALLER,
    }),
  },
  {
    toolId: 'maven',
    name: 'Apache Maven',
    description: 'Apache Maven for JVM builds.',
    category: 'build-tool',
    publisher: 'Apache Software Foundation',
    version: archiveVersion({
      version: '3.9.11',
      url: 'https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.tar.gz',
      checksum:
        'bcfe4fe305c962ace56ac7b5fc7a08b87d5abd8b7e89027ab251069faebee516b0ded8961445d6d91ec1985dfe30f8153268843c89aa392733d1a3ec956c9978',
      checksumAlgorithm: 'sha512',
      checksumEvidenceUrl:
        'https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.tar.gz.sha512',
      preset: 'maven',
      executables: [{ name: 'mvn', path: 'bin/mvn' }],
      dependencies: ['java'],
    }),
  },
  {
    toolId: 'gradle',
    name: 'Gradle',
    description: 'Gradle for JVM builds.',
    category: 'build-tool',
    publisher: 'Gradle',
    version: archiveVersion({
      version: '9.0.0',
      url: 'https://services.gradle.org/distributions/gradle-9.0.0-bin.zip',
      checksum: '8fad3d78296ca518113f3d29016617c7f9367dc005f932bd9d93bf45ba46072b',
      checksumEvidenceUrl: 'https://services.gradle.org/distributions/gradle-9.0.0-bin.zip.sha256',
      preset: 'gradle',
      executables: [{ name: 'gradle', path: 'bin/gradle' }],
      dependencies: ['java'],
    }),
  },
];

const issue = (path, message) => ({ path, message });

export const normalizeToolId = (value) => {
  const collapsed = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const withoutLeading = collapsed.startsWith('-') ? collapsed.slice(1) : collapsed;
  const withoutBoundaries = withoutLeading.endsWith('-')
    ? withoutLeading.slice(0, -1)
    : withoutLeading;
  const id = withoutBoundaries.slice(0, 63);
  if (!TOOL_ID_PATTERN.test(id)) {
    throw Object.assign(new Error('Tool id must contain lowercase letters and digits'), {
      statusCode: 400,
    });
  }
  return id;
};

const validatePublicHttpsUrl = (value, path, issues, { allowQuery = false } = {}) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    issues.push(issue(path, 'URL must be valid'));
    return;
  }
  if (parsed.protocol !== 'https:') issues.push(issue(path, 'URL must use HTTPS'));
  if (parsed.username || parsed.password || parsed.hash || (!allowQuery && parsed.search)) {
    issues.push(issue(path, 'URL must not contain credentials, fragments, or query data'));
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '169.254.169.254' ||
    host === '169.254.170.2'
  ) {
    issues.push(issue(path, 'URL host must be public'));
  }
};

const validatePackages = (packages, path, issues) => {
  if (!Array.isArray(packages)) {
    issues.push(issue(path, 'packages must be an array'));
    return;
  }
  for (const [index, pkg] of packages.entries()) {
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
      issues.push(issue(`${path}.${index}`, 'package must be an object'));
      continue;
    }
    if (!PACKAGE_PATTERN.test(pkg.name ?? '')) {
      issues.push(issue(`${path}.${index}.name`, 'package name is invalid'));
    }
    if (!VERSION_PATTERN.test(pkg.version ?? '')) {
      issues.push(issue(`${path}.${index}.version`, 'package version must be exact'));
    }
  }
};

const validateVariables = (variables, path, issues) => {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    issues.push(issue(path, 'variables must be an object'));
    return;
  }
  for (const [name, value] of Object.entries(variables)) {
    if (!VARIABLE_PATTERN.test(name)) issues.push(issue(`${path}.${name}`, 'name is invalid'));
    if (SECRET_NAME.test(name))
      issues.push(issue(`${path}.${name}`, 'secret-like names are blocked'));
    if (PROTECTED_VARIABLE_NAME.test(name)) {
      issues.push(issue(`${path}.${name}`, 'protected runtime variables cannot be overridden'));
    }
    if (typeof value !== 'string' || value.length > 2048) {
      issues.push(issue(`${path}.${name}`, 'value must be a short string'));
    } else if (SECRET_VALUE.test(value)) {
      issues.push(issue(`${path}.${name}`, 'secret material is not allowed'));
    }
  }
};

export const validateToolVersionDefinition = (definition) => {
  const issues = [];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return { valid: false, issues: [issue('version', 'definition must be an object')] };
  }
  if (definition.schemaVersion !== TOOL_SCHEMA_VERSION) {
    issues.push(issue('schemaVersion', `schemaVersion must be ${TOOL_SCHEMA_VERSION}`));
  }
  if (!VERSION_PATTERN.test(definition.version ?? '')) {
    issues.push(issue('version', 'version must be exact and start with a number'));
  }
  if (definition.source?.type !== 'https') {
    issues.push(issue('source.type', 'source type must be https'));
  }
  validatePublicHttpsUrl(definition.source?.url, 'source.url', issues);
  const expected = definition.source?.expectedChecksum;
  if (expected) {
    const expectedLength = expected.algorithm === 'sha512' ? 128 : 64;
    if (
      !['sha256', 'sha512'].includes(expected.algorithm) ||
      !new RegExp(`^[a-f0-9]{${expectedLength}}$`, 'i').test(expected.value ?? '')
    ) {
      issues.push(
        issue('source.expectedChecksum', 'publisher checksum must be SHA-256 or SHA-512'),
      );
    }
    if (expected.evidenceUrl) {
      validatePublicHttpsUrl(expected.evidenceUrl, 'source.expectedChecksum.evidenceUrl', issues, {
        allowQuery: true,
      });
    }
  }
  if (!['generated', 'script'].includes(definition.installer?.mode)) {
    issues.push(issue('installer.mode', 'installer mode must be generated or script'));
  }
  if (definition.installer?.mode === 'generated') {
    const strip = definition.installer.stripComponents ?? 1;
    if (!Number.isInteger(strip) || strip < 0 || strip > 4) {
      issues.push(issue('installer.stripComponents', 'stripComponents must be between 0 and 4'));
    }
  }
  if (definition.installer?.mode === 'script') {
    const script = definition.installer.script;
    if (typeof script !== 'string' || !script.trim() || script.length > 32_768) {
      issues.push(issue('installer.script', 'installer script must be between 1 and 32768 bytes'));
    } else if (SECRET_VALUE.test(script)) {
      issues.push(issue('installer.script', 'secret material is not allowed'));
    }
  }
  if (!Array.isArray(definition.executables) || definition.executables.length === 0) {
    issues.push(issue('executables', 'at least one executable is required'));
  } else {
    const names = new Set();
    for (const [index, executable] of definition.executables.entries()) {
      if (!EXECUTABLE_PATTERN.test(executable?.name ?? '')) {
        issues.push(issue(`executables.${index}.name`, 'executable name is invalid'));
      } else if (names.has(executable.name)) {
        issues.push(issue(`executables.${index}.name`, 'executable name must be unique'));
      } else {
        names.add(executable.name);
      }
      if (!RELATIVE_PATH_PATTERN.test(executable?.path ?? '')) {
        issues.push(
          issue(`executables.${index}.path`, 'executable path must stay inside the tool'),
        );
      }
    }
  }
  if (!Array.isArray(definition.dependencies ?? [])) {
    issues.push(issue('dependencies', 'dependencies must be an array'));
  } else {
    for (const [index, dependency] of definition.dependencies.entries()) {
      if (!TOOL_ID_PATTERN.test(dependency ?? '')) {
        issues.push(issue(`dependencies.${index}`, 'dependency tool id is invalid'));
      }
    }
  }
  validatePackages(definition.aptPackages ?? [], 'aptPackages', issues);
  validateVariables(definition.environmentVariables ?? {}, 'environmentVariables', issues);
  const verification = definition.verification;
  if (!verification || typeof verification !== 'object') {
    issues.push(issue('verification', 'verification is required'));
  } else {
    if (!VERIFICATION_PRESETS.has(verification.preset ?? '')) {
      issues.push(issue('verification.preset', 'verification preset is invalid'));
    }
    const argv = verification.versionCommand?.argv;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.length > 8 ||
      argv.some((part) => typeof part !== 'string' || !part || part.length > 256)
    ) {
      issues.push(
        issue('verification.versionCommand.argv', 'version command must use argv values'),
      );
    }
    if (
      typeof verification.versionCommand?.expected !== 'string' ||
      !verification.versionCommand.expected ||
      verification.versionCommand.expected.length > 256
    ) {
      issues.push(
        issue('verification.versionCommand.expected', 'expected version output is required'),
      );
    }
    if (
      verification.script !== undefined &&
      (typeof verification.script !== 'string' || verification.script.length > 32_768)
    ) {
      issues.push(issue('verification.script', 'verification script must be at most 32768 bytes'));
    } else if (SECRET_VALUE.test(verification.script ?? '')) {
      issues.push(issue('verification.script', 'secret material is not allowed'));
    }
    const files = verification.files ?? [];
    if (!Array.isArray(files) || files.length > 32) {
      issues.push(
        issue('verification.files', 'verification files must contain at most 32 entries'),
      );
    } else {
      let totalBytes = 0;
      const paths = new Set();
      for (const [index, file] of files.entries()) {
        if (!FIXTURE_PATH_PATTERN.test(file?.path ?? '')) {
          issues.push(issue(`verification.files.${index}.path`, 'fixture path is invalid'));
        } else if (paths.has(file.path)) {
          issues.push(issue(`verification.files.${index}.path`, 'fixture path must be unique'));
        } else {
          paths.add(file.path);
        }
        if (typeof file?.content !== 'string') {
          issues.push(issue(`verification.files.${index}.content`, 'fixture content must be text'));
        } else {
          totalBytes += Buffer.byteLength(file.content);
          if (SECRET_VALUE.test(file.content)) {
            issues.push(
              issue(`verification.files.${index}.content`, 'secret material is not allowed'),
            );
          }
        }
      }
      if (totalBytes > 65_536) {
        issues.push(
          issue('verification.files', 'verification files must total at most 65536 bytes'),
        );
      }
    }
  }
  return { valid: issues.length === 0, issues };
};

export const normalizeToolVersionDefinition = (input = {}) => {
  const preset = String(input.verification?.preset || input.preset || 'generic');
  const version = String(input.version ?? '').trim();
  const generatedVersionCommand = presetVersionCommand(preset, version);
  const definition = {
    schemaVersion: TOOL_SCHEMA_VERSION,
    version,
    source: {
      type: 'https',
      url: String(input.source?.url ?? input.sourceUrl ?? '').trim(),
      ...(input.source?.expectedChecksum?.value
        ? {
            expectedChecksum: {
              algorithm: input.source.expectedChecksum.algorithm === 'sha512' ? 'sha512' : 'sha256',
              value: String(input.source.expectedChecksum.value).trim().toLowerCase(),
              evidenceUrl: String(input.source.expectedChecksum.evidenceUrl ?? '').trim(),
            },
          }
        : {}),
    },
    installer:
      input.installer?.mode === 'script'
        ? { mode: 'script', script: String(input.installer.script ?? '') }
        : {
            mode: 'generated',
            stripComponents: Number(input.installer?.stripComponents ?? 1),
          },
    executables: Array.isArray(input.executables)
      ? input.executables.map((entry) => ({
          name: String(entry.name ?? '').trim(),
          path: String(entry.path ?? '').trim(),
        }))
      : [],
    dependencies: [...new Set((input.dependencies ?? []).map((value) => String(value).trim()))],
    aptPackages: (input.aptPackages ?? []).map((pkg) => ({
      name: String(pkg.name ?? '').trim(),
      version: String(pkg.version ?? '').trim(),
    })),
    environmentVariables: Object.fromEntries(
      Object.entries(input.environmentVariables ?? {}).map(([name, value]) => [
        name.trim(),
        String(value),
      ]),
    ),
    verification: {
      preset,
      versionCommand: {
        argv: (input.verification?.versionCommand?.argv ?? generatedVersionCommand.argv).map(
          String,
        ),
        expected: String(
          input.verification?.versionCommand?.expected ?? generatedVersionCommand.expected,
        ),
      },
      script: String(input.verification?.script ?? ''),
      files: (input.verification?.files ?? []).map((file) => ({
        path: String(file.path ?? '').trim(),
        content: String(file.content ?? ''),
      })),
    },
  };
  const validation = validateToolVersionDefinition(definition);
  if (!validation.valid) {
    throw Object.assign(new Error('Invalid tool version definition'), {
      statusCode: 400,
      issues: validation.issues,
    });
  }
  return definition;
};

const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

const PRESET_SCRIPTS = {
  generic: ':',
  java: `work="$(mktemp -d)"
cat > "$work/Main.java" <<'JAVA'
class Main {
  public static void main(String[] args) {
    System.out.println(2);
  }
}
JAVA
javac "$work/Main.java"
java -cp "$work" Main | grep -qx 2`,
  go: `work="$(mktemp -d)"
cat > "$work/main.go" <<'GO'
package main

import "fmt"

func main() {
  fmt.Println(2)
}
GO
cd "$work"
export GOCACHE="$work/.cache"
export GOMODCACHE="$work/.mod"
go build -o app main.go
./app | grep -qx 2`,
  rust: `work="$(mktemp -d)"
cd "$work"
export CARGO_HOME="$work/.cargo-home"
cargo init --bin --name managed-tool-check -q
cargo build -q
./target/debug/managed-tool-check >/dev/null`,
  maven: `work="$(mktemp -d)"
cat > "$work/pom.xml" <<'MAVEN'
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>managed.tool</groupId>
  <artifactId>verification</artifactId>
  <version>1</version>
</project>
MAVEN
cd "$work"
mvn -q -o -Dmaven.repo.local="$work/.m2" validate`,
  gradle: `work="$(mktemp -d)"
cat > "$work/build.gradle" <<'GRADLE'
tasks.register("verifyTool")
GRADLE
cd "$work"
export GRADLE_USER_HOME="$work/.gradle"
gradle --offline -q verifyTool`,
  dotnet: `work="$(mktemp -d)"
cd "$work"
export DOTNET_CLI_HOME="$work/.dotnet"
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export NUGET_PACKAGES="$work/.nuget"
dotnet new console --no-restore >/dev/null
dotnet restore --ignore-failed-sources >/dev/null
dotnet run --no-restore >/dev/null`,
};

const VERIFICATION_PRESETS = new Set(Object.keys(PRESET_SCRIPTS));

const generatedInstaller = (stripComponents) => `#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p "$TOOL_OUTPUT"
case "$TOOL_ARCHIVE_FORMAT" in
  zip)
    staging="$(mktemp -d)"
    trap 'rm -rf "$staging"' EXIT
    unzip -q "$TOOL_SOURCE" -d "$staging"
    source="$staging"
    for _ in $(seq 1 ${stripComponents}); do
      shopt -s nullglob dotglob
      entries=("$source"/*)
      test "\${#entries[@]}" -eq 1
      test -d "\${entries[0]}"
      source="\${entries[0]}"
    done
    cp -a "$source"/. "$TOOL_OUTPUT"/
    ;;
  tar.gz) tar -xzf "$TOOL_SOURCE" -C "$TOOL_OUTPUT" --strip-components=${stripComponents};;
  tar.xz) tar -xJf "$TOOL_SOURCE" -C "$TOOL_OUTPUT" --strip-components=${stripComponents};;
  *) printf 'unsupported archive format: %s\\n' "$TOOL_ARCHIVE_FORMAT" >&2; exit 1;;
esac
`;

export const generateToolVerifierScript = (
  definition,
  { fixturesPath = '/opt/tool-verification/fixtures' } = {},
) => {
  const argv = definition.verification.versionCommand.argv.map(quote).join(' ');
  const expected = quote(definition.verification.versionCommand.expected);
  const preset = PRESET_SCRIPTS[definition.verification.preset] ?? PRESET_SCRIPTS.generic;
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export TOOL_FIXTURES=${quote(fixturesPath)}
output="$(${argv} 2>&1)"
printf '%s' "$output" | grep -F ${expected} >/dev/null
${preset}
${definition.verification.script || ':'}
`;
};

const archiveFormat = (url) => {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.zip')) return 'zip';
  if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) return 'tar.gz';
  if (path.endsWith('.tar.xz')) return 'tar.xz';
  throw Object.assign(new Error('Source URL must end in .zip, .tar.gz, .tgz, or .tar.xz'), {
    statusCode: 400,
  });
};

const substituteRoot = (value, root) => String(value).replaceAll('${TOOL_ROOT}', root);

const validationDockerfile = ({
  toolId,
  versionId,
  definition,
  dependencies,
  coreImageRef,
  hasVerificationFiles,
}) => {
  const root = `/opt/managed/tools/${toolId}/${definition.version}`;
  const executableOwners = new Map();
  const variableValues = new Map();
  const register = ({ owner, executables, environmentVariables, root: ownerRoot }) => {
    for (const executable of executables) {
      const existing = executableOwners.get(executable.name);
      if (existing && existing !== owner) {
        throw Object.assign(
          new Error(`Executable ${executable.name} is provided by both ${existing} and ${owner}`),
          { statusCode: 409, code: 'TOOL_EXECUTABLE_CONFLICT' },
        );
      }
      executableOwners.set(executable.name, owner);
    }
    for (const [name, value] of Object.entries(environmentVariables)) {
      const resolved = substituteRoot(value, ownerRoot);
      const existing = variableValues.get(name);
      if (existing !== undefined && existing !== resolved) {
        throw Object.assign(new Error(`Variable ${name} has conflicting tool values`), {
          statusCode: 409,
          code: 'TOOL_VARIABLE_CONFLICT',
        });
      }
      variableValues.set(name, resolved);
    }
  };
  for (const dependency of dependencies) {
    register({
      owner: dependency.toolId,
      executables: dependency.executables,
      environmentVariables: dependency.environmentVariables,
      root: `/opt/managed/tools/${dependency.toolId}/${dependency.version}`,
    });
  }
  register({
    owner: toolId,
    executables: definition.executables,
    environmentVariables: definition.environmentVariables,
    root,
  });
  const lines = dependencies.map(
    (dependency, index) =>
      `FROM ${dependency.imageUri}@${dependency.imageDigest} AS managed_dependency_${index}`,
  );
  lines.push(
    'ARG TOOL_IMAGE',
    `FROM \${TOOL_IMAGE} AS managed_tool`,
    `FROM ${coreImageRef}`,
    'USER root',
  );
  for (const [index, dependency] of dependencies.entries()) {
    const dependencyRoot = `/opt/managed/tools/${dependency.toolId}/${dependency.version}`;
    lines.push(`COPY --from=managed_dependency_${index} /opt/tool/ ${dependencyRoot}/`);
    for (const executable of dependency.executables) {
      lines.push(
        `RUN ln -sf ${quote(`${dependencyRoot}/${executable.path}`)} ${quote(
          `/usr/local/bin/${executable.name}`,
        )}`,
      );
    }
    for (const [name, value] of Object.entries(dependency.environmentVariables)) {
      lines.push(`ENV ${name}=${JSON.stringify(substituteRoot(value, dependencyRoot))}`);
    }
  }
  lines.push(
    `COPY --from=managed_tool /opt/tool/ ${root}/`,
    'COPY --from=managed_tool /opt/tool-metadata/ /opt/tool-metadata/',
  );
  const packages = new Map();
  for (const pkg of [
    ...dependencies.flatMap((dependency) => dependency.aptPackages),
    ...definition.aptPackages,
  ]) {
    const existing = packages.get(pkg.name);
    if (existing && existing !== pkg.version) {
      throw Object.assign(new Error(`Tool validation requires conflicting ${pkg.name} versions`), {
        statusCode: 409,
        code: 'TOOL_PACKAGE_CONFLICT',
      });
    }
    packages.set(pkg.name, pkg.version);
  }
  if (packages.size) {
    lines.push(
      `RUN apt-get update && apt-get install -y --no-install-recommends ${[...packages]
        .map(([name, version]) => `${name}=${version}`)
        .join(' ')} && rm -rf /var/lib/apt/lists/*`,
    );
  }
  for (const executable of definition.executables) {
    lines.push(
      `RUN ln -sf ${quote(`${root}/${executable.path}`)} ${quote(
        `/usr/local/bin/${executable.name}`,
      )}`,
    );
  }
  for (const [name, value] of Object.entries(definition.environmentVariables)) {
    lines.push(`ENV ${name}=${JSON.stringify(substituteRoot(value, root))}`);
  }
  lines.push(
    'COPY verify.sh /opt/tool-verification/verify.sh',
    ...(hasVerificationFiles
      ? ['COPY verification-fixtures/ /opt/tool-verification/fixtures/']
      : ['RUN mkdir -p /opt/tool-verification/fixtures']),
    'RUN chmod 0555 /opt/tool-verification/verify.sh',
    'RUN node -e \'const fs=require("fs");const doc=JSON.parse(fs.readFileSync("/opt/tool-metadata/sbom.spdx.json","utf8"));if(doc.spdxVersion!=="SPDX-2.3"||!Array.isArray(doc.files)||!doc.files.length)process.exit(1)\'',
    'USER node',
    'WORKDIR /mnt/workspace',
    'ENTRYPOINT ["/opt/tool-verification/verify.sh"]',
    `LABEL managed.tool.id=${JSON.stringify(toolId)}`,
    `LABEL managed.tool.version-id=${JSON.stringify(versionId)}`,
  );
  return `${lines.join('\n')}\n`;
};

const FETCH_SOURCE = String.raw`import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { Readable } from 'node:stream';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const maxBytes = 1024 * 1024 * 1024;

const privateAddress = (address) => {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
};

const assertPublic = async (url, allowQuery = false) => {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (!allowQuery && url.search)
  ) {
    throw new Error('source URL must be credential-free HTTPS without query data');
  }
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error('source URL resolved to a non-public address');
  }
};

const fetchPublic = async (
  requestedUrl,
  { timeout = 300000, allowInitialQuery = false } = {},
) => {
  let url = new URL(requestedUrl);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    await assertPublic(url, allowInitialQuery || redirect > 0);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('public download redirect omitted Location');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      throw new Error('public download failed with HTTP ' + response.status);
    }
    return { response, url };
  }
  throw new Error('public download redirect limit exceeded');
};

const readTextBounded = async (response, maxBytes) => {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('publisher checksum evidence exceeds 1 MiB');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of Readable.fromWeb(response.body)) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('publisher checksum evidence exceeds 1 MiB');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const { response, url } = await fetchPublic(manifest.definition.source.url);
const declared = Number(response.headers.get('content-length') || 0);
if (declared > maxBytes) throw new Error('source archive exceeds 1024 MiB');
let bytes = 0;
const sha256 = createHash('sha256');
const expectedAlgorithm = manifest.definition.source.expectedChecksum?.algorithm;
const expectedHash = expectedAlgorithm === 'sha512' ? createHash('sha512') : sha256;
const stream = Readable.fromWeb(response.body).map((chunk) => {
  bytes += chunk.length;
  if (bytes > maxBytes) throw new Error('source archive exceeds 1024 MiB');
  sha256.update(chunk);
  if (expectedHash !== sha256) expectedHash.update(chunk);
  return chunk;
});
await finished(stream.pipe(createWriteStream('source.bin', { mode: 0o444 })));
const digest = sha256.digest('hex');
const expected = manifest.definition.source.expectedChecksum?.value;
const publisherDigest = expectedHash === sha256 ? digest : expectedHash.digest('hex');
if (expected && publisherDigest !== expected.toLowerCase()) throw new Error('publisher checksum mismatch');
const evidenceUrl = manifest.definition.source.expectedChecksum?.evidenceUrl;
let publisherVerified = false;
if (expected && evidenceUrl) {
  const { response: evidenceResponse } = await fetchPublic(evidenceUrl, {
    timeout: 60000,
    allowInitialQuery: true,
  });
  const evidenceText = await readTextBounded(evidenceResponse, 1024 * 1024);
  if (!evidenceText.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error('publisher checksum evidence does not contain the expected digest');
  }
  publisherVerified = true;
}
const storedUrl = new URL(url);
storedUrl.search = '';
await writeFile(
  'source-result.json',
  JSON.stringify(
    {
      requestedUrl: manifest.definition.source.url,
      resolvedUrl: storedUrl.toString(),
      sha256: digest,
      sizeBytes: bytes,
      trustLevel: publisherVerified ? 'PUBLISHER_VERIFIED' : 'PLATFORM_PINNED',
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
`;

const INSPECT_ARCHIVE = String.raw`#!/usr/bin/env python3
import posixpath
import sys
import tarfile
import zipfile

archive_path, archive_format = sys.argv[1:3]
max_entries = 200000
max_extracted_bytes = 4 * 1024 * 1024 * 1024

def normalized_member(name):
    value = name.replace("\\", "/")
    normalized = posixpath.normpath(value)
    if (
        not value
        or value.startswith("/")
        or normalized == ".."
        or normalized.startswith("../")
        or "\x00" in value
    ):
        raise ValueError(f"unsafe archive path: {name!r}")
    return normalized

def safe_link(member_name, target):
    if not target or target.startswith("/") or "\x00" in target:
        raise ValueError(f"unsafe archive link: {member_name!r}")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(member_name), target))
    if resolved == ".." or resolved.startswith("../"):
        raise ValueError(f"archive link escapes extraction root: {member_name!r}")

entries = 0
extracted_bytes = 0

if archive_format == "zip":
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            entries += 1
            name = normalized_member(member.filename)
            extracted_bytes += member.file_size
            mode = member.external_attr >> 16
            if (mode & 0o170000) == 0o120000:
                safe_link(name, archive.read(member).decode("utf-8"))
elif archive_format in {"tar.gz", "tar.xz"}:
    mode = "r:gz" if archive_format == "tar.gz" else "r:xz"
    with tarfile.open(archive_path, mode) as archive:
        for member in archive:
            entries += 1
            name = normalized_member(member.name)
            extracted_bytes += max(member.size, 0)
            if member.isdev() or member.isfifo():
                raise ValueError(f"archive contains a special file: {member.name!r}")
            if member.issym() or member.islnk():
                safe_link(name, member.linkname)
else:
    raise ValueError(f"unsupported archive format: {archive_format}")

if entries > max_entries:
    raise ValueError(f"archive contains more than {max_entries} entries")
if extracted_bytes > max_extracted_bytes:
    raise ValueError("archive expands beyond 4096 MiB")
`;

const GENERATE_SBOM = String.raw`import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const root = 'tool-output';
const files = [];

const sha256File = async (path) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
};

const visit = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
    } else if (entry.isFile()) {
      const details = await stat(path);
      files.push({
        SPDXID: 'SPDXRef-File-' + createHash('sha256').update(relative(root, path)).digest('hex').slice(0, 24),
        fileName: './' + relative(root, path).replaceAll('\\', '/'),
        checksums: [{ algorithm: 'SHA256', checksumValue: await sha256File(path) }],
        fileTypes: details.mode & 0o111 ? ['BINARY'] : ['OTHER'],
      });
    }
  }
};

await visit(root);
files.sort((left, right) => left.fileName.localeCompare(right.fileName));
const namespaceSeed = manifest.toolId + ':' + manifest.versionId + ':' + manifest.definition.version;
const document = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: manifest.toolId + '-' + manifest.definition.version,
  documentNamespace: 'https://managed-tools.invalid/spdx/' + createHash('sha256').update(namespaceSeed).digest('hex'),
  creationInfo: {
    created: manifest.generatedAt,
    creators: ['Tool: managed-tool-builder'],
  },
  packages: [{
    SPDXID: 'SPDXRef-Package-' + manifest.toolId,
    name: manifest.toolId,
    versionInfo: manifest.definition.version,
    downloadLocation: manifest.definition.source.url,
    filesAnalyzed: true,
    packageVerificationCode: {
      packageVerificationCodeValue: createHash('sha1')
        .update(files.map((file) => file.checksums[0].checksumValue).join(''))
        .digest('hex'),
    },
  }],
  files,
  relationships: files.map((file) => ({
    spdxElementId: 'SPDXRef-Package-' + manifest.toolId,
    relationshipType: 'CONTAINS',
    relatedSpdxElement: file.SPDXID,
  })),
};
await writeFile('sbom.spdx.json', JSON.stringify(document, null, 2) + '\n', { mode: 0o444 });
`;

const BUILD_TOOL = `#!/usr/bin/env bash
set -Eeuo pipefail
context_dir="$(pwd)"
core_ref="\${CORE_IMAGE_URI}@\${CORE_IMAGE_DIGEST}"
tool_ref="\${TOOL_REPOSITORY_URI}:\${TOOL_IMAGE_TAG}"
validation_ref="managed-tool-validation:\${TOOL_IMAGE_TAG}"

iptables -I DOCKER-USER 1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
  iptables -I DOCKER-USER 2 -d "$cidr" -j REJECT
done

retained_sha="$(jq -r '.retainedSource.sha256 // empty' manifest.json)"
if test -n "$retained_sha"; then
  aws s3 cp "s3://\${CONTEXT_BUCKET}/managed-tools/sources/\${retained_sha}" source.bin
  printf '%s  source.bin\n' "$retained_sha" | sha256sum -c -
  jq '.retainedSource' manifest.json > source-result.json
else
  mkdir -p source-fetch
  cp manifest.json source-fetch/manifest.json
  chmod 0777 source-fetch
  docker run --rm \
    --name "managed-tool-source-\${CODEBUILD_BUILD_NUMBER:-local}" \
    --user 65534:65534 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 128 \
    --memory 512m \
    --cpus 1 \
    --sysctl net.ipv6.conf.all.disable_ipv6=1 \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    --env AWS_EC2_METADATA_DISABLED=true \
    --mount "type=bind,src=$context_dir/fetch-source.mjs,dst=/workspace/fetch-source.mjs,readonly" \
    --mount "type=bind,src=$context_dir/source-fetch,dst=/output" \
    --workdir /output \
    --entrypoint node \
    "$core_ref" /workspace/fetch-source.mjs
  mv source-fetch/source.bin source.bin
  mv source-fetch/source-result.json source-result.json
  rm -rf source-fetch
  source_sha="$(jq -r .sha256 source-result.json)"
  aws s3 cp source.bin "s3://\${CONTEXT_BUCKET}/managed-tools/sources/\${source_sha}" --sse AES256
fi
aws s3 cp source-result.json "s3://\${CONTEXT_BUCKET}/\${CONTEXT_PREFIX}/source-result.json" --sse AES256
python3 inspect-archive.py source.bin "$(jq -r .archiveFormat manifest.json)"

mkdir -p tool-output
docker run --rm \
  --name "managed-tool-install-\${CODEBUILD_BUILD_NUMBER:-local}" \
  --user 0:0 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --memory 3g \
  --cpus 2 \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --env AWS_EC2_METADATA_DISABLED=true \
  --env TOOL_VERSION="$(jq -r .definition.version manifest.json)" \
  --env TOOL_ARCHIVE_FORMAT="$(jq -r .archiveFormat manifest.json)" \
  --env TOOL_SOURCE=/input/source \
  --env TOOL_OUTPUT=/output \
  --mount "type=bind,src=$context_dir/source.bin,dst=/input/source,readonly" \
  --mount "type=bind,src=$context_dir/install.sh,dst=/workspace/install.sh,readonly" \
  --mount "type=bind,src=$context_dir/tool-output,dst=/output" \
  --entrypoint /bin/bash \
  "$core_ref" /workspace/install.sh

test -n "$(find tool-output -mindepth 1 -print -quit)"
output_bytes="$(du -sb tool-output | cut -f1)"
if (( output_bytes > 1536 * 1024 * 1024 )); then
  printf 'normalized tool output exceeds 1536 MiB: %s bytes\n' "$output_bytes" >&2
  exit 1
fi
test -z "$(find tool-output \\( -type b -o -type c -o -type p -o -type s \\) -print -quit)"
test -z "$(find tool-output -perm /6000 -print -quit)"
while IFS= read -r -d '' link; do
  resolved="$(readlink -f "$link")"
  case "$resolved" in
    "$context_dir/tool-output"/*) ;;
    *) printf 'tool archive contains an unsafe symlink: %s\\n' "$link" >&2; exit 1;;
  esac
done < <(find tool-output -type l -print0)
while IFS=$'\\t' read -r name path; do
  test -x "tool-output/$path"
done < <(jq -r '.definition.executables[] | [.name, .path] | @tsv' manifest.json)

node generate-sbom.mjs
docker build --platform linux/arm64 --tag "$tool_ref" -f Dockerfile.tool .
docker build --platform linux/arm64 --tag "$validation_ref" \
  --build-arg "TOOL_IMAGE=$tool_ref" -f Dockerfile.validation .
docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --pids-limit 256 --memory 3g --cpus 2 "$validation_ref"
docker push "$tool_ref"

docker image inspect "$tool_ref" --format '{{.Size}}' > image-size.txt
jq -n \
  --argjson source "$(cat source-result.json)" \
  --arg imageTag "$TOOL_IMAGE_TAG" \
  --argjson imageSizeBytes "$(cat image-size.txt)" \
  --arg coreImageDigest "$(jq -r .coreImageDigest manifest.json)" \
  --arg runtimeCompatibilityVersion "$(jq -r .runtimeCompatibilityVersion manifest.json)" \
  '{source: $source, imageTag: $imageTag, imageSizeBytes: $imageSizeBytes, verification: {status: "PASSED", architecture: "arm64", nonRoot: true, networkless: true, sbom: true, coreImageDigest: $coreImageDigest, runtimeCompatibilityVersion: $runtimeCompatibilityVersion}}' \
  > tool-result.json
aws s3 cp tool-result.json "s3://\${CONTEXT_BUCKET}/\${CONTEXT_PREFIX}/tool-result.json" --sse AES256
`;

export const generateToolBuildContext = ({
  tool,
  version,
  dependencies = [],
  coreImageUri,
  coreImageDigest,
  runtimeCompatibilityVersion = '1',
  generatedAt = new Date().toISOString(),
}) => {
  const definition = normalizeToolVersionDefinition(version.definition ?? version);
  const coreImageRef = `${coreImageUri}@${coreImageDigest}`;
  const manifest = {
    schemaVersion: TOOL_SCHEMA_VERSION,
    toolId: tool.toolId,
    versionId: version.versionId,
    generatedAt,
    definition,
    archiveFormat: archiveFormat(definition.source.url),
    coreImageRef,
    coreImageDigest,
    runtimeCompatibilityVersion,
    dependencies,
    retainedSource: version.source?.sha256 ? version.source : null,
  };
  const install =
    definition.installer.mode === 'script'
      ? definition.installer.script
      : generatedInstaller(definition.installer.stripComponents ?? 1);
  const metadata = {
    schemaVersion: TOOL_SCHEMA_VERSION,
    toolId: tool.toolId,
    versionId: version.versionId,
    version: definition.version,
    executables: definition.executables,
    dependencies: definition.dependencies,
    aptPackages: definition.aptPackages,
    environmentVariables: definition.environmentVariables,
    verification: definition.verification,
  };
  const files = {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'tool-metadata.json': `${JSON.stringify(metadata, null, 2)}\n`,
    'install.sh': install.endsWith('\n') ? install : `${install}\n`,
    'verify.sh': generateToolVerifierScript(definition),
    'fetch-source.mjs': FETCH_SOURCE,
    'inspect-archive.py': INSPECT_ARCHIVE,
    'generate-sbom.mjs': GENERATE_SBOM,
    'build-tool.sh': BUILD_TOOL,
    'Dockerfile.tool':
      'FROM scratch\nCOPY tool-output/ /opt/tool/\nCOPY tool-metadata.json /opt/tool-metadata/metadata.json\nCOPY sbom.spdx.json /opt/tool-metadata/sbom.spdx.json\n',
    'Dockerfile.validation': validationDockerfile({
      toolId: tool.toolId,
      versionId: version.versionId,
      definition,
      dependencies,
      coreImageRef,
      hasVerificationFiles: definition.verification.files.length > 0,
    }),
  };
  for (const fixture of definition.verification.files) {
    files[`verification-fixtures/${fixture.path}`] = fixture.content;
  }
  const checksums = Object.fromEntries(
    Object.entries(files).map(([name, body]) => [
      name,
      createHash('sha256').update(body).digest('hex'),
    ]),
  );
  files['checksums.sha256'] = `${Object.entries(checksums)
    .map(([name, checksum]) => `${checksum}  ${name}`)
    .join('\n')}\n`;
  return { files, manifest, definition };
};

export const resolveToolDependencies = ({
  selectedVersionIds,
  tools,
  versions,
  providedToolIds = [],
}) => {
  const toolById = new Map(tools.map((tool) => [tool.toolId, tool]));
  const versionById = new Map(versions.map((version) => [version.versionId, version]));
  const provided = new Set(providedToolIds);
  const selected = new Map();
  for (const versionId of selectedVersionIds) {
    const version = versionById.get(versionId);
    if (!version || version.status !== 'PUBLISHED') {
      throw Object.assign(new Error('Selected tool version is not published'), { statusCode: 409 });
    }
    if (selected.has(version.toolId)) {
      throw Object.assign(new Error(`Only one ${version.toolId} version can be selected`), {
        statusCode: 409,
      });
    }
    selected.set(version.toolId, version);
  }
  const visiting = new Set();
  const include = (toolId) => {
    if (visiting.has(toolId)) {
      throw Object.assign(new Error('Tool dependency cycle detected'), { statusCode: 409 });
    }
    const version = selected.get(toolId);
    if (!version) return;
    visiting.add(toolId);
    for (const dependencyId of version.definition.dependencies ?? []) {
      if (provided.has(dependencyId)) continue;
      if (!selected.has(dependencyId)) {
        const dependency = toolById.get(dependencyId);
        const recommended = versionById.get(dependency?.recommendedVersionId);
        if (!recommended || recommended.status !== 'PUBLISHED') {
          throw Object.assign(
            new Error(`Tool ${toolId} requires a recommended ${dependencyId} version`),
            { statusCode: 409 },
          );
        }
        selected.set(dependencyId, recommended);
      }
      include(dependencyId);
    }
    visiting.delete(toolId);
  };
  for (const toolId of selected.keys()) include(toolId);
  return [...selected.values()].toSorted((left, right) => left.toolId.localeCompare(right.toolId));
};

export const toolVersionSnapshot = (version, tool = {}) => ({
  toolId: version.toolId,
  name: tool.name ?? version.toolId,
  category: tool.category ?? 'cli',
  publisher: tool.publisher ?? '',
  versionId: version.versionId,
  version: version.definition.version,
  imageUri: version.imageUri,
  imageDigest: version.imageDigest,
  imageSizeBytes: version.imageSizeBytes ?? null,
  trustLevel: version.source?.trustLevel ?? 'PLATFORM_PINNED',
  source: version.source,
  executables: version.definition.executables,
  dependencies: version.definition.dependencies,
  aptPackages: version.definition.aptPackages,
  environmentVariables: version.definition.environmentVariables,
  verification: version.definition.verification,
  scanFindings: version.scanFindings ?? null,
  securityFindingsAcceptedAt: version.securityFindingsAcceptedAt ?? null,
  securityFindingsAcceptedBy: version.securityFindingsAcceptedBy ?? null,
});
