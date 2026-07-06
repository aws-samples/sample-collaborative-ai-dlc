data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_ecr_authorization_token" "token" {}

# AZ names are randomized per account; AZ IDs (use1-az1, …) are stable. We map the
# region's AgentCore-supported AZ IDs to the names that exist in THIS account so the
# runtime only ever lands in AZs where AgentCore VPC mode is available.
data "aws_availability_zones" "available" {
  state = "available"
}

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

  # Both include roots and exclude patterns are ROOTED at agentcore/ + shared/.
  # Rooting the excludes keeps `fileset` from walking sibling lambda packages
  # (e.g. agents/node_modules), whose .bin/* symlinks trigger fileset's
  # "inconsistent result" bug when a `**` glob traverses a symlink. The include
  # set is already scoped to these two roots, so the resulting file set (and thus
  # the image hash) is unchanged.
  path_include = ["agentcore/**", "shared/**"]
  path_exclude = flatten([
    for root in ["agentcore", "shared"] : [
      "${root}/**/node_modules/**",
      "${root}/**/.git/**",
      "${root}/**/test/**",
      "${root}/**/.build/**",
    ]
  ])

  agentcore_files_include = setunion([for f in local.path_include : fileset(local.agentcore_source_path, f)]...)
  agentcore_files_exclude = setunion([for f in local.path_exclude : fileset(local.agentcore_source_path, f)]...)
  agentcore_files         = sort(setsubtract(local.agentcore_files_include, local.agentcore_files_exclude))
  agentcore_files_sha     = sha1(join("", [for f in local.agentcore_files : filesha1("${local.agentcore_source_path}/${f}")]))
  agentcore_image_tag     = substr(local.agentcore_files_sha, 0, 16)

  billing_mode   = var.environment == "prod" ? "PROVISIONED" : "PAY_PER_REQUEST"
  read_capacity  = var.environment == "prod" ? 5 : null
  write_capacity = var.environment == "prod" ? 5 : null

  # ── AgentCore VPC networking (region-agnostic AZ selection) ──────────────────
  # AgentCore Runtime VPC mode only accepts subnets in specific AZs per region,
  # published as stable AZ IDs (not the per-account-randomized names). Subnets in
  # unsupported AZs fail at resource creation. Map ID → name for this account,
  # intersect with the region's supported set, and place dedicated AgentCore
  # subnets only in those AZs. Override per-region via var.agentcore_supported_az_ids.
  vpc_enabled = var.network_mode == "VPC"

  az_id_to_name = zipmap(
    data.aws_availability_zones.available.zone_ids,
    data.aws_availability_zones.available.names,
  )

  # Verified supported AZ IDs for every AgentCore-Runtime region, transcribed from
  # the AWS devguide "Supported Availability Zones" table (verified 2026-06-26):
  # https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html
  # IDs are NON-CONTIGUOUS (e.g. us-east-1 has az1/az2/az4 — no az3/az5/az6); do not
  # "fill in" gaps. Update from that table as AWS expands coverage, or override per
  # region via var.agentcore_supported_az_ids.
  default_agentcore_az_ids = {
    "us-east-1"      = ["use1-az1", "use1-az2", "use1-az4"]
    "us-east-2"      = ["use2-az1", "use2-az2", "use2-az3"]
    "us-west-2"      = ["usw2-az1", "usw2-az2", "usw2-az3"]
    "ap-southeast-2" = ["apse2-az1", "apse2-az2", "apse2-az3"]
    "ap-south-1"     = ["aps1-az1", "aps1-az2", "aps1-az3"]
    "ap-southeast-1" = ["apse1-az1", "apse1-az2", "apse1-az3"]
    "ap-northeast-1" = ["apne1-az1", "apne1-az2", "apne1-az4"]
    "eu-west-1"      = ["euw1-az1", "euw1-az2", "euw1-az3"]
    "eu-central-1"   = ["euc1-az1", "euc1-az2", "euc1-az3"]
    "eu-north-1"     = ["eun1-az1", "eun1-az2", "eun1-az3"]
    "eu-west-3"      = ["euw3-az1", "euw3-az2", "euw3-az3"]
    "ap-northeast-2" = ["apne2-az1", "apne2-az2", "apne2-az3"]
    "eu-west-2"      = ["euw2-az1", "euw2-az2", "euw2-az3"]
    "ca-central-1"   = ["cac1-az1", "cac1-az2", "cac1-az4"]
    "sa-east-1"      = ["sae1-az1", "sae1-az2", "sae1-az3"]
    "us-gov-west-1"  = ["usgw1-az1", "usgw1-az2", "usgw1-az3"]
  }

  # Explicit override wins; else region default; else every available AZ (lets a
  # new region work, trusting the apply to surface any unsupported-AZ error).
  region_supported_az_ids = length(var.agentcore_supported_az_ids) > 0 ? var.agentcore_supported_az_ids : lookup(local.default_agentcore_az_ids, var.aws_region, data.aws_availability_zones.available.zone_ids)

  # Supported AZ IDs that actually exist in this account, resolved to AZ names.
  agentcore_az_ids   = [for id in local.region_supported_az_ids : id if contains(keys(local.az_id_to_name), id)]
  agentcore_az_names = [for id in local.agentcore_az_ids : local.az_id_to_name[id]]

  # Use up to 2 AZs for the runtime ENIs. Carve dedicated /24s high in the VPC
  # range (offset 200) so they never collide with networking's public (0..) or
  # private (10..) subnets.
  agentcore_subnet_azs = slice(local.agentcore_az_names, 0, min(2, length(local.agentcore_az_names)))
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
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = [
          aws_ssm_parameter.bedrock_bearer_token.arn,
          aws_ssm_parameter.kiro_api_key.arn,
          aws_ssm_parameter.cli_models.arn,
        ]
      },
      {
        # Async stage invocation (docs/v2-parallel.md WP1): the run-stage-start
        # background job completes/heartbeats the durable callback the
        # orchestrator suspended on. ARN constructed from naming convention
        # (module dependency direction forbids passing the function ARN in:
        # api → agentcore would become a cycle). Mirrors the intents policy.
        Effect = "Allow"
        Action = [
          "lambda:SendDurableExecutionCallbackSuccess",
          "lambda:SendDurableExecutionCallbackFailure",
          "lambda:SendDurableExecutionCallbackHeartbeat",
        ]
        Resource = [
          "arn:${local.partition}:lambda:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-v2-orchestrator-${var.environment}",
          "arn:${local.partition}:lambda:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-v2-orchestrator-${var.environment}:*",
        ]
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
# Agent Settings — SSM Parameters (managed via Admin UI at runtime)
#   Read by this runtime at startup (auth-resolver / model-resolver) and by the
#   agents + intents lambdas (Admin settings API, model defaults/pricing).
#   Formerly defined in modules/compute/agents (the retired v1 ECS pool) —
#   root-level `moved` blocks preserve the stored values across the migration.
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

# Default agent models by CLI — JSON object managed by the Admin UI at runtime.
resource "aws_ssm_parameter" "cli_models" {
  name        = "/${var.project_name}/${var.environment}/cli-models"
  description = "Default agent model IDs by CLI (JSON object)"
  type        = "String"
  value = jsonencode(merge(
    var.kiro_model != "" ? { kiro = var.kiro_model } : {},
    var.bedrock_model != "" ? {
      opencode = can(regex("^amazon-bedrock/", var.bedrock_model)) ? var.bedrock_model : "amazon-bedrock/${var.bedrock_model}"
    } : {}
  ))

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

# ---------------------------------------------------------------------------
# VPC networking for the runtime (only when network_mode = "VPC")
#   Dedicated private subnets in AgentCore-supported AZs, NAT-routed for egress
#   (AWS API calls + agent CLI HTTPS), reaching Neptune over the VPC.
# ---------------------------------------------------------------------------

resource "aws_subnet" "agentcore" {
  count = local.vpc_enabled ? length(local.agentcore_subnet_azs) : 0

  vpc_id            = var.vpc_id
  availability_zone = local.agentcore_subnet_azs[count.index]
  # /24s high in the VPC range (offset 200), clear of networking's 0.. and 10.. subnets.
  cidr_block = cidrsubnet(var.vpc_cidr, 8, count.index + 200)

  tags = merge(var.tags, {
    Name = "${var.project_name}-agentcore-${var.environment}-${count.index + 1}"
  })
}

resource "aws_route_table_association" "agentcore" {
  count = local.vpc_enabled ? length(aws_subnet.agentcore) : 0

  subnet_id = aws_subnet.agentcore[count.index].id
  # Reuse the networking module's NAT-routed private route table(s) for egress.
  route_table_id = element(var.private_route_table_ids, count.index)
}

resource "aws_security_group" "agentcore" {
  count = local.vpc_enabled ? 1 : 0

  name_prefix = "${var.project_name}-agentcore-${var.environment}"
  description = "AgentCore Runtime ENIs; egress only (Neptune over VPC + AWS APIs + CLI HTTPS)"
  vpc_id      = var.vpc_id

  egress {
    description = "All egress (Neptune 8182 in-VPC, AWS API + agent CLI HTTPS via NAT)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
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

  # VPC mode so the runtime's ENIs reach Neptune (private) over the VPC; PUBLIC
  # otherwise. network_mode_config is required iff network_mode = "VPC".
  network_configuration = {
    network_mode = var.network_mode
    network_mode_config = local.vpc_enabled ? {
      subnets         = aws_subnet.agentcore[*].id
      security_groups = aws_security_group.agentcore[*].id
    } : null
  }

  # Managed session storage — a per-session persistent mount that survives
  # stop/resume for the same runtimeSessionId (no VPC required). This is what lets
  # a parked question resume hours-to-days later: the git checkout from init-ws AND
  # the headless CLI's conversation store both live under /mnt/workspace, so a
  # microVM reap mid-wait (or a deliberate StopRuntimeSession) loses no state.
  # Two failure modes the resume path must handle (see docs/v2-resume.md, D2):
  #   - WIPED on every runtime version update (image redeploy) — a parked session's
  #     compute is already terminated, so it gets a fresh empty FS on next invoke.
  #   - EXPIRES after 14 days idle.
  filesystem_configurations = [{ session_storage = { mount_path = "/mnt/workspace" } }]

  # idle 900s: with park/resume a parked question lets the session idle and free
  # compute after 15 min (the resume lambda may also StopRuntimeSession sooner).
  # max_lifetime 28800s (8h, the cap): long ACTIVE stages get headroom; a reap
  # mid-park is now recoverable from the persistent mount. idle must be <= max.
  lifecycle_configuration = { idle_runtime_session_timeout = 900, max_lifetime = 28800 }

  environment_variables = {
    V2_WORKSPACE_DIR              = "/mnt/workspace"
    V2_PROCESS_TABLE              = aws_dynamodb_table.v2_executions.name
    BLOCKS_TABLE                  = var.blocks_table_name
    ARTIFACTS_BUCKET              = var.artifacts_bucket_name
    NEPTUNE_ENDPOINT              = var.neptune_endpoint
    CONNECTIONS_TABLE             = var.connections_table_name
    WEBSOCKET_ENDPOINT            = var.websocket_endpoint
    AIDLC_REPO_REF                = var.aidlc_repo_ref
    BEDROCK_MODEL                 = var.bedrock_model
    AWS_REGION                    = var.aws_region
    BEDROCK_BEARER_TOKEN_SSM_PATH = aws_ssm_parameter.bedrock_bearer_token.name
    KIRO_API_KEY_SSM_PATH         = aws_ssm_parameter.kiro_api_key.name
  }

  tags = var.tags
}
