#!/usr/bin/env bash
set -euo pipefail
umask 077
export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"
ENVIRONMENT="dev"
ASSUME_YES="${AIDLC_YES:-0}"

if [[ $# -gt 0 && "$1" != --* ]]; then
    ENVIRONMENT="$1"
    shift
fi
while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes)
            ASSUME_YES=1
            shift
            ;;
        *)
            echo "Usage: $0 [environment] [--yes]" >&2
            exit 2
            ;;
    esac
done

CONFIG_TF_DIR="${AIDLC_CONFIG_DIR:-$TF_DIR}"
TFVARS_FILE="${AIDLC_TFVARS_FILE:-$CONFIG_TF_DIR/environments/${ENVIRONMENT}.tfvars}"
BACKEND_FILE="${AIDLC_BACKEND_FILE:-$CONFIG_TF_DIR/environments/${ENVIRONMENT}.s3.tfbackend}"
BACKUP_DIR="${AIDLC_BACKUP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/collaborative-ai-dlc/backups}"

if [[ ! -f "$TFVARS_FILE" ]]; then
    echo "Error: Terraform variables file not found: $TFVARS_FILE" >&2
    exit 1
fi
if [[ ! -f "$BACKEND_FILE" ]]; then
    echo "Error: Terraform backend file not found: $BACKEND_FILE" >&2
    exit 1
fi

if [[ "$ASSUME_YES" != 1 ]]; then
    if [[ ! -t 0 ]]; then
        echo "Destruction requires an interactive terminal or --yes." >&2
        exit 1
    fi
    echo "WARNING: This permanently destroys all AI-DLC resources and application data"
    echo "for environment '$ENVIRONMENT'. The Terraform state bucket is retained."
    read -r -p "Type the environment name '$ENVIRONMENT' to continue: " confirmation
    if [[ "$confirmation" != "$ENVIRONMENT" ]]; then
        echo "Destruction aborted."
        exit 0
    fi
fi

echo "Initializing Terraform for environment: $ENVIRONMENT"
terraform -chdir="$TF_DIR" init -reconfigure -backend-config="$BACKEND_FILE"

mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/terraform-${ENVIRONMENT}-pre-destroy-$(date -u +%Y%m%dT%H%M%SZ).tfstate"
terraform -chdir="$TF_DIR" state pull > "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
echo "Terraform state backup: $BACKUP_FILE"

echo "Destroying AI-DLC environment: $ENVIRONMENT"
terraform -chdir="$TF_DIR" destroy -var-file="$TFVARS_FILE" -auto-approve

STATE_BUCKET="$(awk -F= '$1 ~ /^[[:space:]]*bucket[[:space:]]*$/ { gsub(/[[:space:]\"]/, "", $2); print $2; exit }' "$BACKEND_FILE")"
echo ""
echo "Environment destruction complete"
printf '  Environment:  %s\n' "$ENVIRONMENT"
printf '  State backup: %s\n' "$BACKUP_FILE"
if [[ -n "$STATE_BUCKET" ]]; then
    printf '  State bucket: s3://%s (retained)\n' "$STATE_BUCKET"
fi
