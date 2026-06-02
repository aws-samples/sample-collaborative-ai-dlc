# Secrets Manager for GitHub OAuth App credentials
resource "aws_secretsmanager_secret" "github_oauth" {
  name_prefix = "${var.project_name}-${var.environment}-github-oauth-"
  description = "GitHub OAuth App credentials (client_id, client_secret)"

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

# DynamoDB table for user GitHub connections (access tokens)
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
