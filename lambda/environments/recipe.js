import { createHash } from 'node:crypto';

export { supportsCompatibilityVersion as isSupportedCompatibilityVersion } from '../shared/runtime-compatibility.js';

export const RECIPE_SCHEMA_VERSION = 1;
export const CURRENT_RUNTIME_COMPATIBILITY_VERSION = '1';

export const ENVIRONMENT_STATUSES = [
  'DRAFT',
  'BUILDING',
  'SECURITY_REVIEW',
  'VERIFYING',
  'READY',
  'PUBLISHED',
  'UPDATE_AVAILABLE',
  'FAILED',
  'RETIRED',
];

export const REVISION_STATUSES = [
  'DRAFT',
  'QUEUED',
  'BUILDING',
  'SCANNING',
  'SECURITY_REVIEW',
  'VERIFYING',
  'READY',
  'PUBLISHED',
  'SUPERSEDED',
  'FAILED',
  'RETIRED',
];

export const TOOL_NAMES = ['node', 'python', 'java', 'go', 'rust'];
export const BUILD_TOOL_NAMES = ['maven', 'gradle'];

const RECIPE_KEYS = new Set([
  'schemaVersion',
  'base',
  'tools',
  'buildTools',
  'aptPackages',
  'environmentVariables',
  'buildCommands',
]);
const TOOL_KEYS = new Set(['version', 'source', 'url', 'checksum', 'stripComponents']);
const CHECKSUM_ALGORITHMS = new Set(['sha256', 'sha512']);
const ARCHIVE_HOSTS = new Set([
  'archive.apache.org',
  'github.com',
  'go.dev',
  'nodejs.org',
  'services.gradle.org',
  'static.rust-lang.org',
]);
const SECRET_NAME = /(secret|password|passwd|token|credential|private[_-]?key|api[_-]?key)/i;
const SECRET_VALUE =
  /(-----BEGIN [A-Z ]+PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,})/;
const SECRET_COMMAND =
  /(?:^|\s)(?:export\s+)?[A-Za-z0-9_]*(?:secret|password|passwd|token|credential|private[_-]?key|api[_-]?key)[A-Za-z0-9_]*\s*=|(?:^|\s)--?[A-Za-z0-9_-]*(?:secret|password|passwd|token|credential|private-key|api-key)[A-Za-z0-9_-]*(?:=|\s)/i;
const PROTECTED_VARIABLE_NAME =
  /^(AWS_|AIDLC_|AGENTCORE_|BEDROCK_|V2_|MCP_|CREDENTIAL_BROKER_|SOURCE_CONTROL_|CLAUDE_|KIRO_|OPENCODE_|CODEX_|XDG_|LD_|PATH$|HOME$|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|SHELLOPTS$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|RUNTIME_COMPATIBILITY_VERSION$)/;
const FORBIDDEN_COMMAND =
  /(^|\s)(from|entrypoint|cmd|user|expose|sudo|su|rm|mv|cp|ln|chmod|chown)\b|\/opt\/(agentcore|shared|managed)|\/mnt\/workspace|docker\s|podman\s|curl\b[^|]*\|\s*(sh|bash)|wget\b[^|]*\|\s*(sh|bash)/i;
const ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;
const VERSION_PATTERN = /^[0-9][0-9A-Za-z.+:~_-]*$/;
const VARIABLE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const NODE = { version: '24.15.0', source: 'base' };
const PYTHON = { version: '3.11', source: 'base' };
const RUST_APT_PACKAGES = [{ name: 'build-essential', version: '12.9' }];

const baseRecipe = (tools = {}, buildTools = {}, aptPackages = []) => ({
  schemaVersion: RECIPE_SCHEMA_VERSION,
  base: null,
  tools,
  buildTools,
  aptPackages,
  environmentVariables: {},
  buildCommands: [],
});

export const SYSTEM_ENVIRONMENT_TEMPLATES = [
  {
    id: 'standard',
    name: 'Standard Node/Python',
    description: 'The protected runtime with Node.js and Python.',
    baseEnvironmentId: null,
    recipe: baseRecipe({
      node: NODE,
      python: PYTHON,
    }),
  },
];

const issue = (path, message) => ({ path, message });

const validateChecksum = (checksum, path, issues) => {
  if (!checksum || typeof checksum !== 'object') {
    issues.push(issue(path, 'checksum is required for archive sources'));
    return;
  }
  if (!CHECKSUM_ALGORITHMS.has(checksum.algorithm)) {
    issues.push(issue(`${path}.algorithm`, 'checksum algorithm must be sha256 or sha512'));
    return;
  }
  const length = checksum.algorithm === 'sha256' ? 64 : 128;
  if (!new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(checksum.value ?? '')) {
    issues.push(issue(`${path}.value`, `${checksum.algorithm} checksum has an invalid shape`));
  }
};

const validateTool = (value, path, issues) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(issue(path, 'tool configuration must be an object'));
    return;
  }
  for (const key of Object.keys(value)) {
    if (!TOOL_KEYS.has(key)) issues.push(issue(`${path}.${key}`, 'unsupported tool field'));
  }
  if (!VERSION_PATTERN.test(value.version ?? '')) {
    issues.push(issue(`${path}.version`, 'version must be exact and start with a number'));
  }
  if (!['base', 'archive'].includes(value.source)) {
    issues.push(issue(`${path}.source`, 'source must be base or archive'));
  }
  if (value.source === 'archive') {
    let parsed;
    try {
      parsed = new URL(value.url);
    } catch {
      issues.push(issue(`${path}.url`, 'archive URL must be a valid HTTPS URL'));
    }
    if (parsed && (parsed.protocol !== 'https:' || !ARCHIVE_HOSTS.has(parsed.hostname))) {
      issues.push(issue(`${path}.url`, 'archive host is not in the curated source list'));
    }
    if (parsed && (parsed.username || parsed.password || parsed.search || parsed.hash)) {
      issues.push(issue(`${path}.url`, 'archive URL must not contain credentials or query data'));
    }
    validateChecksum(value.checksum, `${path}.checksum`, issues);
    if (
      value.stripComponents !== undefined &&
      (!Number.isInteger(value.stripComponents) ||
        value.stripComponents < 0 ||
        value.stripComponents > 4)
    ) {
      issues.push(issue(`${path}.stripComponents`, 'stripComponents must be between 0 and 4'));
    }
  } else if (
    value.url !== undefined ||
    value.checksum !== undefined ||
    value.stripComponents !== undefined
  ) {
    issues.push(issue(path, 'base tools cannot include archive fields'));
  }
};

export const validateRecipe = (recipe) => {
  const issues = [];
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    return { valid: false, issues: [issue('recipe', 'recipe must be an object')] };
  }
  for (const key of Object.keys(recipe)) {
    if (!RECIPE_KEYS.has(key)) issues.push(issue(key, 'unsupported recipe field'));
  }
  if (recipe.schemaVersion !== RECIPE_SCHEMA_VERSION) {
    issues.push(issue('schemaVersion', `schemaVersion must be ${RECIPE_SCHEMA_VERSION}`));
  }
  if (recipe.base !== null && recipe.base !== undefined) {
    const base = recipe.base;
    if (!base || typeof base !== 'object' || Array.isArray(base)) {
      issues.push(issue('base', 'base must be null or an object'));
    } else {
      if (!ID_PATTERN.test(base.environmentId ?? '')) {
        issues.push(issue('base.environmentId', 'base environment id is invalid'));
      }
      if (typeof base.revisionId !== 'string' || !base.revisionId) {
        issues.push(issue('base.revisionId', 'base revision is required'));
      }
      if (!/^sha256:[a-f0-9]{64}$/i.test(base.imageDigest ?? '')) {
        issues.push(issue('base.imageDigest', 'base image digest must be immutable'));
      }
      if (typeof base.imageUri !== 'string' || !base.imageUri) {
        issues.push(issue('base.imageUri', 'base image URI is required'));
      }
    }
  }
  const tools = recipe.tools ?? {};
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    issues.push(issue('tools', 'tools must be an object'));
  } else {
    for (const [name, value] of Object.entries(tools)) {
      if (!TOOL_NAMES.includes(name)) issues.push(issue(`tools.${name}`, 'unsupported tool'));
      else validateTool(value, `tools.${name}`, issues);
    }
  }
  const buildTools = recipe.buildTools ?? {};
  if (!buildTools || typeof buildTools !== 'object' || Array.isArray(buildTools)) {
    issues.push(issue('buildTools', 'buildTools must be an object'));
  } else {
    for (const [name, value] of Object.entries(buildTools)) {
      if (!BUILD_TOOL_NAMES.includes(name)) {
        issues.push(issue(`buildTools.${name}`, 'unsupported build tool'));
      } else {
        validateTool(value, `buildTools.${name}`, issues);
      }
    }
  }
  if (!Array.isArray(recipe.aptPackages ?? [])) {
    issues.push(issue('aptPackages', 'aptPackages must be an array'));
  } else {
    for (const [index, pkg] of recipe.aptPackages.entries()) {
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
        issues.push(issue(`aptPackages.${index}`, 'package must be an object'));
        continue;
      }
      if (!PACKAGE_PATTERN.test(pkg.name ?? '')) {
        issues.push(issue(`aptPackages.${index}.name`, 'package name is invalid'));
      }
      if (!VERSION_PATTERN.test(pkg.version ?? '')) {
        issues.push(issue(`aptPackages.${index}.version`, 'package version must be exact'));
      }
    }
  }
  const variables = recipe.environmentVariables ?? {};
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    issues.push(issue('environmentVariables', 'environmentVariables must be an object'));
  } else {
    for (const [name, value] of Object.entries(variables)) {
      if (!VARIABLE_PATTERN.test(name)) {
        issues.push(issue(`environmentVariables.${name}`, 'variable name is invalid'));
      }
      if (SECRET_NAME.test(name)) {
        issues.push(
          issue(`environmentVariables.${name}`, 'secret-like variable names are blocked'),
        );
      }
      if (PROTECTED_VARIABLE_NAME.test(name)) {
        issues.push(
          issue(`environmentVariables.${name}`, 'platform runtime variables cannot be overridden'),
        );
      }
      if (typeof value !== 'string' || value.length > 2048) {
        issues.push(issue(`environmentVariables.${name}`, 'variable value must be a short string'));
      } else if (SECRET_VALUE.test(value)) {
        issues.push(issue(`environmentVariables.${name}`, 'secret material is not allowed'));
      }
    }
  }
  if (!Array.isArray(recipe.buildCommands ?? [])) {
    issues.push(issue('buildCommands', 'buildCommands must be an array'));
  } else {
    if (recipe.buildCommands.length > 20) {
      issues.push(issue('buildCommands', 'at most 20 build commands are allowed'));
    }
    for (const [index, command] of recipe.buildCommands.entries()) {
      if (typeof command !== 'string' || !command.trim() || command.length > 1000) {
        issues.push(issue(`buildCommands.${index}`, 'build command must be a non-empty string'));
      } else if (/[\r\n]/.test(command)) {
        issues.push(issue(`buildCommands.${index}`, 'build commands must be single-line'));
      } else if (FORBIDDEN_COMMAND.test(command)) {
        issues.push(issue(`buildCommands.${index}`, 'build command changes protected behavior'));
      } else if (SECRET_COMMAND.test(command)) {
        issues.push(issue(`buildCommands.${index}`, 'secret-like command arguments are blocked'));
      } else if (SECRET_VALUE.test(command)) {
        issues.push(issue(`buildCommands.${index}`, 'secret material is not allowed'));
      }
    }
  }
  return { valid: issues.length === 0, issues };
};

const mergePackages = (parent = [], child = []) => {
  const merged = new Map(parent.map((pkg) => [pkg.name, pkg]));
  for (const pkg of child) merged.set(pkg.name, pkg);
  return [...merged.values()].toSorted((a, b) => a.name.localeCompare(b.name));
};

export const applyToolPrerequisites = (recipe) => ({
  ...recipe,
  aptPackages: mergePackages(recipe.aptPackages, recipe.tools?.rust ? RUST_APT_PACKAGES : []),
});

export const flattenRecipe = (recipe, parent = null) => ({
  schemaVersion: RECIPE_SCHEMA_VERSION,
  base: recipe.base ?? parent?.base ?? null,
  tools: { ...parent?.tools, ...recipe.tools },
  buildTools: { ...parent?.buildTools, ...recipe.buildTools },
  aptPackages: mergePackages(parent?.aptPackages, recipe.aptPackages),
  environmentVariables: {
    ...parent?.environmentVariables,
    ...recipe.environmentVariables,
  },
  buildCommands: [...(parent?.buildCommands ?? []), ...(recipe.buildCommands ?? [])],
});

const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
const digestValue = (value) => String(value ?? '').replace(/^sha256:/, '');
const installRoot = (name, version) => `/opt/managed/tools/${name}/${version}`;

const toolInstallLines = (name, tool) => {
  if (!tool || tool.source === 'base') return [];
  const root = installRoot(name, tool.version);
  const install = (destination) =>
    [
      'RUN /opt/managed/installers/install-archive.sh',
      quote(tool.url),
      quote(tool.checksum.algorithm),
      quote(tool.checksum.value),
      quote(destination),
      String(tool.stripComponents ?? 1),
    ].join(' ');
  if (name === 'rust') {
    const staging = `/tmp/managed-rust-${tool.version}`;
    return [
      `${install(staging)} && ${quote(`${staging}/install.sh`)} --prefix=${quote(
        root,
      )} --disable-ldconfig && rm -rf ${quote(staging)}`,
      `RUN ln -sf ${quote(`${root}/bin/rustc`)} /usr/local/bin/rustc && ln -sf ${quote(
        `${root}/bin/cargo`,
      )} /usr/local/bin/cargo`,
    ];
  }
  const links = {
    node: ['node', 'npm', 'npx'],
    python: ['python3', 'python', 'pip3', 'pip'],
    java: ['java', 'javac', 'jar'],
    go: ['go', 'gofmt'],
    maven: ['mvn'],
    gradle: ['gradle'],
  }[name];
  return [
    install(root),
    `RUN ${links
      .map((bin) => `ln -sf ${quote(`${root}/bin/${bin}`)} /usr/local/bin/${bin}`)
      .join(' && ')}`,
  ];
};

export const generateDockerfile = (inputRecipe) => {
  const recipe = applyToolPrerequisites(inputRecipe);
  const { valid, issues } = validateRecipe(recipe);
  if (!valid) {
    throw Object.assign(new Error('Invalid environment recipe'), { issues });
  }
  if (!recipe.base) throw new Error('A pinned base revision is required');
  const lines = [
    `FROM ${recipe.base.imageUri}@sha256:${digestValue(recipe.base.imageDigest)}`,
    'USER root',
    'COPY installers/ /opt/managed/installers/',
    'COPY manifest.json checksums.json sbom.spdx.json verification.sh /opt/managed/',
    'RUN chmod 0555 /opt/managed/installers/*.sh /opt/managed/verification.sh',
    'RUN find /opt/agentcore /opt/shared -type f -print0 | sort -z | xargs -0 sha256sum > /opt/managed/protected-runtime.sha256',
  ];
  if (recipe.aptPackages.length) {
    const packages = recipe.aptPackages.map((pkg) => `${pkg.name}=${pkg.version}`).join(' ');
    lines.push(
      `RUN apt-get update && apt-get install -y --no-install-recommends ${packages} && rm -rf /var/lib/apt/lists/*`,
    );
  }
  for (const [name, tool] of Object.entries(recipe.tools).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(...toolInstallLines(name, tool));
  }
  for (const [name, tool] of Object.entries(recipe.buildTools).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(...toolInstallLines(name, tool));
  }
  for (const [name, value] of Object.entries(recipe.environmentVariables).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`ENV ${name}=${JSON.stringify(value)}`);
  }
  for (const command of recipe.buildCommands) lines.push(`RUN ${command}`);
  lines.push(
    'RUN sha256sum -c /opt/managed/protected-runtime.sha256',
    'USER node',
    'WORKDIR /mnt/workspace',
    'EXPOSE 8080',
    'ENTRYPOINT ["node", "/opt/agentcore/http-server.js"]',
    'CMD []',
  );
  return `${lines.join('\n')}\n`;
};

const versionCommand = {
  node: ['node', '--version'],
  python: ['python3', '--version'],
  java: ['java', '-version'],
  go: ['go', 'version'],
  rust: ['rustc', '--version'],
  maven: ['mvn', '--version'],
  gradle: ['gradle', '--version'],
};

const verifyVersionLine = (name, spec) => {
  const [command, argument] = versionCommand[name];
  return `check_version ${quote(name)} ${quote(spec.version)} ${quote(command)} ${quote(argument)}`;
};

export const generateVerificationScript = (recipe) => {
  const checks = [
    ...Object.entries(recipe.tools).map(([name, spec]) => verifyVersionLine(name, spec)),
    ...Object.entries(recipe.buildTools).map(([name, spec]) => verifyVersionLine(name, spec)),
  ];
  const realBuilds = [];
  if (recipe.tools.node) {
    realBuilds.push(
      'docker exec "$container" sh -lc \'d=$(mktemp -d); cd "$d"; npm init -y >/dev/null; node -e "console.log(1 + 1)" | grep -qx 2\'',
    );
  }
  if (recipe.tools.python) {
    realBuilds.push(
      `docker exec -i "$container" sh -c 'd=/tmp/managed-environment-python; rm -rf "$d"; mkdir -p "$d"; cat > "$d/main.py"' <<'MANAGED_PYTHON'
print(1 + 1)
MANAGED_PYTHON
docker exec "$container" sh -lc 'd=/tmp/managed-environment-python; python3 -m py_compile "$d/main.py"; python3 "$d/main.py" | grep -qx 2'`,
    );
  }
  if (recipe.tools.java) {
    realBuilds.push(
      `docker exec -i "$container" sh -c 'd=/tmp/managed-environment-java; rm -rf "$d"; mkdir -p "$d"; cat > "$d/Main.java"' <<'MANAGED_JAVA'
class Main {
  public static void main(String[] args) {
    System.out.println(2);
  }
}
MANAGED_JAVA
docker exec "$container" sh -lc 'd=/tmp/managed-environment-java; javac "$d/Main.java"; java -cp "$d" Main | grep -qx 2'`,
    );
  }
  if (recipe.buildTools.maven) {
    realBuilds.push(
      `docker exec -i "$container" sh -c 'd=/tmp/managed-environment-maven; rm -rf "$d"; mkdir -p "$d"; cat > "$d/pom.xml"' <<'MANAGED_MAVEN'
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>managed.environment</groupId>
  <artifactId>verification</artifactId>
  <version>1</version>
</project>
MANAGED_MAVEN
docker exec "$container" sh -lc 'cd /tmp/managed-environment-maven; mvn -q -o validate'`,
    );
  }
  if (recipe.buildTools.gradle) {
    realBuilds.push(
      `docker exec -i "$container" sh -c 'd=/tmp/managed-environment-gradle; rm -rf "$d"; mkdir -p "$d"; cat > "$d/build.gradle"' <<'MANAGED_GRADLE'
tasks.register("verifyEnvironment")
MANAGED_GRADLE
docker exec "$container" sh -lc 'cd /tmp/managed-environment-gradle; gradle --offline -q verifyEnvironment'`,
    );
  }
  if (recipe.tools.go) {
    realBuilds.push(
      `docker exec -i "$container" sh -c 'd=/tmp/managed-environment-go; rm -rf "$d"; mkdir -p "$d"; cat > "$d/main.go"' <<'MANAGED_GO'
package main

import "fmt"

func main() {
  fmt.Println(2)
}
MANAGED_GO
docker exec "$container" sh -lc 'cd /tmp/managed-environment-go; go build -o app main.go; ./app | grep -qx 2'`,
    );
  }
  if (recipe.tools.rust) {
    realBuilds.push(
      'docker exec "$container" sh -lc \'d=$(mktemp -d); cd "$d"; cargo init --bin --name managed-environment-check -q; cargo build -q; ./target/debug/managed-environment-check >/dev/null\'',
    );
  }
  return `#!/usr/bin/env bash
set -Eeuo pipefail

image_ref="\${1:?image reference is required}"
container="managed-environment-check-\${CODEBUILD_BUILD_NUMBER:-local}"
base_container="\${container}-base"
protected_dir=""
cleanup() {
  if test -n "$container"; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  if test -n "$base_container"; then docker rm -f "$base_container" >/dev/null 2>&1 || true; fi
  if test -n "$protected_dir"; then rm -rf "$protected_dir"; fi
}
trap cleanup EXIT

arch="$(docker image inspect "$image_ref" --format '{{.Architecture}}')"
test "$arch" = "arm64"
user="$(docker image inspect "$image_ref" --format '{{.Config.User}}')"
test "$user" = "node"
entrypoint="$(docker image inspect "$image_ref" --format '{{json .Config.Entrypoint}}')"
test "$entrypoint" = '["node","/opt/agentcore/http-server.js"]'

docker run -d --name "$container" -p 18080:8080 "$image_ref" >/dev/null
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18080/ping | grep -q '"status":"Healthy'; then break; fi
  test "$attempt" -lt 30
  sleep 2
done
docker exec "$container" sh -lc 'test "$(id -u)" -ne 0 && test -w /mnt/workspace'
docker exec "$container" sh -lc 'sha256sum -c /opt/managed/protected-runtime.sha256'
docker exec "$container" node -e 'const fs=require("fs"); const doc=JSON.parse(fs.readFileSync("/opt/managed/sbom.spdx.json","utf8")); if (doc.spdxVersion !== "SPDX-2.3" || !Array.isArray(doc.packages)) process.exit(1)'

base_ref="$(jq -r '.base.imageUri + "@" + .base.imageDigest' manifest.json)"
docker create --name "$base_container" "$base_ref" >/dev/null
protected_dir="$(mktemp -d)"
for path in agentcore shared; do
  docker cp "$base_container:/opt/$path" "$protected_dir/base-$path"
  docker cp "$container:/opt/$path" "$protected_dir/built-$path"
  diff -qr --no-dereference "$protected_dir/base-$path" "$protected_dir/built-$path"
done

check_version() {
  name="$1"; expected="$2"; command="$3"; argument="$4"
  output="$(docker exec "$container" "$command" "$argument" 2>&1)"
  printf '%s' "$output" | grep -F "$expected" >/dev/null || {
    printf '%s version mismatch: expected %s, got %s\\n' "$name" "$expected" "$output" >&2
    return 1
  }
}

${checks.join('\n')}
${realBuilds.join('\n')}

docker stop "$container" >/dev/null
docker rm "$container" >/dev/null
container=""
printf '{"architecture":"PASS","baseDigest":"PASS","runtimeFiles":"PASS","nonRoot":"PASS","sbom":"PASS","startup":"PASS","workspace":"PASS","shutdown":"PASS","tools":"PASS","builds":"PASS"}\\n' > verification.json
`;
};

const INSTALL_ARCHIVE = `#!/usr/bin/env bash
set -Eeuo pipefail
url="$1"; algorithm="$2"; expected="$3"; destination="$4"; strip="$5"
archive="$(mktemp)"
extract_dir="$(mktemp -d)"
trap 'rm -f "$archive"; rm -rf "$extract_dir"' EXIT
curl -fsSL "$url" -o "$archive"
printf '%s  %s\\n' "$expected" "$archive" | "\${algorithm}sum" -c -
mkdir -p "$destination"
case "$url" in
  *.zip)
    unzip -q "$archive" -d "$extract_dir"
    source="$extract_dir"
    for _ in $(seq 1 "$strip"); do
      shopt -s nullglob dotglob
      entries=("$source"/*)
      test "\${#entries[@]}" -eq 1
      test -d "\${entries[0]}"
      source="\${entries[0]}"
    done
    cp -a "$source"/. "$destination"/
    ;;
  *.tar.gz|*.tgz) tar -xzf "$archive" -C "$destination" --strip-components="$strip";;
  *.tar.xz) tar -xJf "$archive" -C "$destination" --strip-components="$strip";;
  *) printf 'unsupported archive: %s\\n' "$url" >&2; exit 1;;
esac
`;

export const generateBuildContext = ({
  environment,
  revision,
  flattenedRecipe,
  generatedAt = new Date().toISOString(),
}) => {
  const resolvedRecipe = applyToolPrerequisites(flattenedRecipe);
  const dockerfile = generateDockerfile(resolvedRecipe);
  const manifest = {
    schemaVersion: RECIPE_SCHEMA_VERSION,
    environmentId: environment.environmentId,
    revisionId: revision.revisionId,
    generatedAt,
    runtimeCompatibilityVersion:
      revision.runtimeCompatibilityVersion ?? CURRENT_RUNTIME_COMPATIBILITY_VERSION,
    base: resolvedRecipe.base,
    recipe: resolvedRecipe,
  };
  const packages = [
    ...Object.entries(resolvedRecipe.tools).map(([name, spec]) => ({
      SPDXID: `SPDXRef-Tool-${name}`,
      name,
      versionInfo: spec.version,
      downloadLocation: spec.url ?? 'NOASSERTION',
      filesAnalyzed: false,
    })),
    ...Object.entries(resolvedRecipe.buildTools).map(([name, spec]) => ({
      SPDXID: `SPDXRef-BuildTool-${name}`,
      name,
      versionInfo: spec.version,
      downloadLocation: spec.url ?? 'NOASSERTION',
      filesAnalyzed: false,
    })),
    ...resolvedRecipe.aptPackages.map((pkg) => ({
      SPDXID: `SPDXRef-Apt-${pkg.name.replaceAll(/[^A-Za-z0-9.-]/g, '-')}`,
      name: pkg.name,
      versionInfo: pkg.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
    })),
  ];
  const sbom = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${environment.environmentId}-${revision.revisionId}`,
    documentNamespace: `https://managed-environments.local/${environment.environmentId}/${revision.revisionId}`,
    creationInfo: {
      created: generatedAt,
      creators: ['Tool: sample-collaborative-ai-dlc'],
    },
    packages,
  };
  const files = {
    Dockerfile: dockerfile,
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'sbom.spdx.json': `${JSON.stringify(sbom, null, 2)}\n`,
    'installers/install-archive.sh': INSTALL_ARCHIVE,
    'verification.sh': generateVerificationScript(resolvedRecipe),
  };
  const checksums = Object.fromEntries(
    Object.entries(files).map(([name, body]) => [
      name,
      createHash('sha256').update(body).digest('hex'),
    ]),
  );
  files['checksums.json'] = `${JSON.stringify(checksums, null, 2)}\n`;
  const contextChecksums = {
    ...checksums,
    'checksums.json': createHash('sha256').update(files['checksums.json']).digest('hex'),
  };
  files['checksums.sha256'] = `${Object.entries(contextChecksums)
    .map(([name, checksum]) => `${checksum}  ${name}`)
    .join('\n')}\n`;
  return { files, manifest, dockerfile, checksums: contextChecksums };
};

export const orderRebuilds = (environments) => {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const indegree = new Map(environments.map((environment) => [environment.environmentId, 0]));
  const children = new Map(environments.map((environment) => [environment.environmentId, []]));
  for (const environment of environments) {
    const parentId = environment.baseEnvironmentId;
    if (!parentId || !byId.has(parentId)) continue;
    indegree.set(environment.environmentId, indegree.get(environment.environmentId) + 1);
    children.get(parentId).push(environment.environmentId);
  }
  const ready = [...indegree.entries()]
    .filter(([, value]) => value === 0)
    .map(([id]) => id)
    .toSorted();
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const child of children.get(id).toSorted()) {
      const next = indegree.get(child) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
    ready.sort();
  }
  if (ordered.length !== environments.length) {
    throw new Error('Environment dependency cycle detected');
  }
  return ordered;
};

const TRANSITIONS = {
  DRAFT: new Set(['QUEUED', 'RETIRED']),
  QUEUED: new Set(['BUILDING', 'FAILED']),
  BUILDING: new Set(['SCANNING', 'FAILED']),
  SCANNING: new Set(['SECURITY_REVIEW', 'VERIFYING', 'FAILED']),
  SECURITY_REVIEW: new Set(['QUEUED', 'VERIFYING', 'FAILED', 'RETIRED']),
  VERIFYING: new Set(['READY', 'FAILED']),
  READY: new Set(['PUBLISHED', 'QUEUED', 'RETIRED']),
  PUBLISHED: new Set(['SUPERSEDED', 'RETIRED']),
  SUPERSEDED: new Set(['RETIRED']),
  FAILED: new Set(['QUEUED', 'SECURITY_REVIEW', 'RETIRED']),
  RETIRED: new Set(),
};

export const assertRevisionTransition = (from, to) => {
  if (!REVISION_STATUSES.includes(from) || !REVISION_STATUSES.includes(to)) {
    throw new Error(`Unknown revision status transition: ${from} -> ${to}`);
  }
  if (from === to) return;
  if (!TRANSITIONS[from].has(to)) {
    throw new Error(`Invalid revision status transition: ${from} -> ${to}`);
  }
};

export const evaluateScanFindings = (severityCounts = {}, findingsAccepted = false) => {
  const critical = Number(severityCounts.CRITICAL ?? 0);
  const high = Number(severityCounts.HIGH ?? 0);
  if ((critical > 0 || high > 0) && !findingsAccepted) {
    return { allowed: false, status: 'SECURITY_REVIEW', critical, high };
  }
  return { allowed: true, status: 'VERIFYING', critical, high };
};

export const normalizeEnvironmentId = (value) => {
  const collapsed = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const withoutLeadingSeparator = collapsed.startsWith('-') ? collapsed.slice(1) : collapsed;
  const withoutBoundarySeparators = withoutLeadingSeparator.endsWith('-')
    ? withoutLeadingSeparator.slice(0, -1)
    : withoutLeadingSeparator;
  const id = withoutBoundarySeparators.slice(0, 63);
  if (!ID_PATTERN.test(id))
    throw new Error('Environment id must contain lowercase letters and digits');
  return id;
};
