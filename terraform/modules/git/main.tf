# Secrets Manager for GitHub OAuth App credentials
resource "aws_secretsmanager_secret" "github_oauth" {
  name_prefix = "${var.project_name}-${var.environment}-github-oauth-"
  description = "GitHub OAuth App credentials (client_id, client_secret)"

  tags = var.tags
}

# Secrets Manager for GitLab OAuth App credentials
resource "aws_secretsmanager_secret" "gitlab_oauth" {
  name_prefix = "${var.project_name}-${var.environment}-gitlab-oauth-"
  description = "GitLab OAuth App credentials (client_id, client_secret)"

  tags = var.tags
}

# Secrets Manager for Jira Cloud OAuth 2.0 (3LO) App credentials. Sibling to
# github_oauth — kept as a separate secret (not nested under a "tracker-oauth"
# umbrella) so existing operators don't need to migrate their GitHub setup.
resource "aws_secretsmanager_secret" "jira_oauth" {
  name_prefix = "${var.project_name}-${var.environment}-jira-oauth-"
  description = "Jira Cloud OAuth App credentials (client_id, client_secret)"

  tags = var.tags
}

# Value populated out-of-band (console/CLI) like the OAuth secrets above — the
# PEM never lives in code or tfstate.
resource "aws_secretsmanager_secret" "github_app_private_key" {
  name_prefix = "${var.project_name}-${var.environment}-github-app-private-key-"
  description = "GitHub App private key (PEM) for installation-token auth"

  tags = var.tags
}

# Legacy DynamoDB table for user git connections, keyed by userId ALONE.
# Superseded by git_provider_connections (composite key userId+provider) so a
# user can connect more than one git provider at once. Kept in place — NOT
# deleted — so connections written before the cutover keep working: readers
# fall back to this table on a miss and lazily move each row into the new table
# (migrate-on-read). Retire in a separate, deliberate step once it has drained.
resource "aws_dynamodb_table" "git_connections" {
  name         = "${var.project_name}-${var.environment}-git-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = var.tags
}

# DynamoDB table for user git connections, keyed by (userId, providerInstance).
# Replaces the single-key git_connections table: the composite key lets one user
# hold a GitHub connection AND a GitLab connection simultaneously (each project
# pins its own git_provider). For github/gitlab the stored OAuth token backs BOTH
# repo operations (clone/push/PR) and issue operations — they share one row.
# Tracker-only providers (Jira) live in tracker_connections, not here.
#
# providerInstance mirrors tracker_connections: '<provider>#<instance>' (e.g.
# 'github#public', 'gitlab#public'). Only the 'public' SaaS instance exists
# today; the composite value is stored now so future self-hosted/enterprise
# instances (e.g. 'gitlab#self-hosted') slot in with no data migration.
resource "aws_dynamodb_table" "git_provider_connections" {
  name         = "${var.project_name}-${var.environment}-git-provider-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "providerInstance"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "providerInstance"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = var.tags
}

# DynamoDB table for tracker connections (Jira Cloud, GitHub Issues, …).
# Sibling to git_connections; introduced as the foundation for the tracker
# provider abstraction (parent issue #194). Composite key lets one user
# connect multiple provider instances (e.g. one Jira Cloud site + GitHub
# Issues at the same time).
resource "aws_dynamodb_table" "tracker_connections" {
  name         = "${var.project_name}-${var.environment}-tracker-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "providerInstance"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "providerInstance"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = var.tags
}
