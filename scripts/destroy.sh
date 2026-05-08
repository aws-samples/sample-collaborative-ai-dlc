#!/bin/bash

set -e

ENVIRONMENT=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"

if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
    echo "Usage: $0 [dev|prod]"
    echo "Environment must be 'dev' or 'prod'"
    exit 1
fi

echo "WARNING: This will destroy all resources for environment: $ENVIRONMENT"
read -p "Are you sure? (yes/no): " confirm

if [[ "$confirm" != "yes" ]]; then
    echo "Aborted"
    exit 0
fi

cd "$TF_DIR"

# Ensure we're initialised against the right backend
terraform init -reconfigure -backend-config="environments/${ENVIRONMENT}.s3.tfbackend"

# Get S3 bucket name to empty it first
BUCKET_NAME=$(terraform output -raw s3_bucket_name 2>/dev/null || echo "")

if [[ -n "$BUCKET_NAME" ]]; then
    echo "Emptying S3 bucket: $BUCKET_NAME (including all versions)"
    aws s3api delete-objects \
      --bucket "$BUCKET_NAME" \
      --delete "$(aws s3api list-object-versions \
        --bucket "$BUCKET_NAME" \
        --output json \
        --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][] | []}')" || true
fi

echo "Destroying Terraform resources..."
terraform destroy -var-file="environments/${ENVIRONMENT}.tfvars" -auto-approve

echo "Cleanup complete!"
