#!/bin/bash

set -e

ENVIRONMENT=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"
CONFIG_TF_DIR="${AIDLC_CONFIG_DIR:-$TF_DIR}"

# Discover available environments from terraform/environments/*.tfvars.
# The *.tfvars glob never matches *.tfvars.example, so no grep -v needed.
# Fall back to "dev prod" so a fresh public clone (no .tfvars yet) still works —
# Terraform uses its own defaults when no var-file has been initialised.
AVAILABLE_ENVS=$(find "$CONFIG_TF_DIR/environments" -maxdepth 1 -type f -name '*.tfvars' -exec basename {} .tfvars \; 2>/dev/null | tr '\n' ' ')
if [[ -z "${AVAILABLE_ENVS// }" ]]; then
    AVAILABLE_ENVS="dev prod"
fi

if ! echo " $AVAILABLE_ENVS " | grep -q " $ENVIRONMENT "; then
    echo "Usage: $0 <environment>"
    echo "Available environments: $AVAILABLE_ENVS"
    exit 1
fi

cd "$TF_DIR"

# Safety: the initialized backend must match the requested environment. Reading
# outputs from a backend initialized to a different env would emit the wrong
# endpoints/bucket. Abort with guidance if they don't match.
INIT_ENV=$(terraform output -raw environment 2>/dev/null || echo "")
if [[ -n "$INIT_ENV" && "$INIT_ENV" != "$ENVIRONMENT" ]]; then
    echo "Error: terraform is initialized for '$INIT_ENV' but you requested '$ENVIRONMENT'."
    echo "Re-init the correct backend first:"
    echo "  terraform init -backend-config=environments/$ENVIRONMENT.s3.tfbackend -reconfigure"
    exit 1
fi

REGION=$(terraform output -raw aws_region 2>/dev/null || echo "")
USER_POOL_ID=$(terraform output -raw user_pool_id 2>/dev/null || echo "")
USER_POOL_CLIENT_ID=$(terraform output -raw user_pool_client_id 2>/dev/null || echo "")

# The canonical hostname: the custom domain when one is configured, otherwise
# the CloudFront domain. Falling back to cloudfront_domain_name keeps this script
# working against state applied before application_domain existed.
APP_DOMAIN=$(terraform output -raw application_domain 2>/dev/null || echo "")
if [[ -z "$APP_DOMAIN" ]]; then
    APP_DOMAIN=$(terraform output -raw cloudfront_domain_name 2>/dev/null || echo "")
fi

# Everything is same-origin behind the one CloudFront distribution, so all three
# endpoints share the application hostname. These values are inlined into the
# bundle at build time, which is why changing the domain requires a frontend
# redeploy and not just a Terraform apply.
APP_ORIGIN="https://${APP_DOMAIN}"
API_URL="${APP_ORIGIN}/api"
WEBSOCKET_URL="wss://${APP_DOMAIN}/ws"
YJS_SERVER_URL="wss://${APP_DOMAIN}/yjs"

if [[ -z "$USER_POOL_ID" ]]; then
    echo "Error: Terraform outputs not available. Deploy infrastructure first."
    exit 1
fi

cat > "$SCRIPT_DIR/../frontend/.env" << EOF
VITE_AWS_REGION=$REGION
VITE_AWS_USER_POOL_ID=$USER_POOL_ID
VITE_AWS_USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID
VITE_APP_ORIGIN="$APP_ORIGIN"
VITE_API_BASE_URL="$API_URL"
VITE_WEBSOCKET_URL=$WEBSOCKET_URL
VITE_YJS_SERVER_URL=$YJS_SERVER_URL
VITE_ENVIRONMENT=$ENVIRONMENT
EOF

echo "Generated frontend/.env for $ENVIRONMENT ($APP_DOMAIN)"
