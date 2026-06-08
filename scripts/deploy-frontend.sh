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

echo "Deploying frontend for environment: $ENVIRONMENT"

# Generate .env from Terraform outputs
"$SCRIPT_DIR/generate-env.sh" "$ENVIRONMENT"

# Get S3 bucket name from Terraform output
cd "$TF_DIR"
BUCKET_NAME=$(terraform output -raw s3_bucket_name 2>/dev/null || echo "")
CLOUDFRONT_ID=$(terraform output -raw cloudfront_distribution_id 2>/dev/null || echo "")

if [[ -z "$BUCKET_NAME" ]]; then
    echo "Error: Could not get S3 bucket name from Terraform output"
    echo "Make sure Terraform has been deployed first"
    exit 1
fi

# Build frontend
cd "$SCRIPT_DIR/../frontend"
echo "Installing frontend dependencies..."
npm ci

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
