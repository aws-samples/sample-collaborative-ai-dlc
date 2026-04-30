# Secrets Manager for GitHub OAuth App credentials
resource "aws_secretsmanager_secret" "github_oauth" {
  name_prefix = "${var.project_name}-${var.environment}-github-oauth-"
  description = "GitHub OAuth App credentials (client_id, client_secret)"

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
