#!/bin/bash

set -e

# Disable the AWS CLI v2 pager so commands like `cloudfront create-invalidation`
# print their JSON result and return immediately instead of opening it in `less`
# (which would otherwise wait for the user to press `q`).
export AWS_PAGER=""

ENVIRONMENT=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"

# Discover available environments from terraform/environments/*.tfvars.
# The *.tfvars glob never matches *.tfvars.example, so no grep -v needed.
# Fall back to "dev prod" so a fresh public clone (no .tfvars yet) still works.
AVAILABLE_ENVS=$(ls "$TF_DIR/environments/"*.tfvars 2>/dev/null | xargs -n1 basename | sed 's/\.tfvars$//' | tr '\n' ' ')
if [[ -z "${AVAILABLE_ENVS// }" ]]; then
    AVAILABLE_ENVS="dev prod"
fi

if ! echo " $AVAILABLE_ENVS " | grep -q " $ENVIRONMENT "; then
    echo "Usage: $0 <environment>"
    echo "Available environments: $AVAILABLE_ENVS"
    exit 1
fi

echo "Deploying frontend for environment: $ENVIRONMENT"

# Generate .env from Terraform outputs
"$SCRIPT_DIR/generate-env.sh" "$ENVIRONMENT"

# Get S3 bucket name from Terraform output
cd "$TF_DIR"

# Safety: the initialized backend MUST match the requested environment before we
# read the bucket/distribution — otherwise the `s3 sync --delete` below could
# wipe the wrong environment's bucket.
INIT_ENV=$(terraform output -raw environment 2>/dev/null || echo "")
if [[ -n "$INIT_ENV" && "$INIT_ENV" != "$ENVIRONMENT" ]]; then
    echo "Error: terraform is initialized for '$INIT_ENV' but you requested '$ENVIRONMENT'."
    echo "Re-init the correct backend first:"
    echo "  terraform init -backend-config=environments/$ENVIRONMENT.s3.tfbackend -reconfigure"
    exit 1
fi

BUCKET_NAME=$(terraform output -raw s3_bucket_name 2>/dev/null || echo "")
CLOUDFRONT_ID=$(terraform output -raw cloudfront_distribution_id 2>/dev/null || echo "")

if [[ -z "$BUCKET_NAME" ]]; then
    echo "Error: Could not get S3 bucket name from Terraform output"
    echo "Make sure Terraform has been deployed first"
    exit 1
fi

# Build frontend
cd "$SCRIPT_DIR/../frontend"
echo "Building frontend..."
npm run build

# Upload to S3
echo "Uploading to S3 bucket: $BUCKET_NAME"
aws s3 sync dist/ s3://$BUCKET_NAME --delete

# Invalidate CloudFront cache if distribution exists
if [[ -n "$CLOUDFRONT_ID" ]]; then
    echo "Invalidating CloudFront cache: $CLOUDFRONT_ID"
    aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_ID --paths "/*"
fi

echo "Frontend deployment complete!"
