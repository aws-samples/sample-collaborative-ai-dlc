#!/usr/bin/env bash
set -euo pipefail
umask 077
export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"
ENVIRONMENT="dev"
ASSUME_YES="${AIDLC_YES:-0}"

if [[ $# -gt 0 && "$1" != --* ]]; then
    ENVIRONMENT="$1"
    shift
fi
while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes)
            ASSUME_YES=1
            shift
            ;;
        *)
            echo "Usage: $0 [environment] [--yes]" >&2
            exit 2
            ;;
    esac
done

CONFIG_TF_DIR="${AIDLC_CONFIG_DIR:-$TF_DIR}"
TFVARS_FILE="${AIDLC_TFVARS_FILE:-$CONFIG_TF_DIR/environments/${ENVIRONMENT}.tfvars}"
BACKEND_FILE="${AIDLC_BACKEND_FILE:-$CONFIG_TF_DIR/environments/${ENVIRONMENT}.s3.tfbackend}"
BACKUP_DIR="${AIDLC_BACKUP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/collaborative-ai-dlc/backups}"

if [[ ! -f "$TFVARS_FILE" ]]; then
    echo "Error: Terraform variables file not found: $TFVARS_FILE" >&2
    exit 1
fi
if [[ ! -f "$BACKEND_FILE" ]]; then
    echo "Error: Terraform backend file not found: $BACKEND_FILE" >&2
    exit 1
fi

# Terraform parses these arguments independently, including shell-style quoting.
# Ignore command-specific overrides so console, plan, and destroy use one input
# set without attempting to reproduce Terraform's argument parser.
unset TF_CLI_ARGS_console TF_CLI_ARGS_plan TF_CLI_ARGS_destroy

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aidlc-destroy.XXXXXX")"
cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "Initializing Terraform for environment: $ENVIRONMENT"
terraform -chdir="$TF_DIR" init -reconfigure -backend-config="$BACKEND_FILE"

if ! EFFECTIVE_ENVIRONMENT_IS_PROD="$(
    printf '%s\n' 'var.environment == "prod"' |
        terraform -chdir="$TF_DIR" console \
            -var-file="$TFVARS_FILE" \
            -var="deletion_protection=false" \
            2>"$TEMP_DIR/console.stderr"
)"; then
    echo "Error: Terraform could not resolve the effective environment using the teardown inputs." >&2
    cat "$TEMP_DIR/console.stderr" >&2
    exit 1
fi
if [[ "$EFFECTIVE_ENVIRONMENT_IS_PROD" != "true" && "$EFFECTIVE_ENVIRONMENT_IS_PROD" != "false" ]]; then
    echo "Error: Terraform returned an unexpected result while resolving the effective environment." >&2
    exit 1
fi
if [[ "$ENVIRONMENT" == "prod" || "$EFFECTIVE_ENVIRONMENT_IS_PROD" == "true" ]]; then
    echo "Refusing automated destruction of a production environment." >&2
    echo "Use the documented production break-glass procedure with independently reviewed backups and plans." >&2
    exit 1
fi

if [[ "$ASSUME_YES" != 1 ]]; then
    if [[ ! -t 0 ]]; then
        echo "Destruction requires an interactive terminal or --yes." >&2
        exit 1
    fi
    echo "WARNING: This permanently destroys all AI-DLC resources and application data"
    echo "for environment '$ENVIRONMENT'. The Terraform state bucket is retained."
    read -r -p "Type the environment name '$ENVIRONMENT' to continue: " confirmation
    if [[ "$confirmation" != "$ENVIRONMENT" ]]; then
        echo "Destruction aborted."
        exit 0
    fi
fi

mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/terraform-${ENVIRONMENT}-pre-destroy-$(date -u +%Y%m%dT%H%M%SZ).tfstate"
terraform -chdir="$TF_DIR" state pull > "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
echo "Terraform state backup: $BACKUP_FILE"

echo "Disabling deletion protection for the confirmed teardown"
# terraform-hardening.test.mjs cross-checks this list against every protected
# table and cluster so a newly protected resource cannot silently drift.
PROTECTION_TARGETS=(
    -target=module.neptune.aws_neptune_cluster.main
    -target=module.dynamodb.aws_dynamodb_table.sessions
    -target=module.dynamodb.aws_dynamodb_table.notifications
    -target=module.dynamodb.aws_dynamodb_table.agent_questions
    -target=module.dynamodb.aws_dynamodb_table.agent_outputs
    -target=module.dynamodb.aws_dynamodb_table.blocks
    -target=module.dynamodb.aws_dynamodb_table.environment_registry
    -target=module.dynamodb.aws_dynamodb_table.discussion_read_state
    -target=module.dynamodb.aws_dynamodb_table.yjs_documents
    -target=module.git.aws_dynamodb_table.git_connections
    -target=module.git.aws_dynamodb_table.git_provider_connections
    -target=module.git.aws_dynamodb_table.source_control_bindings
    -target=module.git.aws_dynamodb_table.tracker_connections
    -target=module.agentcore.aws_dynamodb_table.v2_executions
)
STATE_RESOURCES="$(terraform -chdir="$TF_DIR" state list)"
EXISTING_PROTECTION_TARGETS=()
for target in "${PROTECTION_TARGETS[@]}"; do
    address="${target#-target=}"
    if grep -Fqx "$address" <<< "$STATE_RESOURCES"; then
        EXISTING_PROTECTION_TARGETS+=("$target")
    fi
done

if (( ${#EXISTING_PROTECTION_TARGETS[@]} > 0 )); then
    PREPARATION_PLAN="$TEMP_DIR/teardown-preparation.tfplan"
    PREPARATION_PLAN_JSON="$TEMP_DIR/teardown-preparation.tfplan.json"
    terraform -chdir="$TF_DIR" plan \
        -var-file="$TFVARS_FILE" \
        -var="deletion_protection=false" \
        "${EXISTING_PROTECTION_TARGETS[@]}" \
        -out="$PREPARATION_PLAN"
    terraform -chdir="$TF_DIR" show -json "$PREPARATION_PLAN" > "$PREPARATION_PLAN_JSON"
    node "$SCRIPT_DIR/inspect-terraform-plan.mjs" \
        "$PREPARATION_PLAN_JSON" \
        --deletion-protection-only
    terraform -chdir="$TF_DIR" apply -auto-approve "$PREPARATION_PLAN"
else
    echo "No protected data stores remain in Terraform state; skipping protection updates."
fi

echo "Destroying AI-DLC environment: $ENVIRONMENT"
terraform -chdir="$TF_DIR" destroy \
    -var-file="$TFVARS_FILE" \
    -var="deletion_protection=false" \
    -auto-approve

STATE_BUCKET="$(awk -F= '$1 ~ /^[[:space:]]*bucket[[:space:]]*$/ { gsub(/[[:space:]\"]/, "", $2); print $2; exit }' "$BACKEND_FILE")"
echo ""
echo "Environment destruction complete"
printf '  Environment:  %s\n' "$ENVIRONMENT"
printf '  State backup: %s\n' "$BACKUP_FILE"
if [[ -n "$STATE_BUCKET" ]]; then
    printf '  State bucket: s3://%s (retained)\n' "$STATE_BUCKET"
fi
