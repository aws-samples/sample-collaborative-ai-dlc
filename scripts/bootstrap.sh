#!/bin/bash
set -e

# Prevent AWS CLI v2 from opening command output in `less`.
export AWS_PAGER=""

# Bootstrap script: creates Terraform state backend and generates a .s3.tfbackend file.
# Run this ONCE before the first terraform init.
#
# Usage: ./scripts/bootstrap.sh <environment>   (e.g. dev, prod, staging)
# Requires: AWS CLI v2 with a configured profile (set AWS_PROFILE)

ENVIRONMENT=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_NAME="collaborative-ai-dlc"
REGION="${AWS_REGION:-${REGION:-us-east-1}}"
CONFIG_TF_DIR="${AIDLC_CONFIG_DIR:-${ROOT_DIR}/terraform}"

if [[ -z "$ENVIRONMENT" ]]; then
    echo "Usage: $0 <environment>"
    exit 1
fi

BACKEND_FILE="${CONFIG_TF_DIR}/environments/${ENVIRONMENT}.s3.tfbackend"
mkdir -p "$(dirname "$BACKEND_FILE")"

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
