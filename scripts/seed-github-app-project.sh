#!/usr/bin/env bash
# Seed a GitHub-App-authenticated project (git_auth_mode='app') so agents can
# operate on a repository without a personal OAuth connection.
#
# Prereq (one-time, done by deploy + out-of-band secret population):
#   - terraform applied with github_app_id / github_app_installation_id set
#   - the github-app-private-key secret populated with the PEM
#
# Usage:
#   ID_TOKEN="<cognito id token>" REPO="owner/repo" ./scripts/seed-github-app-project.sh
#
# Config via env (override as needed):
#   ID_TOKEN     (required) Cognito ID token for the owning user. Grab it from a
#                logged-in browser session (DevTools > Network > any /projects
#                request > Authorization header) or via cognito-idp auth.
#   REPO         (required) owner/repo to attach. Must be covered by the GitHub
#                App installation and listed in GITHUB_APP_ALLOWED_REPOS.
#   API_BASE     API Gateway base URL. Defaults to `terraform output -raw api_gateway_url`.
#   PROJECT_NAME Display name. Default: "GitHub App Project"
#   AGENT_CLI    kiro | claude | opencode. Default: kiro
set -uo pipefail

PROJECT_NAME="${PROJECT_NAME:-GitHub App Project}"
AGENT_CLI="${AGENT_CLI:-kiro}"

if [ -z "${API_BASE:-}" ]; then
  TF_DIR="$(cd "$(dirname "$0")/../terraform" && pwd)"
  API_BASE="$(cd "$TF_DIR" && terraform output -raw api_gateway_url 2>/dev/null)"
fi

if [ -z "${ID_TOKEN:-}" ] || [ -z "${REPO:-}" ] || [ -z "${API_BASE:-}" ]; then
  echo "ERROR: ID_TOKEN (env), REPO (env, owner/repo) and API_BASE (env or terraform output api_gateway_url) are all required." >&2
  exit 1
fi

PAYLOAD=$(jq -nc \
  --arg name "$PROJECT_NAME" \
  --arg repo "$REPO" \
  --arg cli "$AGENT_CLI" \
  '{name:$name, gitProvider:"github", gitAuthMode:"app", agentCli:$cli,
    repos:[{url:$repo, role:"primary", provider:"github"}]}')

echo "POST ${API_BASE%/}/projects"
echo "payload: $PAYLOAD"
curl -sS -X POST "${API_BASE%/}/projects" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | jq '{id, name, gitProvider, gitAuthMode, gitRepo, repos}'
