#!/usr/bin/env bash
# Local, credentialed AgentCore lifecycle E2E. Runs Claude, Kiro, and OpenCode
# sequentially against DynamoDB Local + Gremlin Server with cold-container
# park/resume recovery. This script never contacts a deployed stack.
#
# Usage:
#   BEDROCK_API_KEY=... KIRO_API_KEY=... ./scripts/agent-e2e-testing.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AWS_REGION="${AWS_REGION:-us-east-1}"
BEDROCK_MODEL="${BEDROCK_MODEL:-us.anthropic.claude-sonnet-4-6}"
KIRO_MODEL="${KIRO_MODEL:-auto}"
E2E_CLIS="${E2E_CLIS:-claude,kiro,opencode}"
KEEP_E2E="${KEEP_E2E:-0}"
BEDROCK_TOKEN="${BEDROCK_API_KEY:-${AWS_BEARER_TOKEN_BEDROCK:-}}"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
LABEL="aidlc.e2e=$RUN_ID"
NETWORK="aidlc-e2e-$RUN_ID"
DDB_CONTAINER="aidlc-e2e-ddb-$RUN_ID"
GREMLIN_CONTAINER="aidlc-e2e-gremlin-$RUN_ID"
LOG_DIR="${TMPDIR:-/tmp}/aidlc-e2e-$RUN_ID"
OUTPUT_DIR="${E2E_OUTPUT_DIR:-$ROOT/test/e2e/artifacts/agent-output/$RUN_ID}"
SECRET_FILE=""
OVERALL_FAIL=0
IMAGE=""
DOCKER_PROXY_VARIABLES="HTTP_PROXY HTTPS_PROXY FTP_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy ftp_proxy no_proxy all_proxy"

declare -a SELECTED_CLIS=()
SELECTED_CLI_COUNT=0
CLAUDE_RESULT="SKIPPED"
KIRO_RESULT="SKIPPED"
OPENCODE_RESULT="SKIPPED"

log() { printf '\n== %s ==\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cleanup_resources() {
  local id
  # The secret is always deleted, including KEEP_E2E failures.
  if [ -n "$SECRET_FILE" ]; then
    rm -f "$SECRET_FILE"
    SECRET_FILE=""
  fi
  if [ "$KEEP_E2E" = "1" ] && [ "$OVERALL_FAIL" -ne 0 ]; then
    printf '\nRetained failed E2E resources (label %s) and logs at %s\n' "$LABEL" "$LOG_DIR"
    return
  fi
  while IFS= read -r id; do
    [ -n "$id" ] && docker rm -f "$id" >/dev/null 2>&1 || true
  done < <(docker ps -aq --filter "label=$LABEL" 2>/dev/null)
  while IFS= read -r id; do
    [ -n "$id" ] && docker volume rm -f "$id" >/dev/null 2>&1 || true
  done < <(docker volume ls -q --filter "label=$LABEL" 2>/dev/null)
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$LOG_DIR"
}
trap cleanup_resources EXIT INT TERM

parse_clis() {
  local raw cli existing duplicate
  IFS=',' read -r -a raw <<<"$E2E_CLIS"
  for cli in "${raw[@]}"; do
    cli="${cli//[[:space:]]/}"
    [ -n "$cli" ] || continue
    case "$cli" in
      claude|kiro|opencode) ;;
      *) fail "E2E_CLIS contains unsupported CLI '$cli'" ;;
    esac
    duplicate=0
    # macOS Bash 3.2 treats an empty declared array as unbound under `set -u`.
    if [ "$SELECTED_CLI_COUNT" -gt 0 ]; then
      for existing in "${SELECTED_CLIS[@]}"; do
        [ "$existing" = "$cli" ] && duplicate=1
      done
    fi
    if [ "$duplicate" -eq 0 ]; then
      SELECTED_CLIS+=("$cli")
      SELECTED_CLI_COUNT=$((SELECTED_CLI_COUNT + 1))
    fi
  done
  [ "$SELECTED_CLI_COUNT" -gt 0 ] || fail "E2E_CLIS selected no CLIs"
}

is_selected() {
  local wanted="$1" selected
  for selected in "${SELECTED_CLIS[@]}"; do
    [ "$selected" = "$wanted" ] && return 0
  done
  return 1
}

set_result() {
  case "$1" in
    claude) CLAUDE_RESULT="$2" ;;
    kiro) KIRO_RESULT="$2" ;;
    opencode) OPENCODE_RESULT="$2" ;;
  esac
}

preflight() {
  local proxy_name
  local -a outbound_check=(docker run --rm --platform linux/arm64)

  log "Preflight"
  command -v docker >/dev/null 2>&1 || fail "docker is required"
  command -v node >/dev/null 2>&1 || fail "node is required"
  docker info >/dev/null 2>&1 || fail "Docker daemon is not available"
  docker buildx version >/dev/null 2>&1 || fail "Docker Buildx is required"
  [[ "$BEDROCK_MODEL" =~ ^[^[:space:]/]+$ ]] ||
    fail "BEDROCK_MODEL must be a bare Bedrock model/profile id"
  [ -n "$KIRO_MODEL" ] || fail "KIRO_MODEL must not be empty"
  if is_selected claude || is_selected opencode; then
    [ -n "$BEDROCK_TOKEN" ] ||
      fail "BEDROCK_API_KEY (or AWS_BEARER_TOKEN_BEDROCK) is required"
  fi
  if is_selected kiro; then
    [ -n "${KIRO_API_KEY:-}" ] || fail "KIRO_API_KEY is required"
  fi

  docker run --rm --platform linux/arm64 alpine:3.20 true >/dev/null 2>&1 ||
    fail "Docker cannot execute linux/arm64 containers"

  for proxy_name in $DOCKER_PROXY_VARIABLES; do
    [ -n "${!proxy_name:-}" ] && outbound_check+=(--env "$proxy_name")
  done
  outbound_check+=(curlimages/curl:8.12.1)
  "${outbound_check[@]}" \
    -fsS --connect-timeout 10 --max-time 20 -o /dev/null https://aws.amazon.com/ ||
    fail "containers do not have outbound HTTPS access"
  printf 'Preflight passed for %s\n' "${SELECTED_CLIS[*]}"
  mkdir -p "$OUTPUT_DIR"
}

build_image() {
  local proxy_name
  local -a build_command=(docker buildx build)

  log "AgentCore image"
  if [ -n "${AGENTCORE_IMAGE:-}" ]; then
    IMAGE="$AGENTCORE_IMAGE"
    docker image inspect "$IMAGE" >/dev/null 2>&1 ||
      fail "AGENTCORE_IMAGE '$IMAGE' is not present locally"
    printf 'Using %s\n' "$IMAGE"
    return
  fi
  IMAGE="aidlc-agentcore-e2e:$RUN_ID"
  for proxy_name in $DOCKER_PROXY_VARIABLES; do
    [ -n "${!proxy_name:-}" ] && build_command+=(--build-arg "$proxy_name")
  done
  build_command+=(
    --platform linux/arm64
    --load
    --tag "$IMAGE"
    --file "$ROOT/lambda/agentcore/Dockerfile"
    "$ROOT/lambda"
  )
  "${build_command[@]}"
}

write_secret_file() {
  umask 077
  SECRET_FILE="$(mktemp "${TMPDIR:-/tmp}/aidlc-e2e-secrets.XXXXXX")"
  {
    printf 'AWS_BEARER_TOKEN_BEDROCK=%s\n' "$BEDROCK_TOKEN"
    printf 'KIRO_API_KEY=%s\n' "${KIRO_API_KEY:-}"
  } >"$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
}

container_args() {
  local proxy_name

  printf '%s\n' \
    --platform linux/arm64 \
    --label "$LABEL" \
    --network "$NETWORK" \
    --env "AWS_REGION=$AWS_REGION" \
    --env "AWS_ACCESS_KEY_ID=localinert" \
    --env "AWS_SECRET_ACCESS_KEY=localinert" \
    --env "AWS_ENDPOINT_URL_DYNAMODB=http://dynamodb:8000" \
    --env "DYNAMODB_LOCAL_ENDPOINT=http://dynamodb:8000" \
    --env "V2_PROCESS_TABLE=aidlc-local-e2e" \
    --env "NEPTUNE_ENDPOINT=gremlin" \
    --env "GREMLIN_PORT=8182" \
    --env "GREMLIN_PROTOCOL=ws" \
    --env "BEDROCK_MODEL=$BEDROCK_MODEL" \
    --env "KIRO_MODEL=$KIRO_MODEL" \
    --env "V2_QUESTION_POLL_MS=100" \
    --env "V2_QUESTION_PARK_GRACE_MS=300" \
    --env "E2E_SECRET_FILE=/run/secrets/aidlc-e2e.env" \
    --volume "$SECRET_FILE:/run/secrets/aidlc-e2e.env:ro"
  for proxy_name in $DOCKER_PROXY_VARIABLES; do
    [ -n "${!proxy_name:-}" ] && printf '%s\n' --env "$proxy_name"
  done
}

start_services() {
  log "Local dependencies"
  mkdir -p "$LOG_DIR"
  docker network create --label "$LABEL" "$NETWORK" >/dev/null
  docker run -d \
    --platform linux/arm64 \
    --name "$DDB_CONTAINER" \
    --label "$LABEL" \
    --network "$NETWORK" \
    --network-alias dynamodb \
    amazon/dynamodb-local:2.5.2 \
    -jar DynamoDBLocal.jar -inMemory -sharedDb >/dev/null
  docker run -d \
    --platform linux/arm64 \
    --name "$GREMLIN_CONTAINER" \
    --label "$LABEL" \
    --network "$NETWORK" \
    --network-alias gremlin \
    tinkerpop/gremlin-server:3.7.3 >/dev/null

  local ready=0 attempt
  for attempt in $(seq 1 60); do
    if docker logs "$GREMLIN_CONTAINER" 2>&1 | grep -q 'Channel started at port 8182'; then
      ready=1
      break
    fi
    sleep 1
  done
  [ "$ready" -eq 1 ] || fail "Gremlin Server did not become ready"

  local -a args=()
  while IFS= read -r arg; do args+=("$arg"); done < <(container_args)
  ready=0
  for attempt in $(seq 1 30); do
    if docker run --rm "${args[@]}" --entrypoint node "$IMAGE" \
      /opt/agentcore/test/local-e2e-harness.mjs bootstrap >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  [ "$ready" -eq 1 ] || fail "DynamoDB Local did not become ready"
  printf 'DynamoDB Local and Gremlin Server are ready\n'
}

run_harness() {
  local cli="$1" action="$2" volume="$3"
  local name="aidlc-e2e-${cli}-${action}-${RUN_ID}"
  local logfile="$LOG_DIR/${cli}-${action}.log"
  local -a args=()
  while IFS= read -r arg; do args+=("$arg"); done < <(container_args)
  docker run \
    --name "$name" \
    "${args[@]}" \
    --volume "$volume:/mnt/workspace" \
    --entrypoint node \
    "$IMAGE" \
    /opt/agentcore/test/local-e2e-harness.mjs "$action" "$cli"
  local rc=$?
  docker logs "$name" >"$logfile" 2>&1 || true
  if [ "$rc" -eq 0 ]; then
    docker rm "$name" >/dev/null 2>&1 || true
  fi
  return "$rc"
}

run_cli() {
  local cli="$1"
  local volume="aidlc-e2e-${cli}-${RUN_ID}"
  local action failed=0 setup_ok=0
  docker volume create --label "$LABEL" "$volume" >/dev/null
  log "$cli lifecycle"

  for action in setup fresh answer resume verify; do
    if ! run_harness "$cli" "$action" "$volume"; then
      printf '%s failed during %s\n' "$cli" "$action" >&2
      failed=1
      break
    fi
    [ "$action" = "setup" ] && setup_ok=1
  done

  if [ "$setup_ok" -eq 1 ]; then
    if ! run_harness "$cli" report "$volume" >"$OUTPUT_DIR/$cli.json"; then
      printf '%s output report could not be written\n' "$cli" >&2
      failed=1
    fi
  fi

  if [ "$failed" -eq 0 ]; then
    set_result "$cli" "PASS"
  else
    set_result "$cli" "FAIL"
    OVERALL_FAIL=1
  fi

  # A retained failure keeps its table/graph fixture and volume for inspection.
  if ! { [ "$failed" -eq 1 ] && [ "$KEEP_E2E" = "1" ]; }; then
    if [ "$setup_ok" -eq 1 ]; then
      run_harness "$cli" cleanup "$volume" >/dev/null 2>&1 || true
    fi
    docker volume rm -f "$volume" >/dev/null 2>&1 || true
  fi
}

print_summary() {
  printf '\nClaude:   %s\n' "$CLAUDE_RESULT"
  printf 'Kiro:     %s\n' "$KIRO_RESULT"
  printf 'OpenCode: %s\n' "$OPENCODE_RESULT"
}

parse_clis
preflight
build_image
write_secret_file
start_services

for cli in "${SELECTED_CLIS[@]}"; do
  run_cli "$cli"
done

print_summary
if ! node "$ROOT/scripts/generate-agent-output-fixtures.mjs" --reports "$OUTPUT_DIR" >/dev/null; then
  printf 'WARNING: local agent output preview fixture generation failed\n' >&2
fi
printf 'Output reports: %s\n' "$OUTPUT_DIR"
exit "$OVERALL_FAIL"
