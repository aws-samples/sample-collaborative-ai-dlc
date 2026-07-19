output "github_oauth_secret_arn" {
  value = aws_secretsmanager_secret.github_oauth.arn
}

output "github_oauth_secret_name" {
  value = aws_secretsmanager_secret.github_oauth.name
}

output "gitlab_oauth_secret_arn" {
  value = aws_secretsmanager_secret.gitlab_oauth.arn
}

output "gitlab_oauth_secret_name" {
  value = aws_secretsmanager_secret.gitlab_oauth.name
}

output "bitbucket_oauth_secret_arn" {
  value = aws_secretsmanager_secret.bitbucket_oauth.arn
}

output "bitbucket_oauth_secret_name" {
  value = aws_secretsmanager_secret.bitbucket_oauth.name
}

output "jira_oauth_secret_arn" {
  value = aws_secretsmanager_secret.jira_oauth.arn
}

output "jira_oauth_secret_name" {
  value = aws_secretsmanager_secret.jira_oauth.name
}

output "github_app_private_key_secret_arn" {
  value = aws_secretsmanager_secret.github_app_private_key.arn
}

output "github_app_private_key_secret_name" {
  value = aws_secretsmanager_secret.github_app_private_key.name
}

output "github_auth_mode_param_name" {
  value = aws_ssm_parameter.github_auth_mode.name
}

output "github_auth_mode_param_arn" {
  value = aws_ssm_parameter.github_auth_mode.arn
}

output "github_app_config_param_name" {
  value = aws_ssm_parameter.github_app_config.name
}

output "github_app_config_param_arn" {
  value = aws_ssm_parameter.github_app_config.arn
}

output "git_connections_table_name" {
  value = aws_dynamodb_table.git_connections.name
}

output "git_connections_table_arn" {
  value = aws_dynamodb_table.git_connections.arn
}

output "git_provider_connections_table_name" {
  value = aws_dynamodb_table.git_provider_connections.name
}

output "git_provider_connections_table_arn" {
  value = aws_dynamodb_table.git_provider_connections.arn
}

output "tracker_connections_table_name" {
  value = aws_dynamodb_table.tracker_connections.name
}

output "tracker_connections_table_arn" {
  value = aws_dynamodb_table.tracker_connections.arn
}
