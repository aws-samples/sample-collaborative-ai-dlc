output "github_oauth_secret_arn" {
  value = aws_secretsmanager_secret.github_oauth.arn
}

output "github_oauth_secret_name" {
  value = aws_secretsmanager_secret.github_oauth.name
}

output "jira_oauth_secret_arn" {
  value = aws_secretsmanager_secret.jira_oauth.arn
}

output "jira_oauth_secret_name" {
  value = aws_secretsmanager_secret.jira_oauth.name
}

output "git_connections_table_name" {
  value = aws_dynamodb_table.git_connections.name
}

output "git_connections_table_arn" {
  value = aws_dynamodb_table.git_connections.arn
}

output "tracker_connections_table_name" {
  value = aws_dynamodb_table.tracker_connections.name
}

output "tracker_connections_table_arn" {
  value = aws_dynamodb_table.tracker_connections.arn
}
