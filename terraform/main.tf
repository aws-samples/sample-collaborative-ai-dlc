terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    awscc = {
      source  = "hashicorp/awscc"
      version = "~> 1.0"
    }
  }
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Environment = var.environment
      Project     = var.project_name
    }
  }
}

# Cloud Control provider (used only for the Bedrock AgentCore Runtime). Pin it to
# the deployment region so the AgentCore application region matches the ECR image
# region — otherwise awscc falls back to the profile/AWS_REGION default and a
# cross-region ECR URI is rejected.
provider "awscc" {
  region = var.aws_region
}

data "aws_partition" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix
}

# Account-level API Gateway CloudWatch logging role.
# This is a singleton per AWS account/region — both the REST API and WebSocket
# API stages need it configured before they can enable access logging.
resource "aws_iam_role" "api_gateway_cloudwatch" {
  name = "${var.project_name}-apigw-cw-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "apigateway.${local.dns_suffix}" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "api_gateway_cloudwatch" {
  role       = aws_iam_role.api_gateway_cloudwatch.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "main" {
  cloudwatch_role_arn = aws_iam_role.api_gateway_cloudwatch.arn
}

# Networking
module "networking" {
  source = "./modules/networking"

  project_name = var.project_name
  environment  = var.environment
}

# Auth (Cognito)
module "auth" {
  source = "./modules/auth"

  project_name = var.project_name
  environment  = var.environment
}

# Frontend (S3 + CloudFront)
module "frontend" {
  source                         = "./modules/frontend"
  project_name                   = var.project_name
  environment                    = var.environment
  yjs_enabled                    = true
  yjs_alb_dns_name               = module.yjs_server.alb_dns_name
  yjs_alb_arn                    = module.yjs_server.alb_arn
  access_logs_bucket_domain_name = module.s3.access_logs_bucket_domain_name
  api_gateway_domain_name        = module.api.api_gateway_domain_name
  api_gateway_stage_path         = "/${var.environment}"
  websocket_domain_name          = regex("wss://([^/]+)", module.realtime.websocket_api_endpoint)[0]
}

# VPC Endpoints
module "vpc_endpoints" {
  source = "./modules/networking/vpc-endpoints"

  name_prefix     = "${var.project_name}-${var.environment}"
  vpc_id          = module.networking.vpc_id
  region          = var.aws_region
  route_table_ids = module.networking.private_route_table_ids

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# S3 Data Storage
module "s3" {
  source = "./modules/data/s3"

  project_name = var.project_name
  environment  = var.environment

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# DynamoDB Tables
module "dynamodb" {
  source = "./modules/data/dynamodb"

  project_name = var.project_name
  environment  = var.environment

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# Neptune Graph Database
module "neptune" {
  source = "./modules/data/neptune"

  name_prefix        = "${var.project_name}-${var.environment}"
  vpc_id             = module.networking.vpc_id
  vpc_cidr           = module.networking.vpc_cidr_block
  private_subnet_ids = module.networking.private_subnet_ids
  instance_class     = "db.t3.medium"

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# Lambda CRUD Functions
module "lambda" {
  source = "./modules/api/lambda"

  project_name                = var.project_name
  environment                 = var.environment
  vpc_id                      = module.networking.vpc_id
  private_subnet_ids          = module.networking.private_subnet_ids
  neptune_endpoint            = module.neptune.cluster_endpoint
  neptune_cluster_resource_id = module.neptune.cluster_resource_id
  dynamodb_table_arns = [
    module.dynamodb.sessions_table_arn,
    module.dynamodb.notifications_table_arn,
    module.dynamodb.agent_questions_table_arn,
    module.dynamodb.yjs_documents_table_arn,
    module.dynamodb.agent_outputs_table_arn
  ]
  artifacts_bucket_name               = module.s3.artifacts_bucket_name
  artifacts_bucket_arn                = module.s3.artifacts_bucket_arn
  blocks_table_name                   = module.dynamodb.blocks_table_name
  blocks_table_arn                    = module.dynamodb.blocks_table_arn
  v2_executions_table_name            = module.agentcore.v2_executions_table_name
  v2_executions_table_arn             = module.agentcore.v2_executions_table_arn
  yjs_documents_table_name            = module.dynamodb.yjs_documents_table_name
  yjs_documents_table_arn             = module.dynamodb.yjs_documents_table_arn
  agentcore_runtime_arn               = module.agentcore.runtime_arn
  github_oauth_secret_name            = module.git.github_oauth_secret_name
  github_oauth_secret_arn             = module.git.github_oauth_secret_arn
  github_app_private_key_secret_name  = module.git.github_app_private_key_secret_name
  github_app_private_key_secret_arn   = module.git.github_app_private_key_secret_arn
  github_app_config_param_name        = module.git.github_app_config_param_name
  github_app_config_param_arn         = module.git.github_app_config_param_arn
  gitlab_oauth_secret_name            = module.git.gitlab_oauth_secret_name
  gitlab_oauth_secret_arn             = module.git.gitlab_oauth_secret_arn
  git_connections_table_name          = module.git.git_connections_table_name
  git_connections_table_arn           = module.git.git_connections_table_arn
  git_provider_connections_table_name = module.git.git_provider_connections_table_name
  git_provider_connections_table_arn  = module.git.git_provider_connections_table_arn
  source_control_bindings_table_name  = module.git.source_control_bindings_table_name
  source_control_bindings_table_arn   = module.git.source_control_bindings_table_arn
  tracker_connections_table_name      = module.git.tracker_connections_table_name
  tracker_connections_table_arn       = module.git.tracker_connections_table_arn
  github_redirect_uri                 = "https://${module.frontend.cloudfront_domain_name}/github/callback"
  gitlab_redirect_uri                 = "https://${module.frontend.cloudfront_domain_name}/gitlab/callback"
  jira_oauth_secret_name              = module.git.jira_oauth_secret_name
  jira_oauth_secret_arn               = module.git.jira_oauth_secret_arn
  jira_redirect_uri                   = "https://${module.frontend.cloudfront_domain_name}/trackers/callback/jira-cloud"
  cognito_user_pool_id                = module.auth.user_pool_id
  cognito_user_pool_arn               = module.auth.user_pool_arn
  cors_allowed_origins                = "https://${module.frontend.cloudfront_domain_name},http://localhost:5173"
  realtime_doc_secret_param_arn       = module.realtime.realtime_doc_secret_param_arn
  realtime_doc_secret_param_name      = module.realtime.realtime_doc_secret_param_name

  # Discussions feature
  discussion_locks_table_name      = module.dynamodb.discussion_locks_table_name
  discussion_locks_table_arn       = module.dynamodb.discussion_locks_table_arn
  discussion_read_state_table_name = module.dynamodb.discussion_read_state_table_name
  discussion_read_state_table_arn  = module.dynamodb.discussion_read_state_table_arn
  connections_table_name           = module.dynamodb.connections_table_name
  connections_table_arn            = module.dynamodb.connections_table_arn
  websocket_api_endpoint_https     = replace(module.realtime.websocket_api_endpoint, "wss://", "https://")
  websocket_execution_arn          = module.realtime.websocket_execution_arn
}

# API Gateway
module "api" {
  source = "./modules/api"

  project_name                      = var.project_name
  environment                       = var.environment
  cognito_user_pool_arn             = module.auth.user_pool_arn
  projects_lambda_invoke_arn        = module.lambda.projects_lambda_invoke_arn
  projects_lambda_name              = module.lambda.projects_lambda_name
  users_lambda_invoke_arn           = module.lambda.users_lambda_invoke_arn
  users_lambda_name                 = module.lambda.users_lambda_name
  sprints_lambda_invoke_arn         = module.lambda.sprints_lambda_invoke_arn
  sprints_lambda_name               = module.lambda.sprints_lambda_name
  requirements_lambda_invoke_arn    = module.lambda.requirements_lambda_invoke_arn
  requirements_lambda_name          = module.lambda.requirements_lambda_name
  user_stories_lambda_invoke_arn    = module.lambda.user_stories_lambda_invoke_arn
  user_stories_lambda_name          = module.lambda.user_stories_lambda_name
  tasks_lambda_invoke_arn           = module.lambda.tasks_lambda_invoke_arn
  tasks_lambda_name                 = module.lambda.tasks_lambda_name
  general_info_lambda_invoke_arn    = module.lambda.general_info_lambda_invoke_arn
  general_info_lambda_name          = module.lambda.general_info_lambda_name
  code_files_lambda_invoke_arn      = module.lambda.code_files_lambda_invoke_arn
  code_files_lambda_name            = module.lambda.code_files_lambda_name
  reviews_lambda_invoke_arn         = module.lambda.reviews_lambda_invoke_arn
  reviews_lambda_name               = module.lambda.reviews_lambda_name
  questions_lambda_invoke_arn       = module.lambda.questions_lambda_invoke_arn
  questions_lambda_name             = module.lambda.questions_lambda_name
  sprint_graph_lambda_invoke_arn    = module.lambda.sprint_graph_lambda_invoke_arn
  sprint_graph_lambda_name          = module.lambda.sprint_graph_lambda_name
  timeline_events_lambda_invoke_arn = module.lambda.timeline_events_lambda_invoke_arn
  timeline_events_lambda_name       = module.lambda.timeline_events_lambda_name
  discussions_lambda_invoke_arn     = module.lambda.discussions_lambda_invoke_arn
  discussions_lambda_name           = module.lambda.discussions_lambda_name
  building_blocks_lambda_invoke_arn = module.lambda.building_blocks_lambda_invoke_arn
  building_blocks_lambda_name       = module.lambda.building_blocks_lambda_name
  workflows_lambda_invoke_arn       = module.lambda.workflows_lambda_invoke_arn
  workflows_lambda_name             = module.lambda.workflows_lambda_name
  intents_lambda_invoke_arn         = module.lambda.intents_lambda_invoke_arn
  intents_lambda_name               = module.lambda.intents_lambda_name
  github_lambda_invoke_arn          = module.lambda.github_lambda_invoke_arn
  github_lambda_name                = module.lambda.github_lambda_name
  gitlab_lambda_invoke_arn          = module.lambda.gitlab_lambda_invoke_arn
  gitlab_lambda_name                = module.lambda.gitlab_lambda_name
  source_control_lambda_invoke_arn  = module.lambda.source_control_lambda_invoke_arn
  source_control_lambda_name        = module.lambda.source_control_lambda_name
  trackers_lambda_invoke_arn        = module.lambda.trackers_lambda_invoke_arn
  trackers_lambda_name              = module.lambda.trackers_lambda_name
  cognito_users_lambda_invoke_arn   = module.lambda.cognito_users_lambda_invoke_arn
  cognito_users_lambda_name         = module.lambda.cognito_users_lambda_name
  agent_questions_table_name        = module.dynamodb.agent_questions_table_name
  agent_outputs_table_name          = module.dynamodb.agent_outputs_table_name
  agents_lambda_role_arn            = module.lambda.agents_orchestrator_role_arn
  agentcore_runtime_arn             = module.agentcore.runtime_arn
  private_subnet_ids                = module.networking.private_subnet_ids
  lambda_security_group_ids         = [module.lambda.lambda_security_group_id]
  neptune_endpoint                  = module.neptune.cluster_endpoint
  cors_allowed_origins              = "https://${module.frontend.cloudfront_domain_name},http://localhost:5173"
  cloudfront_origin_secret          = module.frontend.cloudfront_origin_secret
  enable_cloudfront_origin_policy   = false
  # Pass a non-deprecated attribute (the account's CloudWatch role ARN, not the
  # deprecated `.id`). The value itself is unused — the api module interpolates it
  # into the stage description to create an implicit dependency so the stage waits
  # for this account-level CloudWatch config (see modules/api/main.tf).
  api_gateway_account_id = aws_api_gateway_account.main.cloudwatch_role_arn
}

# Real-time (WebSocket)
module "realtime" {
  source = "./modules/realtime"

  project_name           = var.project_name
  environment            = var.environment
  cognito_user_pool_id   = module.auth.user_pool_id
  cognito_client_id      = module.auth.user_pool_client_id
  connections_table_name = module.dynamodb.connections_table_name
  connections_table_arn  = module.dynamodb.connections_table_arn

  # The WebSocket stage enables access logging, which requires the account-level
  # CloudWatch role to be configured first.
  depends_on = [aws_api_gateway_account.main]
}

# Yjs Server (ECS)
module "yjs_server" {
  source = "./modules/realtime/yjs-server"

  project_name                  = var.project_name
  environment                   = var.environment
  aws_region                    = var.aws_region
  vpc_id                        = module.networking.vpc_id
  private_subnet_ids            = module.networking.private_subnet_ids
  cognito_user_pool_id          = module.auth.user_pool_id
  cognito_client_id             = module.auth.user_pool_client_id
  realtime_doc_secret_param_arn = module.realtime.realtime_doc_secret_param_arn
  # Serialize the yjs image build after the agentcore image build — concurrent
  # builds from the two docker provider instances deadlock at context
  # transfer. Value-neutral: only creates a dependency edge (see variable).
  build_after = module.agentcore.image_uri
}

# Bedrock AgentCore Runtime — v2 stage execution image + state table.
# Invoked by the v2-orchestrator (per-stage) and the agents lambda (capabilities
# probe). Also owns the agent-settings SSM parameters (Admin UI managed).
# See docs/v2-building-blocks.md (runtime) and docs/v2-agent.md.
module "agentcore" {
  source = "./modules/compute/agentcore"

  project_name                = var.project_name
  environment                 = var.environment
  aws_region                  = var.aws_region
  neptune_endpoint            = module.neptune.cluster_endpoint
  neptune_cluster_resource_id = module.neptune.cluster_resource_id
  artifacts_bucket_name       = module.s3.artifacts_bucket_name
  artifacts_bucket_arn        = module.s3.artifacts_bucket_arn
  blocks_table_name           = module.dynamodb.blocks_table_name
  blocks_table_arn            = module.dynamodb.blocks_table_arn
  connections_table_name      = module.dynamodb.connections_table_name
  connections_table_arn       = module.dynamodb.connections_table_arn
  websocket_endpoint          = replace(module.realtime.websocket_api_endpoint, "wss://", "https://")
  websocket_execution_arn     = module.realtime.websocket_execution_arn
  aidlc_repo_ref              = var.aidlc_repo_ref
  bedrock_model               = var.bedrock_model
  kiro_model                  = "claude-opus-4.6"

  # VPC networking so the runtime's ENIs reach Neptune (private). Subnets are
  # carved in this VPC in AgentCore-supported AZs; egress via the private NAT route.
  vpc_id                  = module.networking.vpc_id
  vpc_cidr                = module.networking.vpc_cidr_block
  private_route_table_ids = module.networking.private_route_table_ids

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# Tombstone for the retired v1 ECS agents module.
#
# Existing installations may still have Docker provider-owned objects in state at
# module.agents.module.agents_docker_build.*. Terraform needs the old child-module
# provider address (module.agents.provider["registry.terraform.io/kreuzwerker/docker"])
# present so it can destroy those orphaned objects. The module intentionally
# contains no resources and can be removed after environments have applied the v1
# retirement once.
module "agents" {
  source = "./modules/compute/agents"
}

# The agent-settings SSM parameters moved from the retired v1 ECS agents module
# (modules/compute/agents) into the agentcore module. The values set via the
# Admin UI survive because the parameters are moved in state, not recreated.
moved {
  from = module.agents.aws_ssm_parameter.bedrock_bearer_token
  to   = module.agentcore.aws_ssm_parameter.bedrock_bearer_token
}

moved {
  from = module.agents.aws_ssm_parameter.cli_models
  to   = module.agentcore.aws_ssm_parameter.cli_models
}

moved {
  from = module.agents.aws_ssm_parameter.kiro_api_key
  to   = module.agentcore.aws_ssm_parameter.kiro_api_key
}

# Git Integration (GitHub OAuth)
module "git" {
  source = "./modules/git"

  project_name = var.project_name
  environment  = var.environment

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# CORS for the artifacts bucket — frontend uploads steering docs directly via
# presigned PUT URLs, so the browser preflight needs the CloudFront origin.
# Defined here (not in module.s3) to avoid a cycle: module.frontend already
# depends on module.s3 for the access-logs bucket.
resource "aws_s3_bucket_cors_configuration" "artifacts" {
  bucket = module.s3.artifacts_bucket_name

  cors_rule {
    allowed_methods = ["GET", "PUT", "HEAD"]
    allowed_origins = [
      "https://${module.frontend.cloudfront_domain_name}",
      "http://localhost:5173",
    ]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
