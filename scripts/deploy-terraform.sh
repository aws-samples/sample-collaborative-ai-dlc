#!/bin/bash
set -e

ENVIRONMENT=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"

if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
    echo "Usage: $0 [dev|prod]"
    exit 1
fi

echo "Deploying environment: $ENVIRONMENT"

# Pass $REGION through to Terraform's aws_region variable so the bootstrap region,
# AWS CLI region, and provider region all stay in sync from a single env var.
export TF_VAR_aws_region="${REGION:-us-east-1}"

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
