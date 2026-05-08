#!/bin/bash
set -e

# Bootstrap script: creates Terraform state backend and generates a .s3.tfbackend file.
# Run this ONCE before the first terraform init.
#
# Usage: ./scripts/bootstrap.sh [dev|prod]
# Requires: AWS CLI v2 with a configured profile (set AWS_PROFILE)

ENVIRONMENT=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_NAME="collaborative-ai-dlc"
REGION="us-east-1"

if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
    echo "Usage: $0 [dev|prod]"
    exit 1
fi

BACKEND_FILE="${ROOT_DIR}/terraform/environments/${ENVIRONMENT}.s3.tfbackend"

# Generate a random 8-char hex suffix for global uniqueness
SUFFIX=$(openssl rand -hex 4)
BUCKET_NAME="${PROJECT_NAME}-tfstate-${ENVIRONMENT}-${SUFFIX}"

echo "=== Terraform State Backend Bootstrap ==="
echo "  Environment: $ENVIRONMENT"
echo "  S3 Bucket:   $BUCKET_NAME"
echo ""

# --- S3 Bucket ---
echo "Creating S3 bucket..."
if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION"
else
    aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" \
        --create-bucket-configuration LocationConstraint="$REGION"
fi
aws s3api put-bucket-versioning --bucket "$BUCKET_NAME" \
    --versioning-configuration Status=Enabled --region "$REGION"
echo "✓ S3 bucket created"

# --- Write .s3.tfbackend ---
cat > "$BACKEND_FILE" << EOF
bucket       = "${BUCKET_NAME}"
key          = "terraform.tfstate"
region       = "${REGION}"
use_lockfile = true
encrypt      = true
EOF
echo "✓ ${ENVIRONMENT}.s3.tfbackend written"

echo ""
echo "=== Bootstrap complete ==="
echo "Next: ./scripts/deploy-terraform.sh ${ENVIRONMENT}"
