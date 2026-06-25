data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_ecr_authorization_token" "token" {}

# Bedrock AgentCore Runtime is exposed through the AWS Cloud Control provider
# (awscc) — the resource type AWS::BedrockAgentCore::Runtime is new and not yet a
# first-class hashicorp/aws resource. The rest of the stack stays on hashicorp/aws;
# this is the single awscc resource. The kreuzwerker/docker provider is reused for
# the (ARM64) image build, mirroring the compute/agents + realtime/yjs-server modules.
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
    awscc = {
      source  = "hashicorp/awscc"
      version = "~> 1.0"
    }
  }
}

provider "docker" {
  registry_auth {
    address  = format("%v.dkr.ecr.%v.%v", data.aws_caller_identity.current.account_id, data.aws_region.current.id, data.aws_partition.current.dns_suffix)
    username = data.aws_ecr_authorization_token.token.user_name
    password = data.aws_ecr_authorization_token.token.password
  }
}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix

  # Build context is the repo `lambda/` dir so the image can COPY both the
  # agentcore package and the shared/ helpers it imports via ../shared.
  agentcore_source_path = abspath("${path.module}/../../../../lambda")

  path_include = ["agentcore/**", "shared/**"]
  path_exclude = ["**/node_modules/**", "**/.git/**", "**/test/**", "**/.build/**"]

  agentcore_files_include = setunion([for f in local.path_include : fileset(local.agentcore_source_path, f)]...)
  agentcore_files_exclude = setunion([for f in local.path_exclude : fileset(local.agentcore_source_path, f)]...)
  agentcore_files         = sort(setsubtract(local.agentcore_files_include, local.agentcore_files_exclude))
  agentcore_files_sha     = sha1(join("", [for f in local.agentcore_files : filesha1("${local.agentcore_source_path}/${f}")]))
  agentcore_image_tag     = substr(local.agentcore_files_sha, 0, 16)

  billing_mode   = var.environment == "prod" ? "PROVISIONED" : "PAY_PER_REQUEST"
  read_capacity  = var.environment == "prod" ? 5 : null
  write_capacity = var.environment == "prod" ? 5 : null
}

# ---------------------------------------------------------------------------
# ECR + ARM64 image build (AgentCore Runtime requires arm64)
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "agentcore" {
  name                 = "${var.project_name}-agentcore-${var.environment}"
  image_tag_mutability = "MUTABLE"
  force_delete         = var.environment == "dev"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = var.tags
}

resource "aws_ecr_lifecycle_policy" "agentcore" {
  repository = aws_ecr_repository.agentcore.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep only the last 3 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 3 }
      action       = { type = "expire" }
    }]
  })
}

module "agentcore_docker_build" {
  source  = "terraform-aws-modules/lambda/aws//modules/docker-build"
  version = "~> 7.0"

  create_ecr_repo = false
  ecr_repo        = aws_ecr_repository.agentcore.name
  ecr_address     = format("%v.dkr.ecr.%v.%v", data.aws_caller_identity.current.account_id, data.aws_region.current.id, local.dns_suffix)

  use_image_tag    = true
  image_tag        = local.agentcore_image_tag
  source_path      = local.agentcore_source_path
  docker_file_path = "${local.agentcore_source_path}/agentcore/Dockerfile"
  # AgentCore Runtime runs arm64 only.
  platform = "linux/arm64"
  builder  = "default"

  triggers = {
    dir_sha = local.agentcore_files_sha
  }
}

# ---------------------------------------------------------------------------
# v2 process/state table (EXEC#/STAGE#/EVENT#/HUMAN#/METRIC#/OUTPUT#)
#   GSI1 = project-status browse, GSI2 = per-execution type/state
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "v2_executions" {
  name           = "${var.project_name}-v2-executions-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "pk"
  range_key      = "sk"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "GSI1PK"
    type = "S"
  }
  attribute {
    name = "GSI1SK"
    type = "S"
  }
  attribute {
    name = "GSI2PK"
    type = "S"
  }
  attribute {
    name = "GSI2SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    projection_type = "ALL"
    read_capacity   = local.read_capacity
    write_capacity  = local.write_capacity
    key_schema {
      attribute_name = "GSI1PK"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "GSI1SK"
      key_type       = "RANGE"
    }
  }

  global_secondary_index {
    name            = "GSI2"
    projection_type = "ALL"
    read_capacity   = local.read_capacity
    write_capacity  = local.write_capacity
    key_schema {
      attribute_name = "GSI2PK"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "GSI2SK"
      key_type       = "RANGE"
    }
  }

  tags = var.tags
}

# ---------------------------------------------------------------------------
# IAM execution role for the AgentCore Runtime
# ---------------------------------------------------------------------------

resource "aws_iam_role" "agentcore" {
  name = "${var.project_name}-agentcore-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.${local.dns_suffix}" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "agentcore" {
  name = "agentcore-policy"
  role = aws_iam_role.agentcore.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Pull the container image.
        Effect   = "Allow"
        Action   = ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability"]
        Resource = aws_ecr_repository.agentcore.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"]
        Resource = "arn:${local.partition}:logs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/*"
      },
      {
        # Business graph (Neptune) read + write.
        Effect   = "Allow"
        Action   = ["neptune-db:ReadDataViaQuery", "neptune-db:WriteDataViaQuery", "neptune-db:DeleteDataViaQuery", "neptune-db:connect"]
        Resource = "arn:${local.partition}:neptune-db:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:${var.neptune_cluster_resource_id}/*"
      },
      {
        # v2 process state table (+ its indexes) and the blocks table (read).
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = compact([
          aws_dynamodb_table.v2_executions.arn,
          "${aws_dynamodb_table.v2_executions.arn}/index/*",
          var.blocks_table_arn,
          var.blocks_table_arn != "" ? "${var.blocks_table_arn}/index/*" : "",
          var.connections_table_arn,
          var.connections_table_arn != "" ? "${var.connections_table_arn}/index/*" : "",
        ])
      },
      {
        # Block bodies + the commit-pinned runtime snapshot (read).
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [var.artifacts_bucket_arn, "${var.artifacts_bucket_arn}/*"]
      },
      {
        # Push live output/questions to the realtime websocket.
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = var.websocket_execution_arn != "" ? "${var.websocket_execution_arn}/*" : "arn:${local.partition}:execute-api:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:*"
      },
      {
        # Read agent model + bearer/api-key settings at startup (no Bedrock IAM —
        # Claude/Kiro authenticate via the bearer token / API key, as in v1).
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = var.agent_settings_ssm_arns
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "agentcore" {
  name              = "/aws/bedrock-agentcore/${var.project_name}-${var.environment}"
  retention_in_days = var.environment == "prod" ? 30 : 7
  tags              = var.tags
}

# ---------------------------------------------------------------------------
# The AgentCore Runtime (awscc → AWS::BedrockAgentCore::Runtime)
# ---------------------------------------------------------------------------

resource "awscc_bedrockagentcore_runtime" "stage_executor" {
  agent_runtime_name = replace("${var.project_name}_agentcore_${var.environment}", "-", "_")
  role_arn           = aws_iam_role.agentcore.arn
  # The container speaks the HTTP contract (POST /invocations + GET /ping on 8080).
  protocol_configuration = "HTTP"

  agent_runtime_artifact = {
    container_configuration = {
      container_uri = module.agentcore_docker_build.image_uri
    }
  }

  # VPC networking so the runtime reaches Neptune (private) + AWS APIs.
  network_configuration = {
    network_mode = "PUBLIC"
  }

  environment_variables = {
    V2_PROCESS_TABLE              = aws_dynamodb_table.v2_executions.name
    BLOCKS_TABLE                  = var.blocks_table_name
    ARTIFACTS_BUCKET              = var.artifacts_bucket_name
    NEPTUNE_ENDPOINT              = var.neptune_endpoint
    CONNECTIONS_TABLE             = var.connections_table_name
    WEBSOCKET_ENDPOINT            = var.websocket_endpoint
    AIDLC_REPO_REF                = var.aidlc_repo_ref
    BEDROCK_MODEL                 = var.bedrock_model
    AWS_REGION                    = var.aws_region
    BEDROCK_BEARER_TOKEN_SSM_PATH = var.bedrock_bearer_token_ssm_name
    KIRO_API_KEY_SSM_PATH         = var.kiro_api_key_ssm_name
  }

  tags = var.tags
}
