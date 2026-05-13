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

data "aws_caller_identity" "current" {}
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
  neptune_cluster_arn         = module.neptune.cluster_arn
  neptune_cluster_resource_id = module.neptune.cluster_resource_id
  dynamodb_table_arns = [
    module.dynamodb.sessions_table_arn,
    module.dynamodb.notifications_table_arn,
    module.dynamodb.agent_questions_table_arn,
    module.dynamodb.yjs_documents_table_arn,
    module.dynamodb.agent_pool_table_arn,
    module.dynamodb.agent_outputs_table_arn
  ]
  artifacts_bucket_name      = module.s3.artifacts_bucket_name
  artifacts_bucket_arn       = module.s3.artifacts_bucket_arn
  github_oauth_secret_name   = module.git.github_oauth_secret_name
  github_oauth_secret_arn    = module.git.github_oauth_secret_arn
  git_connections_table_name = module.git.git_connections_table_name
  git_connections_table_arn  = module.git.git_connections_table_arn
  github_redirect_uri        = "https://${module.frontend.cloudfront_domain_name}/github/callback"
  state_machine_arn          = "arn:${local.partition}:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:${var.project_name}-agent-workflow-${var.environment}"
  agent_questions_table_name = module.dynamodb.agent_questions_table_name
  agent_questions_table_arn  = module.dynamodb.agent_questions_table_arn
  cognito_user_pool_id       = module.auth.user_pool_id
  cognito_user_pool_arn      = module.auth.user_pool_arn
  cors_allowed_origins       = "https://${module.frontend.cloudfront_domain_name},http://localhost:5173"

  # IAM scoping inputs for the agents-orchestrator role (ECS RunTask / PassRole).
  ecs_cluster_arn                  = module.compute.cluster_arn
  agent_task_definition_family_arn = module.agents.agent_task_definition_family_arn
  agent_task_role_arn              = module.agents.agent_task_role_arn
  agent_execution_role_arn         = module.agents.agent_execution_role_arn
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
  github_lambda_invoke_arn          = module.lambda.github_lambda_invoke_arn
  github_lambda_name                = module.lambda.github_lambda_name
  github_issues_lambda_invoke_arn   = module.lambda.github_issues_lambda_invoke_arn
  github_issues_lambda_name         = module.lambda.github_issues_lambda_name
  cognito_users_lambda_invoke_arn   = module.lambda.cognito_users_lambda_invoke_arn
  cognito_users_lambda_name         = module.lambda.cognito_users_lambda_name
  state_machine_arn                 = module.orchestration.state_machine_arn
  agent_questions_table_name        = module.dynamodb.agent_questions_table_name
  agent_outputs_table_name          = module.dynamodb.agent_outputs_table_name
  agents_lambda_role_arn            = module.lambda.agents_orchestrator_role_arn
  private_subnet_ids                = module.networking.private_subnet_ids
  lambda_security_group_ids         = [module.lambda.lambda_security_group_id]
  neptune_endpoint                  = module.neptune.cluster_endpoint
  ecs_cluster_arn                   = module.compute.cluster_arn
  agent_task_definition_arn         = module.agents.agent_task_definition_arn
  agent_security_group_id           = module.agents.agent_security_group_id
  agent_pool_table_name             = module.dynamodb.agent_pool_table_name
  ecr_repository_name               = module.agents.ecr_repository_name
  agent_image_tag                   = module.agents.agent_image_tag
  git_connections_table_name        = module.git.git_connections_table_name
  cors_allowed_origins              = "https://${module.frontend.cloudfront_domain_name},http://localhost:5173"
  cloudfront_origin_secret          = module.frontend.cloudfront_origin_secret
  enable_cloudfront_origin_policy   = false
  api_gateway_account_id            = aws_api_gateway_account.main.id
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

  project_name         = var.project_name
  environment          = var.environment
  aws_region           = var.aws_region
  vpc_id               = module.networking.vpc_id
  private_subnet_ids   = module.networking.private_subnet_ids
  cognito_user_pool_id = module.auth.user_pool_id
  cognito_client_id    = module.auth.user_pool_client_id
}

# ECS Cluster for Agents
module "compute" {
  source = "./modules/compute"

  project_name = var.project_name
  environment  = var.environment

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# Agent Questions (submit question Lambda - needed before agents)
module "agent_questions" {
  source = "./modules/agent-questions"

  project_name               = var.project_name
  environment                = var.environment
  agent_questions_table_name = module.dynamodb.agent_questions_table_name
  agent_questions_table_arn  = module.dynamodb.agent_questions_table_arn
  connections_table_name     = module.dynamodb.connections_table_name
  connections_table_arn      = module.dynamodb.connections_table_arn
  websocket_api_endpoint     = module.realtime.websocket_api_endpoint
  websocket_execution_arn    = module.realtime.websocket_execution_arn

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# Agent Task Definitions
module "agents" {
  source = "./modules/compute/agents"

  project_name                = var.project_name
  environment                 = var.environment
  aws_region                  = var.aws_region
  vpc_id                      = module.networking.vpc_id
  private_subnet_ids          = module.networking.private_subnet_ids
  neptune_endpoint            = module.neptune.cluster_endpoint
  neptune_cluster_arn         = module.neptune.cluster_arn
  neptune_cluster_resource_id = module.neptune.cluster_resource_id
  artifacts_bucket_name       = module.s3.artifacts_bucket_name
  artifacts_bucket_arn        = module.s3.artifacts_bucket_arn
  code_snapshots_bucket_name  = module.s3.code_snapshots_bucket_name
  code_snapshots_bucket_arn   = module.s3.code_snapshots_bucket_arn
  agent_questions_table_arn   = module.dynamodb.agent_questions_table_arn
  agent_outputs_table_name    = module.dynamodb.agent_outputs_table_name
  agent_outputs_table_arn     = module.dynamodb.agent_outputs_table_arn
  submit_question_lambda_name = module.agent_questions.submit_question_lambda_name
  submit_question_lambda_arn  = module.agent_questions.submit_question_lambda_arn
  git_connections_table_name  = module.git.git_connections_table_name
  git_connections_table_arn   = module.git.git_connections_table_arn
  agent_questions_table_name  = module.dynamodb.agent_questions_table_name
  connections_table_name      = module.dynamodb.connections_table_name
  connections_table_arn       = module.dynamodb.connections_table_arn
  websocket_endpoint          = replace(module.realtime.websocket_api_endpoint, "wss://", "https://")
  websocket_execution_arn     = module.realtime.websocket_execution_arn
  ecs_cluster_arn             = module.compute.cluster_arn
  agent_pool_table_name       = module.dynamodb.agent_pool_table_name
  agent_pool_table_arn        = module.dynamodb.agent_pool_table_arn
  agents_lambda_name          = "${var.project_name}-agents-${var.environment}"
  agents_lambda_arn           = "arn:${local.partition}:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-agents-${var.environment}"
  create_pr_lambda_name       = module.orchestration.create_pr_lambda_name
  create_pr_lambda_arn        = module.orchestration.create_pr_lambda_arn
  kiro_model                  = "claude-opus-4.6"

  # Bedrock model pinning for claude and opencode drivers.
  bedrock_model = var.bedrock_model

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# Step Functions Orchestration
module "orchestration" {
  source = "./modules/orchestration"

  project_name                     = var.project_name
  environment                      = var.environment
  aws_region                       = var.aws_region
  ecs_cluster_arn                  = module.compute.cluster_arn
  private_subnet_ids               = module.networking.private_subnet_ids
  agent_security_group_id          = module.agents.agent_security_group_id
  agent_execution_role_arn         = module.agents.agent_execution_role_arn
  agent_task_role_arn              = module.agents.agent_task_role_arn
  agent_task_definition_arn        = module.agents.agent_task_definition_arn
  agent_task_definition_family_arn = module.agents.agent_task_definition_family_arn
  agent_questions_table_name       = module.dynamodb.agent_questions_table_name
  agent_questions_table_arn        = module.dynamodb.agent_questions_table_arn
  agent_outputs_table_name         = module.dynamodb.agent_outputs_table_name
  agent_outputs_table_arn          = module.dynamodb.agent_outputs_table_arn
  connections_table_name           = module.dynamodb.connections_table_name
  connections_table_arn            = module.dynamodb.connections_table_arn
  websocket_api_endpoint           = module.realtime.websocket_api_endpoint
  websocket_execution_arn          = module.realtime.websocket_execution_arn

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# EventBridge for Agent Events
module "events" {
  source = "./modules/events"

  project_name            = var.project_name
  environment             = var.environment
  connections_table_name  = module.dynamodb.connections_table_name
  connections_table_arn   = module.dynamodb.connections_table_arn
  websocket_api_endpoint  = module.realtime.websocket_api_endpoint
  websocket_execution_arn = module.realtime.websocket_execution_arn

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
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
