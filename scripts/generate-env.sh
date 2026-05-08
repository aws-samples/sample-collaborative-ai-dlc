#!/bin/bash

set -e

ENVIRONMENT=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"

if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
    echo "Usage: $0 [dev|prod]"
    exit 1
fi

cd "$TF_DIR"

REGION=$(terraform output -raw aws_region 2>/dev/null || echo "")
USER_POOL_ID=$(terraform output -raw user_pool_id 2>/dev/null || echo "")
USER_POOL_CLIENT_ID=$(terraform output -raw user_pool_client_id 2>/dev/null || echo "")
WEBSOCKET_URL=$(terraform output -raw websocket_api_endpoint 2>/dev/null || echo "")
CLOUDFRONT_DOMAIN=$(terraform output -raw cloudfront_domain_name 2>/dev/null || echo "")

# Use CloudFront for Yjs WebSocket (WSS)
YJS_SERVER_URL="wss://${CLOUDFRONT_DOMAIN}/yjs"
API_URL="https://${CLOUDFRONT_DOMAIN}/api"

if [[ -z "$USER_POOL_ID" ]]; then
    echo "Error: Terraform outputs not available. Deploy infrastructure first."
    exit 1
fi

cat > "$SCRIPT_DIR/../frontend/.env" << EOF
VITE_AWS_REGION=$REGION
VITE_AWS_USER_POOL_ID=$USER_POOL_ID
VITE_AWS_USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID
VITE_API_BASE_URL="$API_URL"
VITE_WEBSOCKET_URL=wss://${CLOUDFRONT_DOMAIN}/ws
VITE_YJS_SERVER_URL=$YJS_SERVER_URL
VITE_ENVIRONMENT=$ENVIRONMENT
EOF

echo "Generated frontend/.env for $ENVIRONMENT"
