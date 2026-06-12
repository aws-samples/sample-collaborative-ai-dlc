data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_ecr_authorization_token" "token" {}

terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

provider "docker" {
  # Support for Podman via DOCKER_HOST environment variable (e.g., unix:///path/to/podman.sock)
  # If DOCKER_HOST is not set, defaults to the standard Docker socket
  registry_auth {
    address  = format("%v.dkr.ecr.%v.%v", data.aws_caller_identity.current.account_id, data.aws_region.current.id, data.aws_partition.current.dns_suffix)
    username = data.aws_ecr_authorization_token.token.user_name
    password = data.aws_ecr_authorization_token.token.password
  }
}

# ECR Repository for Agents
resource "aws_ecr_repository" "agents" {
  name                 = "${var.project_name}-agents-${var.environment}"
  image_tag_mutability = "MUTABLE"
  force_delete         = var.environment == "dev"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = var.tags
}

resource "aws_ecr_lifecycle_policy" "agents" {
  repository = aws_ecr_repository.agents.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep only the last 3 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 3
      }
      action = {
        type = "expire"
      }
    }]
  })
}

# Calculate hash of all source files for change detection
locals {
  agents_source_path = abspath("${path.module}/../../../../lambda")

  path_include = ["agents-ecs/**", "shared/mcp-validator.js"]
  path_exclude = ["**/node_modules/**", "**/.git/**"]

  agents_files_include = setunion([for f in local.path_include : fileset(local.agents_source_path, f)]...)
  agents_files_exclude = setunion([for f in local.path_exclude : fileset(local.agents_source_path, f)]...)
  agents_files         = sort(setsubtract(local.agents_files_include, local.agents_files_exclude))
  agents_files_sha     = sha1(join("", [for f in local.agents_files : filesha1("${local.agents_source_path}/${f}")]))
  agents_image_tag     = substr(local.agents_files_sha, 0, 16)

  # Partition-aware helpers
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix
}

# Docker build module
module "agents_docker_build" {
  source  = "terraform-aws-modules/lambda/aws//modules/docker-build"
  version = "~> 7.0"

  create_ecr_repo = false
  ecr_repo        = aws_ecr_repository.agents.name
  ecr_address     = format("%v.dkr.ecr.%v.%v", data.aws_caller_identity.current.account_id, data.aws_region.current.id, local.dns_suffix)

  use_image_tag    = true
  image_tag        = local.agents_image_tag
  source_path      = local.agents_source_path
  docker_file_path = "${local.agents_source_path}/agents-ecs/Dockerfile"
  platform         = "linux/amd64"
  # Use the buildx "default" builder (BuildKit session) instead of the
  # provider's legacy /build path. The legacy path streams the whole context
  # as a single tar.gz and corrupts it on large contexts (unpigz: invalid
  # deflate data); the BuildKit session transfers files incrementally and
  # applies .dockerignore client-side. "default" exists on every Docker
  # Desktop and docker-engine install.
  builder = "default"

  build_args = {
    IMAGE_TAG = local.agents_image_tag
  }

  triggers = {
    dir_sha = local.agents_files_sha
  }
}

# ---------------------------------------------------------------------------
# Agent Settings — SSM Parameters (managed via Admin UI at runtime)
# ---------------------------------------------------------------------------

# Bedrock bearer token — optional alternative to IAM role auth.
# Created with a placeholder value; updated at runtime via the Admin UI.
resource "aws_ssm_parameter" "bedrock_bearer_token" {
  name        = "/${var.project_name}/${var.environment}/bedrock-bearer-token"
  description = "AWS_BEARER_TOKEN_BEDROCK for Claude Code / OpenCode (leave blank to use IAM role)"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    # Never overwrite a value that was set via the Admin UI
    ignore_changes = [value]
  }

  tags = var.tags
}

# Extra MCP servers — JSON array of additional MCP server definitions.
# Created with an empty array; updated at runtime via the Admin UI.
resource "aws_ssm_parameter" "mcp_servers" {
  name        = "/${var.project_name}/${var.environment}/mcp-servers"
  description = "Additional MCP server definitions for agent sessions (JSON array)"
  type        = "String"
  value       = "[]"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

# Kiro API key — stored as SecureString; set via Admin UI.
# Created with a placeholder; the driver treats "placeholder" as "not configured".
resource "aws_ssm_parameter" "kiro_api_key" {
  name        = "/${var.project_name}/${var.environment}/kiro-api-key"
  description = "KIRO_API_KEY for Kiro CLI authentication"
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = var.tags
}

# Task Execution Role (ECR pull, CloudWatch logs)
resource "aws_iam_role" "agent_execution" {
  name = "${var.project_name}-agent-execution-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.${local.dns_suffix}" }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "agent_execution" {
  role       = aws_iam_role.agent_execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Task Role (Neptune, S3, DynamoDB, SSM, Secrets Manager access)
resource "aws_iam_role" "agent_task" {
  name = "${var.project_name}-agent-task-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.${local.dns_suffix}" }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "agent_task" {
  name = "agent-task-policy"
  role = aws_iam_role.agent_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "neptune-db:ReadDataViaQuery",
          "neptune-db:WriteDataViaQuery",
          "neptune-db:DeleteDataViaQuery",
          "neptune-db:connect"
        ]
        Resource = "arn:${local.partition}:neptune-db:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:${var.neptune_cluster_resource_id}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = [var.artifacts_bucket_arn, "${var.artifacts_bucket_arn}/*", var.code_snapshots_bucket_arn, "${var.code_snapshots_bucket_arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = compact([var.agent_questions_table_arn, var.agent_outputs_table_arn, var.git_connections_table_arn, var.connections_table_arn, var.agent_pool_table_arn])
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:DeleteItem"]
        Resource = compact([var.agent_pool_table_arn])
      },
      {
        # Assist-lock heartbeat + release: the pool
        # worker renews `assist:{discussionId}` while a discussion session
        # runs and deletes it on completion.
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = compact([var.discussion_locks_table_arn])
      },
      {
        Effect = "Allow"
        Action = ["dynamodb:Query"]
        Resource = compact([
          var.connections_table_arn != "" ? "${var.connections_table_arn}/index/*" : "",
          var.agent_pool_table_arn != "" ? "${var.agent_pool_table_arn}/index/*" : ""
        ])
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.agents.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = compact([var.submit_question_lambda_arn, var.agents_lambda_arn, var.create_pr_lambda_arn])
      },
      {
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = var.websocket_execution_arn != "" ? "${var.websocket_execution_arn}/*" : "arn:${local.partition}:execute-api:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:*"
      },
      # SSM: read agent settings (bearer token + MCP servers) at container startup
      # NOTE: No Bedrock IAM permissions — Claude and OpenCode authenticate exclusively
      # via AWS_BEARER_TOKEN_BEDROCK (set via Kiro SSO or the Admin UI bearer token).
      # If no token is configured those CLIs will fail auth and won't be advertised.
      {
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = [
          aws_ssm_parameter.bedrock_bearer_token.arn,
          aws_ssm_parameter.mcp_servers.arn,
          aws_ssm_parameter.kiro_api_key.arn,
        ]
      },
      # ssmmessages:* must use Resource = "*" per AWS IAM service authorization reference
      # — these actions do not support resource-level permissions. Required for ECS Exec
      # (interactive container access via SSM Session Manager). Scoping to our tasks is
      # enforced upstream: ECS Exec is gated by ecs:ExecuteCommand on the cluster, and the
      # control/data channels are session-bound.
      {
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel"
        ]
        Resource = "*"
      }
    ]
  })
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "agents" {
  name              = "/ecs/${var.project_name}-agents-${var.environment}"
  retention_in_days = var.environment == "prod" ? 30 : 7

  tags = var.tags
}

# Security Group for Agents
resource "aws_security_group" "agents" {
  name_prefix = "${var.project_name}-agents-${var.environment}"
  description = "Security group for agent ECS tasks (Kiro/Claude/OpenCode CLI runners); no ingress, egress only"
  vpc_id      = var.vpc_id

  egress {
    description = "Allow egress for AWS API calls (Bedrock, S3, DynamoDB, CloudWatch, SSM) and agent CLI tool HTTPS calls"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}

# Unified Agent Task Definition
resource "aws_ecs_task_definition" "agent" {
  family                   = "${var.project_name}-agent-${var.environment}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.agent_execution.arn
  task_role_arn            = aws_iam_role.agent_task.arn

  container_definitions = jsonencode([{
    name        = "agent"
    image       = module.agents_docker_build.image_uri
    essential   = true
    stopTimeout = 120
    healthCheck = {
      command     = ["CMD-SHELL", "ps aux | grep -q '[p]ool-worker' || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
    environment = [
      { name = "POOL_MODE", value = "true" },
      { name = "POOL_TABLE", value = var.agent_pool_table_name },
      { name = "POOL_VERSION", value = local.agents_image_tag },
      { name = "NEPTUNE_ENDPOINT", value = var.neptune_endpoint },
      { name = "ARTIFACTS_BUCKET", value = var.artifacts_bucket_name },
      { name = "CODE_SNAPSHOTS_BUCKET", value = var.code_snapshots_bucket_name },
      { name = "SUBMIT_QUESTION_LAMBDA", value = var.submit_question_lambda_name },
      { name = "AGENT_OUTPUTS_TABLE", value = var.agent_outputs_table_name },
      { name = "GIT_CONNECTIONS_TABLE", value = var.git_connections_table_name },
      { name = "QUESTIONS_TABLE", value = var.agent_questions_table_name },
      { name = "CONNECTIONS_TABLE", value = var.connections_table_name },
      { name = "WEBSOCKET_ENDPOINT", value = var.websocket_endpoint },
      { name = "LOCKS_TABLE", value = var.discussion_locks_table_name },
      { name = "AGENTS_LAMBDA_NAME", value = var.agents_lambda_name },
      { name = "CREATE_PR_LAMBDA_NAME", value = var.create_pr_lambda_name },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "KIRO_MODEL", value = var.kiro_model },
      # Bedrock model pinning (passed through to claude and opencode drivers)
      { name = "BEDROCK_MODEL", value = var.bedrock_model },
      { name = "ANTHROPIC_MODEL", value = var.bedrock_model },
      { name = "ANTHROPIC_SMALL_FAST_MODEL", value = var.bedrock_small_fast_model },
      # Extra MCP servers + Bedrock bearer token SSM paths (agents read at startup)
      { name = "BEDROCK_BEARER_TOKEN_SSM_PATH", value = aws_ssm_parameter.bedrock_bearer_token.name },
      { name = "MCP_SERVERS_SSM_PATH", value = aws_ssm_parameter.mcp_servers.name },
      { name = "KIRO_API_KEY_SSM_PATH", value = aws_ssm_parameter.kiro_api_key.name },
      # Git identity for commits the agents create (overridable per deployment).
      { name = "GIT_AUTHOR_NAME", value = var.git_author_name },
      { name = "GIT_AUTHOR_EMAIL", value = var.git_author_email },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.agents.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "agent"
      }
    }
  }])

  tags = var.tags
}
