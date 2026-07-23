#!/bin/bash
set -euo pipefail

# Disable the AWS CLI v2 pager so commands like `lambda invoke` print their JSON
# result and return immediately instead of opening it in `less` (which would
# otherwise wait for the user to press `q`).
export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"
ENVIRONMENT="dev"
PHASE="all"
PLAN_FILE="$TF_DIR/tfplan"

if [[ $# -gt 0 && "$1" != --* ]]; then
    ENVIRONMENT="$1"
    shift
fi
while [[ $# -gt 0 ]]; do
    case "$1" in
        --phase)
            PHASE="${2:?--phase requires plan, apply, or all}"
            shift 2
            ;;
        --plan-file)
            PLAN_FILE="${2:?--plan-file requires a path}"
            shift 2
            ;;
        *)
            echo "Usage: $0 [environment] [--phase plan|apply|all] [--plan-file path]" >&2
            exit 2
            ;;
    esac
done
if [[ "$PHASE" != "plan" && "$PHASE" != "apply" && "$PHASE" != "all" ]]; then
    echo "Error: --phase must be plan, apply, or all" >&2
    exit 2
fi

CONFIG_TF_DIR="${AIDLC_CONFIG_DIR:-$TF_DIR}"
TFVARS_FILE="${AIDLC_TFVARS_FILE:-$CONFIG_TF_DIR/environments/${ENVIRONMENT}.tfvars}"
BACKEND_FILE="${AIDLC_BACKEND_FILE:-$CONFIG_TF_DIR/environments/${ENVIRONMENT}.s3.tfbackend}"
if [[ "$PLAN_FILE" != /* ]]; then
    PLAN_FILE="$(pwd)/$PLAN_FILE"
fi

configure_docker_build_args() {
    if [[ -n "${TF_VAR_docker_build_args+x}" ]]; then
        return
    fi

    local detected_build_args
    detected_build_args="$(node "$SCRIPT_DIR/docker-proxy-build-args.mjs")"
    if [[ "$detected_build_args" == "{}" ]]; then
        return
    fi

    export TF_VAR_docker_build_args="$detected_build_args"
    echo "Forwarding detected proxy settings to Docker image builds."
}

tfvar_string() {
    local name="$1"
    local file="$2"
    local value
    value=$(awk -F= -v key="$name" '$1 ~ "^[[:space:]]*" key "[[:space:]]*$" { gsub(/[[:space:]\"]/, "", $2); print $2; exit }' "$file")
    printf '%s' "$value"
}

inspect_plan() {
    local plan_file="$1"
    local plan_json="${plan_file}.json"
    terraform show -json "$plan_file" > "$plan_json"
    node "$SCRIPT_DIR/inspect-terraform-plan.mjs" "$plan_json"
    rm -f "$plan_json"
}

tf_output() {
    terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null || true
}

print_deployment_summary() {
    local application_url region deployed_environment
    application_url="$(tf_output application_url)"
    region="$(tf_output aws_region)"
    deployed_environment="$(tf_output environment)"

    echo ""
    echo "Infrastructure deployment complete"
    printf '  Environment:     %s\n' "${deployed_environment:-$ENVIRONMENT}"
    printf '  Region:          %s\n' "${region:-unknown}"
    if [[ -n "$application_url" ]]; then
        printf '  Application URL: %s\n' "$application_url"
    else
        echo "  Application URL: unavailable (run 'terraform -chdir=terraform output -raw application_url')"
    fi
    printf '  Next step:       %s/deploy-frontend.sh %s\n' "$SCRIPT_DIR" "$ENVIRONMENT"
}

stop_retired_agent_tasks() {
    local tfvars_file="$1"
    local env_name project_name region cluster_name cluster_arn tasks services

    env_name=$(tfvar_string environment "$tfvars_file")
    project_name=$(tfvar_string project_name "$tfvars_file")
    region=$(tfvar_string aws_region "$tfvars_file")

    env_name=${env_name:-$ENVIRONMENT}
    project_name=${project_name:-collaborative-ai-dlc}
    region=${region:-us-east-1}
    cluster_name="${project_name}-${env_name}-agents"

    cluster_arn=$(aws ecs describe-clusters --region "$region" --clusters "$cluster_name" --query 'clusters[0].clusterArn' --output text 2>/dev/null || true)
    if [[ -z "$cluster_arn" || "$cluster_arn" == "None" ]]; then
        return
    fi

    echo "Stopping retired v1 ECS agent tasks in $cluster_name..."

    services=$(aws ecs list-services --region "$region" --cluster "$cluster_name" --query 'serviceArns[]' --output text 2>/dev/null | awk '$0 != "None"' | xargs || true)
    for service in $services; do
        aws ecs update-service --region "$region" --cluster "$cluster_name" --service "$service" --desired-count 0 >/dev/null
        aws ecs delete-service --region "$region" --cluster "$cluster_name" --service "$service" --force >/dev/null
    done

    while true; do
        tasks="$(aws ecs list-tasks --region "$region" --cluster "$cluster_name" --desired-status RUNNING --query 'taskArns[]' --output text 2>/dev/null || true) $(aws ecs list-tasks --region "$region" --cluster "$cluster_name" --desired-status PENDING --query 'taskArns[]' --output text 2>/dev/null || true)"
        tasks=$(printf '%s\n' $tasks | awk '$0 != "None"' | xargs)
        if [[ -z "$tasks" || "$tasks" == "None" ]]; then
            break
        fi
        for task in $tasks; do
            aws ecs stop-task --region "$region" --cluster "$cluster_name" --task "$task" --reason "Retiring v1 ECS agent runtime" >/dev/null
        done
        aws ecs wait tasks-stopped --region "$region" --cluster "$cluster_name" --tasks $tasks
    done
}

AVAILABLE_ENVS=$(find "$CONFIG_TF_DIR/environments" -maxdepth 1 -type f -name '*.tfvars' -exec basename {} .tfvars \; 2>/dev/null | tr '\n' ' ')
if [[ -z "${AVAILABLE_ENVS// }" ]]; then
    AVAILABLE_ENVS="dev prod"
fi

if ! echo " $AVAILABLE_ENVS " | grep -q " $ENVIRONMENT "; then
    echo "Usage: $0 <environment> [--phase plan|apply|all] [--plan-file path]"
    echo "Available environments: $AVAILABLE_ENVS"
    exit 1
fi

if [[ ! -f "$TFVARS_FILE" ]]; then
    echo "Error: Terraform variables file not found: $TFVARS_FILE" >&2
    exit 1
fi
if [[ ! -f "$BACKEND_FILE" ]]; then
    echo "Error: Terraform backend file not found: $BACKEND_FILE" >&2
    exit 1
fi

echo "Deploying environment: $ENVIRONMENT ($PHASE)"

if [[ "$PHASE" == "plan" || "$PHASE" == "all" ]]; then
    configure_docker_build_args

    if [[ "${AIDLC_SKIP_NPM_CI:-0}" != "1" ]]; then
        echo "Installing root npm dependencies..."
        (cd "$SCRIPT_DIR/.." && npm ci)
    fi

    cd "$TF_DIR"
    echo "Initializing Terraform..."
    terraform init -reconfigure -backend-config="$BACKEND_FILE"

    mkdir -p "$(dirname "$PLAN_FILE")"
    echo "Planning deployment..."
    terraform plan -var-file="$TFVARS_FILE" -out="$PLAN_FILE"
    inspect_plan "$PLAN_FILE"
    if [[ "$PHASE" == "plan" ]]; then
        echo "Terraform plan ready: $PLAN_FILE"
        exit 0
    fi
fi

if [[ ! -f "$PLAN_FILE" ]]; then
    echo "Error: Terraform plan not found: $PLAN_FILE" >&2
    exit 1
fi

cd "$TF_DIR"
if [[ "$PHASE" == "apply" ]]; then
    inspect_plan "$PLAN_FILE"
fi
stop_retired_agent_tasks "$TFVARS_FILE"

echo "Applying changes..."
terraform apply "$PLAN_FILE"
if [[ "${AIDLC_KEEP_PLAN:-0}" != "1" ]]; then
    rm -f "$PLAN_FILE"
fi

# Reseed the SYSTEM baseline (vendor-owned blocks + default workflow). reseed
# clears the existing SYSTEM partitions and rewrites them from the current
# baseline, so a deploy that changed baseline-blocks.js actually takes effect —
# the default insert-only mode would skip every already-existing block. Scoped
# to SYSTEM only; customer forks (per-tenant partitions) are never touched.
echo "Applying AI-DLC default workflow and building blocks (reseed)"
# Pin --region to the deployed stack's region: without it the AWS CLI falls
# back to the profile default, which fails with "Function not found" whenever
# the profile region differs from the deployment region.
SEED_RESULT_FILE="$(mktemp "${TMPDIR:-/tmp}/aidlc-seed.XXXXXX")"
SEED_FUNCTION_ERROR="$(
    aws lambda invoke \
        --function-name "$(tf_output seed_blocks_lambda_name)" \
        --region "$(tf_output aws_region)" \
        --payload '{"reseed":true}' \
        --cli-binary-format raw-in-base64-out \
        "$SEED_RESULT_FILE" \
        --query FunctionError \
        --output text
)"
if [[ -n "$SEED_FUNCTION_ERROR" && "$SEED_FUNCTION_ERROR" != "None" ]]; then
    echo "Error: baseline seed Lambda failed ($SEED_FUNCTION_ERROR):" >&2
    cat "$SEED_RESULT_FILE" >&2
    rm -f "$SEED_RESULT_FILE"
    exit 1
fi
rm -f "$SEED_RESULT_FILE"
echo "AI-DLC default workflow and building blocks applied."

if [[ "${AIDLC_MANAGED_INSTALL:-0}" != "1" ]]; then
    print_deployment_summary
fi
