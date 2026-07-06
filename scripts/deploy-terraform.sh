#!/bin/bash
set -e

# Disable the AWS CLI v2 pager so commands like `lambda invoke` print their JSON
# result and return immediately instead of opening it in `less` (which would
# otherwise wait for the user to press `q`).
export AWS_PAGER=""

ENVIRONMENT=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"

tfvar_string() {
    local name="$1"
    local file="$2"
    local value
    value=$(awk -F= -v key="$name" '$1 ~ "^[[:space:]]*" key "[[:space:]]*$" { gsub(/[[:space:]\"]/, "", $2); print $2; exit }' "$file")
    printf '%s' "$value"
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

AVAILABLE_ENVS=$(ls "$TF_DIR/environments/"*.tfvars 2>/dev/null | xargs -n1 basename | sed 's/\.tfvars$//' | tr '\n' ' ')
if [[ -z "${AVAILABLE_ENVS// }" ]]; then
    AVAILABLE_ENVS="dev prod"
fi

if ! echo " $AVAILABLE_ENVS " | grep -q " $ENVIRONMENT "; then
    echo "Usage: $0 <environment>"
    echo "Available environments: $AVAILABLE_ENVS"
    exit 1
fi

echo "Deploying environment: $ENVIRONMENT"

echo "Installing root npm dependencies..."
(cd "$SCRIPT_DIR/.." && npm ci)

cd "$TF_DIR"

echo "Initializing Terraform..."
terraform init -reconfigure -backend-config="environments/${ENVIRONMENT}.s3.tfbackend"

echo "Planning deployment..."
terraform plan -var-file="environments/${ENVIRONMENT}.tfvars" -out=tfplan

stop_retired_agent_tasks "environments/${ENVIRONMENT}.tfvars"

echo "Applying changes..."
terraform apply tfplan
rm -f tfplan

# Reseed the SYSTEM baseline (vendor-owned blocks + default workflow). reseed
# clears the existing SYSTEM partitions and rewrites them from the current
# baseline, so a deploy that changed baseline-blocks.js actually takes effect —
# the default insert-only mode would skip every already-existing block. Scoped
# to SYSTEM only; customer forks (per-tenant partitions) are never touched.
echo "Applying AI-DLC default workflow and building blocks (reseed)"
# Pin --region to the deployed stack's region: without it the AWS CLI falls
# back to the profile default, which fails with "Function not found" whenever
# the profile region differs from the deployment region.
aws lambda invoke --function-name "$(cd "$TF_DIR" && terraform output -raw seed_blocks_lambda_name)" --region "$(cd "$TF_DIR" && terraform output -raw aws_region)" --payload '{"reseed":true}' --cli-binary-format raw-in-base64-out /tmp/out.json
cat /tmp/out.json
echo ""
echo "✅ AI-DLC default workflow & building blocks applied!"

echo "✅ Deployment complete!"
