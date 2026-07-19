# Auth (Cognito)
output "user_pool_id" {
  description = "Cognito User Pool ID"
  value       = module.auth.user_pool_id
}

output "user_pool_client_id" {
  description = "Cognito User Pool Client ID"
  value       = module.auth.user_pool_client_id
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
  description = "Public URL of the AI-DLC application"
  value       = "https://${module.frontend.cloudfront_domain_name}"
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
