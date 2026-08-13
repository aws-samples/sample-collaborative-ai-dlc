terraform {
  # terraform_data (used for plan-time configuration guards) requires 1.4.
  required_version = ">= 1.4"
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
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
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

# CloudFront viewer certificates must live in us-east-1 regardless of where the
# rest of the stack is deployed. Used only by module.domain.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

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

  custom_domain_enabled = var.app_domain != ""

  # Canonical hostname and URL for the deployment. Every consumer — OAuth
  # redirect URIs, CORS allowlists, the application_url output and the frontend
  # build — derives from these two values rather than recomputing the host.
  app_domain = local.custom_domain_enabled ? var.app_domain : module.frontend.cloudfront_domain_name
  app_url    = "https://${local.app_domain}"

  # All hostnames CloudFront answers on. Empty without a custom domain, which
  # keeps the distribution on its default certificate.
  app_aliases = local.custom_domain_enabled ? distinct(concat([var.app_domain], var.app_domain_aliases)) : []

  # The CloudFront domain stays in the allowlist alongside any custom domain.
  # It costs nothing, makes enabling a custom domain a zero-downtime change for
  # already-loaded bundles, and leaves operators a working entry point when
  # custom DNS is misconfigured. The canonical origin is first because
  # lambda/shared/response.js falls back to the first entry for unknown origins.
  cors_origin_list = distinct(concat(
    ["https://${local.app_domain}"],
    [for a in local.app_aliases : "https://${a}"],
    ["https://${module.frontend.cloudfront_domain_name}"],
    ["http://localhost:5173"],
  ))
  cors_allowed_origins = join(",", local.cors_origin_list)

  sso_enabled = var.auth_mode != "local"

  sso_role_config = {
    providers = {
      for name, provider in var.sso_providers : name => {
        roleMappings        = provider.role_mappings
        requiredClaimValues = provider.required_claim_values
      }
    }
  }
}

resource "terraform_data" "sso_preconditions" {
  input = nonsensitive(var.sso_providers)

  lifecycle {
    precondition {
      condition     = local.sso_enabled == (length(var.sso_providers) > 0)
      error_message = "local auth_mode requires no SSO providers; hybrid and sso-only require at least one."
    }

    precondition {
      condition = var.auth_mode != "sso-only" || anytrue([
        for provider in values(var.sso_providers) :
        length(lookup(provider.role_mappings, "platform-admin", [])) > 0
      ])
      error_message = "sso-only auth_mode requires at least one platform-admin role mapping."
    }

    precondition {
      condition = alltrue([
        for provider in values(var.sso_providers) :
        lower(provider.type) != "oidc" || (
          provider.issuer_url != "" &&
          provider.client_id != "" &&
          provider.client_secret_arn != "" &&
          contains(provider.scopes, "openid")
        )
      ])
      error_message = "OIDC providers require issuer_url, client_id, client_secret_arn, and the openid scope."
    }

    precondition {
      condition = alltrue([
        for provider in values(var.sso_providers) :
        lower(provider.type) != "saml" ||
        ((provider.metadata_url != "") != (provider.metadata_xml != ""))
      ])
      error_message = "SAML providers require exactly one of metadata_url or metadata_xml."
    }

    precondition {
      condition = alltrue([
        for provider in values(var.sso_providers) :
        (length(provider.role_mappings) == 0 && length(provider.required_claim_values) == 0) ||
        provider.role_claim != ""
      ])
      error_message = "Providers with role mappings or access gates require role_claim."
    }

    precondition {
      condition = alltrue(flatten([
        for provider in values(var.sso_providers) : [
          for role in keys(provider.role_mappings) :
          contains(jsondecode(file("${path.module}/../config/platform-roles.json")), role)
        ]
      ]))
      error_message = "SSO role mappings may only target roles implemented by this release."
    }

    precondition {
      condition     = length(jsonencode(local.sso_role_config)) <= 3500
      error_message = "The normalized SSO role configuration exceeds the Lambda environment limit. Reduce provider mappings."
    }
  }
}

# Fails the plan on custom domain configurations that would otherwise surface as
# an opaque error minutes into a CloudFront apply. scripts/install.sh performs
# the same checks (plus certificate coverage and alias collisions) up front;
# these are the backstop for direct terraform runs.
resource "terraform_data" "domain_preconditions" {
  input = var.app_domain

  lifecycle {
    precondition {
      condition     = var.app_domain != "" || length(var.app_domain_aliases) == 0
      error_message = "app_domain_aliases is set but app_domain is empty. Set app_domain to the canonical hostname; aliases are additional names for the same deployment."
    }

    precondition {
      condition     = var.app_domain == "" || var.acm_certificate_arn != "" || var.route53_zone_id != ""
      error_message = "app_domain is set but neither acm_certificate_arn nor route53_zone_id was provided. Supply an existing us-east-1 certificate ARN, or a Route53 hosted zone ID so Terraform can request and validate one."
    }

    precondition {
      condition     = var.app_domain != "" || (var.acm_certificate_arn == "" && var.route53_zone_id == "")
      error_message = "acm_certificate_arn or route53_zone_id is set but app_domain is empty. Set app_domain to enable the custom domain, or clear both to serve on the CloudFront domain."
    }
  }
}

# Certificate first, then the distribution that references it, then the alias
# records that point at the distribution. Splitting the certificate and the
# records into different graph positions is what avoids a dependency cycle.
module "domain" {
  source = "./modules/domain"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  project_name    = var.project_name
  environment     = var.environment
  enabled         = local.custom_domain_enabled
  domain_name     = var.app_domain
  aliases         = var.app_domain_aliases
  certificate_arn = var.acm_certificate_arn
  route53_zone_id = var.route53_zone_id
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

  project_name  = var.project_name
  environment   = var.environment
  app_url       = local.app_url
  auth_mode     = var.auth_mode
  sso_providers = var.sso_providers
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
  aliases                        = local.app_aliases
  acm_certificate_arn            = module.domain.certificate_arn
}

# Route53 alias records for the custom domain. Only created when the hosted zone
# lives in this account; otherwise the dns_target and dns_target_hosted_zone_id
# outputs carry everything an external DNS provider needs.
#
# Both record types are required because the distribution has is_ipv6_enabled.
resource "aws_route53_record" "app" {
  for_each = var.route53_zone_id == "" ? {} : {
    for pair in setproduct(local.app_aliases, ["A", "AAAA"]) :
    "${pair[0]}-${pair[1]}" => { name = pair[0], type = pair[1] }
  }

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type

  alias {
    name                   = module.frontend.cloudfront_domain_name
    zone_id                = module.frontend.cloudfront_hosted_zone_id
    evaluate_target_health = false
  }
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
  lambda_vpc_scope            = var.lambda_vpc_scope
  aidlc_repo_ref              = var.aidlc_repo_ref
  application_url             = local.app_url
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
  artifacts_bucket_name                    = module.s3.artifacts_bucket_name
  artifacts_bucket_arn                     = module.s3.artifacts_bucket_arn
  blocks_table_name                        = module.dynamodb.blocks_table_name
  blocks_table_arn                         = module.dynamodb.blocks_table_arn
  v2_executions_table_name                 = module.agentcore.v2_executions_table_name
  v2_executions_table_arn                  = module.agentcore.v2_executions_table_arn
  yjs_documents_table_name                 = module.dynamodb.yjs_documents_table_name
  yjs_documents_table_arn                  = module.dynamodb.yjs_documents_table_arn
  agentcore_runtime_arn                    = module.agentcore.runtime_arn
  github_oauth_secret_name                 = module.git.github_oauth_secret_name
  github_oauth_secret_arn                  = module.git.github_oauth_secret_arn
  github_app_private_key_secret_name       = module.git.github_app_private_key_secret_name
  github_app_private_key_secret_arn        = module.git.github_app_private_key_secret_arn
  github_app_config_param_name             = module.git.github_app_config_param_name
  github_app_config_param_arn              = module.git.github_app_config_param_arn
  gitlab_oauth_secret_name                 = module.git.gitlab_oauth_secret_name
  gitlab_oauth_secret_arn                  = module.git.gitlab_oauth_secret_arn
  bitbucket_oauth_secret_name              = module.git.bitbucket_oauth_secret_name
  bitbucket_oauth_secret_arn               = module.git.bitbucket_oauth_secret_arn
  git_connections_table_name               = module.git.git_connections_table_name
  git_connections_table_arn                = module.git.git_connections_table_arn
  git_provider_connections_table_name      = module.git.git_provider_connections_table_name
  git_provider_connections_table_arn       = module.git.git_provider_connections_table_arn
  source_control_bindings_table_name       = module.git.source_control_bindings_table_name
  source_control_bindings_table_arn        = module.git.source_control_bindings_table_arn
  tracker_connections_table_name           = module.git.tracker_connections_table_name
  tracker_connections_table_arn            = module.git.tracker_connections_table_arn
  github_redirect_uri                      = "${local.app_url}/github/callback"
  gitlab_redirect_uri                      = "${local.app_url}/gitlab/callback"
  bitbucket_redirect_uri                   = "${local.app_url}/bitbucket/callback"
  jira_oauth_secret_name                   = module.git.jira_oauth_secret_name
  jira_oauth_secret_arn                    = module.git.jira_oauth_secret_arn
  jira_redirect_uri                        = "${local.app_url}/trackers/callback/jira-cloud"
  cognito_user_pool_id                     = module.auth.user_pool_id
  cognito_user_pool_arn                    = module.auth.user_pool_arn
  sso_role_config                          = jsonencode(local.sso_role_config)
  cors_allowed_origins                     = local.cors_allowed_origins
  realtime_doc_secret_param_arn            = module.realtime.realtime_doc_secret_param_arn
  realtime_doc_secret_param_name           = module.realtime.realtime_doc_secret_param_name
  agent_credential_grant_secret_param_arn  = aws_ssm_parameter.agent_credential_grant_secret.arn
  agent_credential_grant_secret_param_name = aws_ssm_parameter.agent_credential_grant_secret.name

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

  project_name                             = var.project_name
  environment                              = var.environment
  cognito_user_pool_arn                    = module.auth.user_pool_arn
  projects_lambda_invoke_arn               = module.lambda.projects_lambda_invoke_arn
  projects_lambda_name                     = module.lambda.projects_lambda_name
  users_lambda_invoke_arn                  = module.lambda.users_lambda_invoke_arn
  users_lambda_name                        = module.lambda.users_lambda_name
  sprints_lambda_invoke_arn                = module.lambda.sprints_lambda_invoke_arn
  sprints_lambda_name                      = module.lambda.sprints_lambda_name
  requirements_lambda_invoke_arn           = module.lambda.requirements_lambda_invoke_arn
  requirements_lambda_name                 = module.lambda.requirements_lambda_name
  user_stories_lambda_invoke_arn           = module.lambda.user_stories_lambda_invoke_arn
  user_stories_lambda_name                 = module.lambda.user_stories_lambda_name
  tasks_lambda_invoke_arn                  = module.lambda.tasks_lambda_invoke_arn
  tasks_lambda_name                        = module.lambda.tasks_lambda_name
  general_info_lambda_invoke_arn           = module.lambda.general_info_lambda_invoke_arn
  general_info_lambda_name                 = module.lambda.general_info_lambda_name
  code_files_lambda_invoke_arn             = module.lambda.code_files_lambda_invoke_arn
  code_files_lambda_name                   = module.lambda.code_files_lambda_name
  reviews_lambda_invoke_arn                = module.lambda.reviews_lambda_invoke_arn
  reviews_lambda_name                      = module.lambda.reviews_lambda_name
  questions_lambda_invoke_arn              = module.lambda.questions_lambda_invoke_arn
  questions_lambda_name                    = module.lambda.questions_lambda_name
  sprint_graph_lambda_invoke_arn           = module.lambda.sprint_graph_lambda_invoke_arn
  sprint_graph_lambda_name                 = module.lambda.sprint_graph_lambda_name
  timeline_events_lambda_invoke_arn        = module.lambda.timeline_events_lambda_invoke_arn
  timeline_events_lambda_name              = module.lambda.timeline_events_lambda_name
  discussions_lambda_invoke_arn            = module.lambda.discussions_lambda_invoke_arn
  discussions_lambda_name                  = module.lambda.discussions_lambda_name
  building_blocks_lambda_invoke_arn        = module.lambda.building_blocks_lambda_invoke_arn
  building_blocks_lambda_name              = module.lambda.building_blocks_lambda_name
  workflows_lambda_invoke_arn              = module.lambda.workflows_lambda_invoke_arn
  workflows_lambda_name                    = module.lambda.workflows_lambda_name
  intents_lambda_invoke_arn                = module.lambda.intents_lambda_invoke_arn
  intents_lambda_name                      = module.lambda.intents_lambda_name
  github_lambda_invoke_arn                 = module.lambda.github_lambda_invoke_arn
  github_lambda_name                       = module.lambda.github_lambda_name
  gitlab_lambda_invoke_arn                 = module.lambda.gitlab_lambda_invoke_arn
  gitlab_lambda_name                       = module.lambda.gitlab_lambda_name
  bitbucket_lambda_invoke_arn              = module.lambda.bitbucket_lambda_invoke_arn
  bitbucket_lambda_name                    = module.lambda.bitbucket_lambda_name
  source_control_lambda_invoke_arn         = module.lambda.source_control_lambda_invoke_arn
  source_control_lambda_name               = module.lambda.source_control_lambda_name
  trackers_lambda_invoke_arn               = module.lambda.trackers_lambda_invoke_arn
  trackers_lambda_name                     = module.lambda.trackers_lambda_name
  cognito_users_lambda_invoke_arn          = module.lambda.cognito_users_lambda_invoke_arn
  cognito_users_lambda_name                = module.lambda.cognito_users_lambda_name
  agent_questions_table_name               = module.dynamodb.agent_questions_table_name
  agent_outputs_table_name                 = module.dynamodb.agent_outputs_table_name
  agents_lambda_role_arn                   = module.lambda.agents_orchestrator_role_arn
  agentcore_runtime_arn                    = module.agentcore.runtime_arn
  agent_credential_grant_secret_param_name = aws_ssm_parameter.agent_credential_grant_secret.name
  private_subnet_ids                       = module.networking.private_subnet_ids
  lambda_security_group_ids                = [module.lambda.lambda_security_group_id]
  neptune_endpoint                         = module.neptune.cluster_endpoint
  cors_allowed_origins                     = local.cors_allowed_origins
  cloudfront_origin_secret                 = module.frontend.cloudfront_origin_secret
  enable_cloudfront_origin_policy          = false
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
  docker_build_args             = var.docker_build_args
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
  docker_build_args           = var.docker_build_args
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
  # The kiro-cli build shipped in the agentcore image only accepts the "auto"
  # model selector; a concrete model id (e.g. "claude-opus-4.6") is rejected at
  # spawn with `error: Model '...' does not exist. Available models: auto`,
  # failing every stage with cli_nonzero_exit. Let kiro resolve the model.
  kiro_model  = "auto"
  codex_model = var.codex_model

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

# CORS for the artifacts bucket — frontend uploads steering docs and attachments
# directly via presigned PUT/POST URLs, so the browser preflight needs the
# application origin.
# Defined here (not in module.s3) to avoid a cycle: module.frontend already
# depends on module.s3 for the access-logs bucket.
resource "aws_s3_bucket_cors_configuration" "artifacts" {
  bucket = module.s3.artifacts_bucket_name

  cors_rule {
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = local.cors_origin_list
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
