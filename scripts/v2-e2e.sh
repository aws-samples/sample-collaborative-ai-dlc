#!/usr/bin/env bash
# v2 end-to-end harness — drives the PRODUCT path (intents REST API + durable
# orchestrator) against a DEPLOYED stack and ASSERTS each lifecycle transition.
# Unlike scripts/phaseb.sh (which pokes the raw AgentCore runtime), this exercises
# the seam a user hits: create v2 project → create intent → start → park on a
# human gate → answer → resume → succeed → cleanup. Non-zero exit on any failure.
#
# This is NOT a PR gate (it needs AWS creds + Bedrock + a live agent). Run it
# locally or via the nightly v2-e2e.yml workflow.
#
# Required env:
#   API_BASE_URL    e.g. https://abc123.execute-api.us-east-1.amazonaws.com/prod
#                   (terraform output -raw api_gateway_url)
#   E2E_ID_TOKEN    a Cognito ID token for a user who is a project member
#   REPO            owner/repo to attach to the v2 project (a real, clonable repo)
# Optional env:
#   AWS_REGION (default us-east-1), WORKFLOW_ID (default aidlc-v2),
#   SCOPE (default feature), GIT_TOKEN (clone cred passed at project create),
#   POLL_TIMEOUT_SECS (default 900), GATE_ANSWER (free text)
set -uo pipefail

API="${API_BASE_URL:?set API_BASE_URL (terraform output api_gateway_url)}"
TOKEN="${E2E_ID_TOKEN:?set E2E_ID_TOKEN (a Cognito ID token)}"
REPO="${REPO:?set REPO=owner/repo}"
REGION="${AWS_REGION:-us-east-1}"
WORKFLOW_ID="${WORKFLOW_ID:-aidlc-v2}"
SCOPE="${SCOPE:-feature}"
GIT_TOKEN="${GIT_TOKEN:-}"
POLL_TIMEOUT_SECS="${POLL_TIMEOUT_SECS:-900}"
GATE_ANSWER="${GATE_ANSWER:-Proceed with the MVP scope as described.}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$ROOT/terraform"
TABLE="$(cd "$TF_DIR" && terraform output -raw v2_executions_table_name 2>/dev/null)"
[ -z "$TABLE" ] && { echo "FATAL: could not read v2_executions_table_name from terraform output"; exit 1; }

PROJECT_ID=""
INTENT_ID=""
PASS=0
FAIL=0

log()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓ %s\033[0m\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗ %s\033[0m\n' "$*"; FAIL=$((FAIL+1)); }
die()  { printf '\n\033[31mFATAL: %s\033[0m\n' "$*"; cleanup; exit 1; }

# curl helper: $1=method $2=path [$3=json body]. Captures body + status code.
api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -w '\n%{http_code}' -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -w '\n%{http_code}' -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN"
  fi
}
body_of()   { sed '$d' <<<"$1"; }
status_of() { tail -n1 <<<"$1"; }

# Read a single attribute from the META row of the current intent's execution.
meta_attr() {
  aws dynamodb get-item --region "$REGION" --table-name "$TABLE" \
    --key "{\"pk\":{\"S\":\"EXEC#$INTENT_ID\"},\"sk\":{\"S\":\"META\"}}" \
    --query "Item.$1.S" --output text 2>/dev/null
}

cleanup() {
  log "Cleanup"
  if [ -n "$INTENT_ID" ]; then
    INTENT_ID="$INTENT_ID" "$ROOT/scripts/phaseb.sh" drop-intent >/dev/null 2>&1 \
      && ok "dropped intent subgraph" || echo "  (drop-intent skipped/failed)"
  fi
  if [ -n "$PROJECT_ID" ]; then
    local r; r="$(api DELETE "/projects/$PROJECT_ID")"
    [ "$(status_of "$r")" = "200" ] || [ "$(status_of "$r")" = "204" ] \
      && ok "deleted test project" || echo "  (project delete returned $(status_of "$r"))"
  fi
}
trap cleanup EXIT

# ── 1. Create a v2 project ──
log "1. Create v2 project"
CREATE_BODY=$(cat <<JSON
{"name":"v2-e2e-$(date +%s)","gitProvider":"github","gitRepo":"$REPO",
 "kind":"v2","workflowId":"$WORKFLOW_ID","scope":"$SCOPE","parkReleaseSeconds":300
 ${GIT_TOKEN:+,"gitToken":"$GIT_TOKEN"}}
JSON
)
R=$(api POST "/projects" "$CREATE_BODY")
[ "$(status_of "$R")" = "201" ] || die "create project: HTTP $(status_of "$R") $(body_of "$R")"
PROJECT_ID=$(body_of "$R" | jq -r '.id')
KIND=$(body_of "$R" | jq -r '.kind')
[ "$KIND" = "v2" ] && ok "project kind=v2 ($PROJECT_ID)" || bad "expected kind=v2, got $KIND"

# ── 2. Create an intent (DRAFT) ──
log "2. Create intent"
R=$(api POST "/projects/$PROJECT_ID/intents" \
  '{"title":"E2E intent","prompt":"Build a minimal URL shortener (MVP)."}')
[ "$(status_of "$R")" = "201" ] || die "create intent: HTTP $(status_of "$R") $(body_of "$R")"
INTENT_ID=$(body_of "$R" | jq -r '.id')
STATUS=$(body_of "$R" | jq -r '.status')
[ "$STATUS" = "DRAFT" ] && ok "intent DRAFT ($INTENT_ID)" || bad "expected DRAFT, got $STATUS"
[ "$(body_of "$R" | jq -r '.workflowVersion')" != "null" ] \
  && ok "workflow version pinned at create" || bad "workflow version not pinned"

# ── 3. Start ──
log "3. Start the intent"
R=$(api POST "/projects/$PROJECT_ID/intents/$INTENT_ID/start")
[ "$(status_of "$R")" = "202" ] || die "start: HTTP $(status_of "$R") $(body_of "$R")"
ok "start accepted (202)"

# Poll the v2 table for the run to reach RUNNING (orchestrator ran init-ws +
# marked the first stage) or to park on a gate.
log "4. Wait for RUNNING / first gate"
deadline=$(( $(date +%s) + POLL_TIMEOUT_SECS ))
state=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  state="$(meta_attr status)"
  pending="$(meta_attr pendingHumanTaskId)"
  [ "$state" = "RUNNING" ] && [ -n "$pending" ] && [ "$pending" != "None" ] && break
  [ "$state" = "SUCCEEDED" ] || [ "$state" = "FAILED" ] && break
  sleep 5
done
[ "$state" = "RUNNING" ] || [ "$state" = "SUCCEEDED" ] \
  && ok "execution reached $state" || bad "execution stuck at '$state'"

# Verify init-ws created the Neptune Intent anchor (read THROUGH the runtime).
if INTENT_ID="$INTENT_ID" "$ROOT/scripts/phaseb.sh" inspect >/tmp/v2e2e-inspect.json 2>&1 \
   && grep -q '"ok": *true' /tmp/v2e2e-inspect.json; then
  ok "Neptune Intent anchor present (inspect ok)"
else
  bad "inspect did not confirm the Intent anchor"
fi

# ── 5. Answer the gate (if parked) and confirm resume ──
PENDING="$(meta_attr pendingHumanTaskId)"
if [ -n "$PENDING" ] && [ "$PENDING" != "None" ]; then
  log "5. Answer gate $PENDING and resume"
  R=$(api POST "/projects/$PROJECT_ID/intents/$INTENT_ID/gates/$PENDING/answer" \
    "{\"answer\":{\"freeText\":\"$GATE_ANSWER\"}}")
  [ "$(status_of "$R")" = "200" ] && ok "gate answered (200)" \
    || bad "answer gate: HTTP $(status_of "$R") $(body_of "$R")"
  # A second answer of the same gate must be rejected (CAS).
  R2=$(api POST "/projects/$PROJECT_ID/intents/$INTENT_ID/gates/$PENDING/answer" \
    "{\"answer\":{\"freeText\":\"again\"}}")
  [ "$(status_of "$R2")" = "409" ] && ok "double-answer rejected (409, CAS)" \
    || bad "expected 409 on double-answer, got $(status_of "$R2")"
else
  log "5. (No gate parked — stage did not ask a question; skipping answer asserts)"
fi

# ── 6. Wait for terminal SUCCEEDED ──
log "6. Wait for terminal state"
deadline=$(( $(date +%s) + POLL_TIMEOUT_SECS ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  state="$(meta_attr status)"
  { [ "$state" = "SUCCEEDED" ] || [ "$state" = "FAILED" ]; } && break
  # If it parked again, answer the new gate and keep waiting (D3 multi-gate).
  PENDING="$(meta_attr pendingHumanTaskId)"
  if [ "$state" = "WAITING" ] && [ -n "$PENDING" ] && [ "$PENDING" != "None" ]; then
    api POST "/projects/$PROJECT_ID/intents/$INTENT_ID/gates/$PENDING/answer" \
      "{\"answer\":{\"freeText\":\"$GATE_ANSWER\"}}" >/dev/null 2>&1
  fi
  sleep 5
done
[ "$state" = "SUCCEEDED" ] && ok "execution SUCCEEDED" || bad "execution ended '$state' (not SUCCEEDED)"

# Assert at least one artifact landed in Neptune.
if INTENT_ID="$INTENT_ID" "$ROOT/scripts/phaseb.sh" inspect >/tmp/v2e2e-inspect2.json 2>&1; then
  COUNT=$(jq -r '.artifactCount // 0' /tmp/v2e2e-inspect2.json 2>/dev/null || echo 0)
  [ "${COUNT:-0}" -gt 0 ] && ok "produced $COUNT artifact(s)" || bad "no artifacts produced"
fi

# ── Summary ──
log "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
