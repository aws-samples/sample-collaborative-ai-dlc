# Auth (Cognito)
output "user_pool_id" {
  description = "Cognito User Pool ID"
  value       = module.auth.user_pool_id
}

output "user_pool_client_id" {
  description = "Cognito User Pool Client ID"
  value       = module.auth.user_pool_client_id
}

output "auth_mode" {
  description = "Configured login mode"
  value       = var.auth_mode
}

output "cognito_hosted_ui_domain" {
  description = "Cognito managed-login origin used for enterprise federation"
  value       = module.auth.hosted_ui_domain
}

output "oidc_idp_callback_url" {
  description = "Callback URL to register with upstream OIDC providers"
  value       = module.auth.oidc_idp_callback_url
}

output "saml_acs_url" {
  description = "Assertion consumer service URL for upstream SAML providers"
  value       = module.auth.saml_acs_url
}

output "saml_entity_id" {
  description = "SAML service-provider entity ID"
  value       = module.auth.saml_entity_id
}

output "sso_providers" {
  description = "Configured SSO provider names and public labels"
  # The source provider object is sensitive because it contains secret ARNs.
  # This module output is an allowlisted public projection, but nested
  # sensitivity marks survive module boundaries unless they are removed through
  # a scalar representation first.
  value = jsondecode(nonsensitive(jsonencode(
    module.auth.public_sso_providers
  )))
}

output "auth_callback_url" {
  description = "Application callback URL used after Cognito federation"
  value       = "${local.app_url}/auth/callback"
}

# Frontend
output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = module.frontend.cloudfront_distribution_id
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name"
  value       = module.frontend.cloudfront_domain_name
}

output "application_url" {
  description = "Public URL of the AI-DLC application. Uses the custom domain when one is configured."
  value       = local.app_url
}

output "application_domain" {
  description = "Canonical hostname of the AI-DLC application. The custom domain when configured, otherwise the CloudFront domain. This is the value the frontend build and the OAuth redirect URIs are derived from."
  value       = local.app_domain
}

output "application_aliases" {
  description = "Every hostname CloudFront answers on. Empty when no custom domain is configured."
  value       = local.app_aliases
}

output "custom_domain_enabled" {
  description = "Whether a custom domain is configured for this deployment."
  value       = local.custom_domain_enabled
}

output "acm_certificate_arn" {
  description = "ARN of the us-east-1 certificate serving the custom domain. Empty when no custom domain is configured."
  value       = module.domain.certificate_arn
}

output "dns_managed_by_terraform" {
  description = "Whether Terraform manages the DNS records for the custom domain. False means the records must be created in an external DNS provider using dns_target."
  value       = local.custom_domain_enabled && var.route53_zone_id != ""
}

output "dns_target" {
  description = "Value the custom domain's A/AAAA alias (or CNAME) records must point at. Needed only when DNS is managed outside this Terraform state."
  value       = module.frontend.cloudfront_domain_name
}

output "dns_target_hosted_zone_id" {
  description = "Hosted zone ID of the CloudFront alias target, for Route53 alias records created outside this Terraform state."
  value       = module.frontend.cloudfront_hosted_zone_id
}

output "s3_bucket_name" {
  description = "Frontend S3 bucket name"
  value       = module.frontend.s3_bucket_name
}

# VPC Endpoints
output "s3_endpoint_id" {
  description = "S3 VPC endpoint ID"
  value       = module.vpc_endpoints.s3_endpoint_id
}

output "dynamodb_endpoint_id" {
  description = "DynamoDB VPC endpoint ID"
  value       = module.vpc_endpoints.dynamodb_endpoint_id
}

# S3 Buckets
output "artifacts_bucket_name" {
  description = "Name of the artifacts S3 bucket"
  value       = module.s3.artifacts_bucket_name
}

output "artifacts_bucket_arn" {
  description = "ARN of the artifacts S3 bucket"
  value       = module.s3.artifacts_bucket_arn
}

output "code_snapshots_bucket_name" {
  description = "Name of the code snapshots S3 bucket"
  value       = module.s3.code_snapshots_bucket_name
}

output "code_snapshots_bucket_arn" {
  description = "ARN of the code snapshots S3 bucket"
  value       = module.s3.code_snapshots_bucket_arn
}

# DynamoDB Tables
output "sessions_table_name" {
  description = "Name of the sessions table"
  value       = module.dynamodb.sessions_table_name
}

output "sessions_table_arn" {
  description = "ARN of the sessions table"
  value       = module.dynamodb.sessions_table_arn
}

output "notifications_table_name" {
  description = "Name of the notifications table"
  value       = module.dynamodb.notifications_table_name
}

output "notifications_table_arn" {
  description = "ARN of the notifications table"
  value       = module.dynamodb.notifications_table_arn
}

output "agent_questions_table_name" {
  description = "Name of the agent questions table"
  value       = module.dynamodb.agent_questions_table_name
}

output "agent_questions_table_arn" {
  description = "ARN of the agent questions table"
  value       = module.dynamodb.agent_questions_table_arn
}

output "yjs_documents_table_name" {
  description = "Name of the YJS documents table"
  value       = module.dynamodb.yjs_documents_table_name
}

output "yjs_documents_table_arn" {
  description = "ARN of the YJS documents table"
  value       = module.dynamodb.yjs_documents_table_arn
}

output "blocks_table_name" {
  description = "Name of the building-blocks table"
  value       = module.dynamodb.blocks_table_name
}

output "blocks_table_arn" {
  description = "ARN of the building-blocks table"
  value       = module.dynamodb.blocks_table_arn
}

# Building Blocks
output "seed_blocks_lambda_name" {
  description = "Name of the one-shot baseline seed Lambda. Invoke via `aws lambda invoke` after deploy; see lambda/seed-blocks/index.js for the payload contract."
  value       = module.lambda.seed_blocks_lambda_name
}

# Neptune
output "neptune_cluster_id" {
  description = "Neptune cluster identifier"
  value       = module.neptune.cluster_id
}

output "neptune_cluster_endpoint" {
  description = "Neptune cluster endpoint"
  value       = module.neptune.cluster_endpoint
}

output "neptune_cluster_reader_endpoint" {
  description = "Neptune cluster reader endpoint"
  value       = module.neptune.cluster_reader_endpoint
}

output "neptune_cluster_port" {
  description = "Neptune cluster port"
  value       = module.neptune.cluster_port
}

output "neptune_security_group_id" {
  description = "Neptune security group ID"
  value       = module.neptune.security_group_id
}

# API Gateway
output "api_gateway_url" {
  description = "API Gateway URL"
  value       = module.api.api_gateway_url
}

output "api_gateway_id" {
  description = "API Gateway ID"
  value       = module.api.api_gateway_id
}

# Real-time (WebSocket)
output "websocket_api_endpoint" {
  description = "WebSocket API endpoint URL"
  value       = module.realtime.websocket_api_endpoint
}

output "websocket_api_id" {
  description = "WebSocket API ID"
  value       = module.realtime.websocket_api_id
}

# Yjs Server
output "yjs_server_url" {
  description = "Yjs WebSocket server URL"
  value       = module.yjs_server.yjs_server_url
}

output "yjs_ecr_repository_url" {
  description = "ECR repository URL for Yjs server"
  value       = module.yjs_server.ecr_repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = module.yjs_server.ecs_cluster_id
}

output "yjs_ecs_service_name" {
  description = "ECS service name for Yjs server"
  value       = module.yjs_server.ecs_service_name
}

output "yjs_image_uri" {
  description = "Full image URI with tag for the deployed yjs-server image"
  value       = module.yjs_server.yjs_image_uri
}

output "yjs_image_tag" {
  description = "Image tag (hash) for the deployed yjs-server image"
  value       = module.yjs_server.yjs_image_tag
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = module.networking.private_subnet_ids
}

output "aws_region" {
  description = "AWS region"
  value       = var.aws_region
}

output "environment" {
  description = "Environment this state is deployed to. Used by deploy scripts to guard against running against the wrong backend."
  value       = var.environment
}

# GitHub OAuth
output "github_oauth_secret_name" {
  description = "Name of the Secrets Manager secret holding the GitHub OAuth client_id/client_secret"
  value       = module.git.github_oauth_secret_name
}

# GitLab OAuth
output "gitlab_oauth_secret_name" {
  description = "Name of the Secrets Manager secret holding the GitLab OAuth client_id/client_secret"
  value       = module.git.gitlab_oauth_secret_name
}

# Bitbucket OAuth
output "bitbucket_oauth_secret_name" {
  description = "Name of the Secrets Manager secret holding the Bitbucket OAuth client_id/client_secret"
  value       = module.git.bitbucket_oauth_secret_name
}

# Jira Cloud OAuth
output "jira_oauth_secret_name" {
  description = "Name of the Secrets Manager secret holding the Jira Cloud OAuth client_id/client_secret"
  value       = module.git.jira_oauth_secret_name
}

# AgentCore Runtime (v2 stage executor)
output "agentcore_runtime_arn" {
  description = "ARN of the Bedrock AgentCore Runtime that executes v2 stages"
  value       = module.agentcore.runtime_arn
}

output "agentcore_image_uri" {
  description = "Container image URI built for the AgentCore runtime"
  value       = module.agentcore.image_uri
}

output "v2_executions_table_name" {
  description = "v2 process/state DynamoDB table name"
  value       = module.agentcore.v2_executions_table_name
}

output "environment_registry_table_name" {
  description = "Managed environment registry DynamoDB table name"
  value       = module.dynamodb.environment_registry_table_name
}

output "managed_environment_repository_name" {
  description = "Immutable ECR repository for managed environment images"
  value       = module.agentcore.managed_environment_repository_name
}

output "managed_environment_codebuild_project_name" {
  description = "ARM64 CodeBuild project for managed environment images"
  value       = module.managed_environments.codebuild_project_name
}

output "managed_environment_control_lambda_name" {
  description = "Managed environment control Lambda function name"
  value       = module.managed_environments.control_lambda_name
}

output "managed_environment_status_lambda_name" {
  description = "Managed environment build-status Lambda function name"
  value       = module.managed_environments.status_lambda_name
}

output "managed_environment_build_context_bucket_name" {
  description = "Private S3 bucket containing managed environment build contexts"
  value       = module.managed_environments.build_context_bucket_name
}

output "managed_tool_repository_name" {
  description = "Immutable ECR repository for managed tool artifacts"
  value       = module.managed_environments.tool_repository_name
}

output "managed_tool_codebuild_project_name" {
  description = "ARM64 CodeBuild project for managed tool artifacts"
  value       = module.managed_environments.tool_codebuild_project_name
}

output "managed_tool_control_lambda_name" {
  description = "Managed tool control Lambda function name"
  value       = module.managed_environments.tool_control_lambda_name
}

output "managed_tool_status_lambda_name" {
  description = "Managed tool build-status Lambda function name"
  value       = module.managed_environments.tool_status_lambda_name
}

output "managed_environment_reset_lambda_name" {
  description = "Managed environment destructive reset Lambda function name"
  value       = module.managed_environments.reset_lambda_name
}
