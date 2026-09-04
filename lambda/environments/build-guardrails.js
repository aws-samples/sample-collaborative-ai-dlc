// Single source of truth for the guardrails every managed-build authoring path
// shares: the secret/protected-variable/forbidden-command denylists, and the
// Dockerfile and verification-script primitives that establish the protected
// runtime boundary.
//
// Both recipe engines (fixed-tool, catalog) and the tool catalog import from
// here. Keep it that way: these are security controls, and a hardening applied
// to one private copy would silently leave the other authoring paths open.

// Variable names and literal values that look like credentials, so a recipe
// cannot bake a secret into an image layer, an ENV line, or a build command.
export const SECRET_NAME = /(secret|password|passwd|token|credential|private[_-]?key|api[_-]?key)/i;
export const SECRET_VALUE =
  /(-----BEGIN [A-Z ]+PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,})/;
export const SECRET_COMMAND =
  /(?:^|\s)(?:export\s+)?[A-Za-z0-9_]*(?:secret|password|passwd|token|credential|private[_-]?key|api[_-]?key)[A-Za-z0-9_]*\s*=|(?:^|\s)--?[A-Za-z0-9_-]*(?:secret|password|passwd|token|credential|private-key|api-key)[A-Za-z0-9_-]*(?:=|\s)/i;

// Variables the platform owns: a recipe may not set or shadow these, because
// they carry runtime identity, credential brokering, and loader configuration.
export const PROTECTED_VARIABLE_NAME =
  /^(AWS_|AIDLC_|AGENTCORE_|BEDROCK_|V2_|MCP_|CREDENTIAL_BROKER_|SOURCE_CONTROL_|CLAUDE_|KIRO_|OPENCODE_|CODEX_|XDG_|LD_|PATH$|HOME$|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|SHELLOPTS$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|RUNTIME_COMPATIBILITY_VERSION$)/;

// Build-command shapes that would rewrite the image contract or reach into the
// protected trees.
export const FORBIDDEN_COMMAND =
  /(^|\s)(from|entrypoint|cmd|user|expose|sudo|su|rm|mv|cp|ln|chmod|chown)\b|\/opt\/(agentcore|shared|managed)|\/mnt\/workspace|docker\s|podman\s|curl\b[^|]*\|\s*(sh|bash)|wget\b[^|]*\|\s*(sh|bash)/i;

// Trees copied from the pinned base image that an environment build must leave
// byte-identical.
export const PROTECTED_RUNTIME_PATHS = ['agentcore', 'shared'];
export const PROTECTED_RUNTIME_MANIFEST = '/opt/managed/protected-runtime.sha256';
const MANIFEST_STAGE = 'protected_runtime_manifest';
const STAGE_MANIFEST_PATH = '/tmp/protected-runtime.sha256';

// Trust model for the protected runtime, in one place.
//
// Administrator-authored build commands run as root, so FORBIDDEN_COMMAND is a
// guardrail against mistakes, not a sandbox against a determined admin. Two
// things the build stage cannot reach carry the actual integrity guarantee:
//
//  1. The manifest is computed in a separate build stage straight from the
//     pinned base digest and COPYed in *after* the administrator commands, so a
//     root RUN cannot regenerate the list it is later checked against.
//  2. verification.sh re-derives the comparison outside the build entirely,
//     diffing the protected trees in the built image against the same pinned
//     base. That step is load-bearing and must stay unconditional.
export const PROTECTED_RUNTIME_TRUST_MODEL =
  'Administrator build commands run as root; integrity rests on the out-of-stage manifest and the out-of-image base diff in verification.sh.';

/**
 * Build stage that records the protected-file manifest directly from the pinned
 * base image. Deliberately a separate stage: the environment stage runs
 * administrator commands as root, and anything it can write it can also forge.
 */
export const protectedManifestStageLines = (baseRef) => [
  `FROM ${baseRef} AS ${MANIFEST_STAGE}`,
  'USER root',
  `RUN find ${PROTECTED_RUNTIME_PATHS.map((path) => `/opt/${path}`).join(
    ' ',
  )} -type f -print0 | sort -z | xargs -0 sha256sum > ${STAGE_MANIFEST_PATH}`,
];

/**
 * Trailing Dockerfile lines, emitted after the administrator build commands:
 * bring in the manifest the build could not touch, verify the protected trees
 * against it, then drop back to the non-root runtime user and restore the image
 * contract AgentCore requires.
 */
export const protectedRuntimeEpilogueLines = () => [
  `COPY --from=${MANIFEST_STAGE} ${STAGE_MANIFEST_PATH} ${PROTECTED_RUNTIME_MANIFEST}`,
  `RUN sha256sum -c ${PROTECTED_RUNTIME_MANIFEST}`,
  'USER node',
  'WORKDIR /mnt/workspace',
  'EXPOSE 8080',
  'ENTRYPOINT ["node", "/opt/agentcore/http-server.js"]',
  'CMD []',
];

/**
 * Verification-script prologue: image contract, startup health, non-root
 * workspace, in-image manifest check, SBOM shape, and the diff of the protected
 * trees against the pinned base image.
 */
export const verificationPrologue = () => `#!/usr/bin/env bash
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
docker exec "$container" sh -lc 'sha256sum -c ${PROTECTED_RUNTIME_MANIFEST}'
docker exec "$container" node -e 'const fs=require("fs"); const doc=JSON.parse(fs.readFileSync("/opt/managed/sbom.spdx.json","utf8")); if (doc.spdxVersion !== "SPDX-2.3" || !Array.isArray(doc.packages)) process.exit(1)'

base_ref="$(jq -r '.base.imageUri + "@" + .base.imageDigest' manifest.json)"
docker create --name "$base_container" "$base_ref" >/dev/null
protected_dir="$(mktemp -d)"
for path in ${PROTECTED_RUNTIME_PATHS.join(' ')}; do
  docker cp "$base_container:/opt/$path" "$protected_dir/base-$path"
  docker cp "$container:/opt/$path" "$protected_dir/built-$path"
  diff -qr --no-dereference "$protected_dir/base-$path" "$protected_dir/built-$path"
done
`;

/**
 * Verification-script epilogue: clean shutdown plus the evidence document the
 * build lifecycle reads back.
 */
export const verificationEpilogue = () => `
docker stop "$container" >/dev/null
docker rm "$container" >/dev/null
container=""
printf '{"architecture":"PASS","baseDigest":"PASS","runtimeFiles":"PASS","nonRoot":"PASS","sbom":"PASS","startup":"PASS","workspace":"PASS","shutdown":"PASS","tools":"PASS","builds":"PASS"}\\n' > verification.json
`;
