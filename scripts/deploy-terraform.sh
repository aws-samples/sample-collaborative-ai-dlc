#!/bin/bash
set -e

ENVIRONMENT=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"

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

echo "Applying changes..."
terraform apply tfplan
rm -f tfplan

echo "✅ Deployment complete!"
