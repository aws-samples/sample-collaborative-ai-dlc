#!/usr/bin/env bash
# Phase B helper — drive + verify the deployed AgentCore Runtime against real
# Neptune/DynamoDB. Single-file so the terminal can't mangle pasted commands.
#
# Usage:
#   ./scripts/phaseb.sh outputs          # B0: terraform outputs + runtime state
#   ./scripts/phaseb.sh init-ws          # B1/B2: bootstrap an intent (reaches Neptune)
#   ./scripts/phaseb.sh state            # inspect the v2 execution rows in DynamoDB
#   ./scripts/phaseb.sh run-stage <id>   # B3: run one stage (default: intent-capture)
#   ./scripts/phaseb.sh neptune-hint     # how to query the Intent/Artifact graph
#
# Config via env (override as needed):
#   PROJECT_ID, INTENT_ID, EXEC_ID, SESSION_ID, REPO, BRANCH, BASE_BRANCH,
#   GIT_TOKEN, WORKFLOW_ID, WORKFLOW_VERSION, SCOPE
set -uo pipefail

TF_DIR="$(cd "$(dirname "$0")/../terraform" && pwd)"
cd "$TF_DIR"

# ── shared config (stable across steps so the same session/intent is reused) ──
PROJECT_ID="${PROJECT_ID:-p-test}"
INTENT_ID="${INTENT_ID:-i-test}"
EXEC_ID="${EXEC_ID:-e-test}"
SESSION_ID="${SESSION_ID:-aidlc-phaseb-session-0000000000001}"   # MUST be reused across init-ws + run-stage; AgentCore requires >=33 chars
REPO="${REPO:-}"
BRANCH="${BRANCH:-aidlc/$INTENT_ID}"
BASE_BRANCH="${BASE_BRANCH:-main}"
GIT_TOKEN="${GIT_TOKEN:-}"
WORKFLOW_ID="${WORKFLOW_ID:-aidlc-v2}"
WORKFLOW_VERSION="${WORKFLOW_VERSION:-1}"
SCOPE="${SCOPE:-feature}"

tfout() { terraform output -raw "$1" 2>/dev/null; }

RUNTIME_ARN="$(tfout agentcore_runtime_arn)"
TABLE="$(tfout v2_executions_table_name)"

invoke() { # $1 = json payload, $2 = out file
  # --payload is a blob; CLI v2 base64-decodes it by default, so pass
  # raw-in-base64-out to send our literal JSON. content-type tells the runtime
  # to parse it as JSON.
  aws bedrock-agentcore invoke-agent-runtime \
    --agent-runtime-arn "$RUNTIME_ARN" \
    --runtime-session-id "$SESSION_ID" \
    --content-type "application/json" \
    --accept "application/json" \
    --payload "$1" \
    --cli-binary-format raw-in-base64-out \
    "$2"
}

case "${1:-}" in
outputs)
  echo "=== terraform outputs ==="
  terraform output | grep -E "agentcore_runtime_arn|agentcore_image_uri|v2_executions_table_name|neptune_cluster_endpoint|seed_blocks_lambda_name"
  echo ""
  echo "=== runtime state (status + network mode) ==="
  RID="${RUNTIME_ARN##*/}"
  aws bedrock-agentcore-control get-agent-runtime \
    --agent-runtime-id "$RID" \
    --query '{status:status, networkMode:networkConfiguration.networkMode, net:networkConfiguration.networkModeConfig}' \
    --output json 2>&1 | head -40
  ;;

seed)
  LAMBDA="$(tfout seed_blocks_lambda_name)"
  echo "=== invoking seed-blocks lambda: $LAMBDA ==="
  aws lambda invoke --function-name "$LAMBDA" \
    --payload '{}' --cli-binary-format raw-in-base64-out /tmp/aidlc-seed.json
  echo "--- result ---"; cat /tmp/aidlc-seed.json; echo
  ;;

init-ws)
  [ -z "$REPO" ] && { echo "ERROR: set REPO=owner/repo (and GIT_TOKEN=...)"; exit 1; }
  PAYLOAD=$(cat <<JSON
{"command":"init-ws","projectId":"$PROJECT_ID","intentId":"$INTENT_ID","executionId":"$EXEC_ID","repos":["$REPO"],"branch":"$BRANCH","baseBranch":"$BASE_BRANCH","gitToken":"$GIT_TOKEN","title":"Phase B test intent","workflowId":"$WORKFLOW_ID","workflowVersion":$WORKFLOW_VERSION,"scope":"$SCOPE"}
JSON
)
  echo "=== init-ws (session=$SESSION_ID) ==="
  invoke "$PAYLOAD" /tmp/aidlc-initws.json
  echo "--- response ---"; cat /tmp/aidlc-initws.json; echo
  ;;

run-stage)
  STAGE_ID="${2:-intent-capture}"
  PAYLOAD=$(cat <<JSON
{"command":"run-stage","projectId":"$PROJECT_ID","intentId":"$INTENT_ID","executionId":"$EXEC_ID","stageId":"$STAGE_ID","workflowId":"$WORKFLOW_ID","workflowVersion":$WORKFLOW_VERSION,"scope":"$SCOPE"}
JSON
)
  echo "=== run-stage $STAGE_ID (session=$SESSION_ID) ==="
  invoke "$PAYLOAD" /tmp/aidlc-runstage.json
  echo "--- response ---"; cat /tmp/aidlc-runstage.json; echo
  ;;

state)
  echo "=== v2 execution rows (EXEC#$EXEC_ID) in $TABLE ==="
  aws dynamodb query --table-name "$TABLE" \
    --key-condition-expression "pk = :p" \
    --expression-attribute-values "{\":p\":{\"S\":\"EXEC#$EXEC_ID\"}}" \
    --query 'Items[].{sk:sk.S, state:state.S, status:status.S, stage:currentStage.S, type:type.S}' \
    --output table 2>&1 | head -60
  ;;

inspect)
  # Read-only Neptune verification THROUGH the VPC-attached runtime (the only
  # thing that can reach private Neptune). $2 = optional artifactType filter.
  ATYPE="${2:-}"
  PAYLOAD=$(cat <<JSON
{"command":"inspect","intentId":"$INTENT_ID"${ATYPE:+,\"artifactType\":\"$ATYPE\"}}
JSON
)
  echo "=== inspect intent $INTENT_ID (Neptune read via runtime) ==="
  invoke "$PAYLOAD" /tmp/aidlc-inspect.json
  echo "--- response ---"; cat /tmp/aidlc-inspect.json; echo
  ;;

neptune-hint)
  cat <<TXT
Neptune is private — query the Intent subgraph from inside the VPC (app, a
bastion, or a Neptune workbench notebook). Gremlin:
  g.V().has('Intent','id','$INTENT_ID').out('CONTAINS').hasLabel('Artifact').valueMap(true)
Expect an Artifact vertex with artifact_type, provenance (project_id, intent_id,
created_by_execution_id, created_by_stage_instance_id, created_at) and content.
TXT
  ;;

*)
  echo "usage: $0 {outputs|seed|init-ws|run-stage [stageId]|state|inspect [artifactType]|neptune-hint}"
  exit 1
  ;;
esac
