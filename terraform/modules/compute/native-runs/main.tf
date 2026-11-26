terraform {
  required_version = ">= 1.7"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name        = "${var.project_name}-native-runs-${var.environment}"
  account_id  = data.aws_caller_identity.current.account_id
  region      = data.aws_region.current.region
  partition   = data.aws_partition.current.partition
  role_arn    = "arn:${local.partition}:iam::${local.account_id}:role/native-runs/native_*"
  runtime_arn = "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:runtime/native_*"
  ap_arn      = "arn:${local.partition}:elasticfilesystem:${local.region}:${local.account_id}:access-point/*"
  logs_arn    = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/native_*"
  source_path = abspath("${path.module}/../../../../lambda/native-runtime-control")
  shared_path = abspath("${path.module}/../../../../lambda/shared")
  source_hash = sha256(join("", [
    for f in sort(fileset(local.shared_path, "**/*.{js,mjs,cjs,json}")) :
    filesha256("${local.shared_path}/${f}")
  ]))
  lambda_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.${data.aws_partition.current.dns_suffix}" }
    }]
  })
  base_environment = {
    NATIVE_PREPARATION_ENABLED        = "true"
    NATIVE_PREPARATION_PROJECT_IDS    = jsonencode(var.project_ids)
    NATIVE_RUNTIME_BINDINGS_TABLE     = aws_dynamodb_table.bindings.name
    NATIVE_RUNTIME_ACCOUNT_ID         = local.account_id
    AWS_PARTITION                     = local.partition
    NATIVE_RUNTIME_FILE_SYSTEM_ID     = aws_efs_file_system.runs.id
    NATIVE_RUNTIME_IMAGE_URI          = "${var.image_repository_url}@${var.image_digest}"
    NATIVE_RUNTIME_IMAGE_DIGEST       = var.image_digest
    NATIVE_RUNTIME_SUBNET_IDS         = jsonencode(var.runtime_subnet_ids)
    NATIVE_RUNTIME_SECURITY_GROUP_IDS = jsonencode([aws_security_group.runtimes.id])
    NATIVE_RUNTIME_ROLE_BOUNDARY_ARN  = aws_iam_policy.runtime_boundary.arn
    NATIVE_RUNTIME_ECR_REPOSITORY_ARN = var.image_repository_arn
    NATIVE_RUNTIME_QUEUE_URL          = aws_sqs_queue.provisioning.url
    POWERTOOLS_SERVICE_NAME           = "native-runtime-control"
    POWERTOOLS_LOG_LEVEL              = "INFO"
  }
}

resource "terraform_data" "configuration" {
  lifecycle {
    precondition {
      condition     = var.environment == "dev" && length(var.project_ids) > 0 && length(var.runtime_subnet_ids) > 0
      error_message = "Native preparation is a dev pilot and requires explicit project IDs and VPC subnets."
    }
  }
}

# Control-plane authority. No runtime role receives access to this table.
# Unfinished runs must not expire when optional debug archives expire.
resource "aws_dynamodb_table" "bindings" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "projectId"
    type = "S"
  }
  attribute {
    name = "createdAt"
    type = "N"
  }
  # Discovery hints only. The API validates every result with a consistent
  # primary read before returning a public summary.
  global_secondary_index {
    name               = "NativeByProjectCreatedAt"
    hash_key           = "projectId"
    range_key          = "createdAt"
    projection_type    = "INCLUDE"
    non_key_attributes = ["executionId"]
  }
  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  tags = var.tags
}

resource "aws_efs_file_system" "runs" {
  creation_token   = local.name
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"
  tags             = merge(var.tags, { Name = local.name, NativeRunStorage = "true" })
}

resource "aws_security_group" "runtimes" {
  name_prefix = "${local.name}-"
  description = "Native runtimes; HTTPS and their EFS mount only"
  vpc_id      = var.vpc_id
  # Manage every runtime rule separately so refresh cannot revoke the NFS rule.
  tags = var.tags
}

resource "aws_vpc_security_group_egress_rule" "runtime_https" {
  security_group_id = aws_security_group.runtimes.id
  description       = "AWS services and HTTPS"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
  tags              = var.tags
}

resource "aws_security_group" "filesystem" {
  name_prefix = "${local.name}-efs-"
  description = "NFS only from isolated native runtimes"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.runtimes.id]
  }
  tags = var.tags
}

resource "aws_vpc_security_group_egress_rule" "runtime_nfs" {
  security_group_id            = aws_security_group.runtimes.id
  referenced_security_group_id = aws_security_group.filesystem.id
  from_port                    = 2049
  to_port                      = 2049
  ip_protocol                  = "tcp"
}

resource "aws_efs_mount_target" "runs" {
  count           = length(var.runtime_subnet_ids)
  file_system_id  = aws_efs_file_system.runs.id
  subnet_id       = var.runtime_subnet_ids[count.index]
  security_groups = [aws_security_group.filesystem.id]
}

# An Allow in an EFS resource policy could bypass a narrower identity policy.
# This policy grants nobody access: each run's role grants only its exact AP.
resource "aws_efs_file_system_policy" "runs" {
  file_system_id = aws_efs_file_system.runs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([{
      Sid       = "DenyRoot"
      Effect    = "Deny"
      Principal = "*"
      Action    = "elasticfilesystem:ClientRootAccess"
      Resource  = aws_efs_file_system.runs.arn
      }], [
      for sid, condition in {
        DenyWithoutAccessPoint = { Null = { "elasticfilesystem:AccessPointArn" = "true" } }
        DenyInsecureTransport  = { BoolIfExists = { "aws:SecureTransport" = "false" } }
        DenyWithoutMountTarget = { BoolIfExists = { "elasticfilesystem:AccessedViaMountTarget" = "false" } }
        } : {
        Sid       = sid
        Effect    = "Deny"
        Principal = "*"
        Action    = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
        Resource  = aws_efs_file_system.runs.arn
        Condition = condition
      }
    ])
  })
}

# Maximum permissions for roles minted by the provisioner. The inline role
# policy narrows these further to its AP, log group and (when enabled) pinned
# package/publication bytes. Authority, signing, graph and brokers stay absent.
resource "aws_iam_policy" "runtime_boundary" {
  name = "${local.name}-boundary"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability"]
        Resource = var.image_repository_arn
      },
      {
        Effect   = "Allow"
        Action   = ["elasticfilesystem:DescribeAccessPoints", "elasticfilesystem:DescribeMountTargets"]
        Resource = [aws_efs_file_system.runs.arn, local.ap_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
        Resource = aws_efs_file_system.runs.arn
        Condition = {
          Null = { "elasticfilesystem:AccessPointArn" = "false" }
          Bool = {
            "aws:SecureTransport"                      = "true"
            "elasticfilesystem:AccessedViaMountTarget" = "true"
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
        Resource = local.logs_arn
      }
    ], var.execution_enabled ? local.execution_runtime_boundary_statements : [])
  })
  tags = var.tags
}

resource "aws_sqs_queue" "dead_letter" {
  name                      = "${local.name}-provisioning-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = var.tags
}

resource "aws_sqs_queue" "provisioning" {
  name = "${local.name}-provisioning"
  # Preserve six times the worker timeout for uncertain failures. Confirmed
  # readiness waits still use the worker's short visibility backoff.
  visibility_timeout_seconds = 540
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = 100
  })
  tags = var.tags
}

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = local.lambda_trust
  tags               = var.tags
}
resource "aws_iam_role" "worker" {
  name               = "${local.name}-provisioner"
  assume_role_policy = local.lambda_trust
  tags               = var.tags
}
resource "aws_iam_role_policy_attachment" "api_basic" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
resource "aws_iam_role_policy_attachment" "worker_basic" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "api" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Effect   = "Allow"
        Action   = ["neptune-db:ReadDataViaQuery", "neptune-db:connect"]
        Resource = "arn:${local.partition}:neptune-db:${local.region}:${local.account_id}:${var.neptune_cluster_resource_id}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.bindings.arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = "${aws_dynamodb_table.bindings.arn}/index/NativeByProjectCreatedAt"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = [var.workflow_source_bindings_table_arn, var.package_jobs_table_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.provisioning.arn
      }
    ], [for statement in local.execution_api_statements : statement if var.execution_enabled])
  })
}

resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.bindings.arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
        Resource = aws_sqs_queue.provisioning.arn
      },
      {
        Effect    = "Allow"
        Action    = ["iam:CreateRole"]
        Resource  = local.role_arn
        Condition = { ArnEquals = { "iam:PermissionsBoundary" = aws_iam_policy.runtime_boundary.arn } }
      },
      {
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:GetRolePolicy", "iam:PutRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:TagRole"]
        Resource = local.role_arn
      },
      {
        # GetRole accepts a name, not a path. Authorize the initial lookup
        # before the role exists under /native-runs/. Mutation and PassRole
        # permissions remain restricted to that path and the role boundary.
        Effect   = "Allow"
        Action   = ["iam:GetRole"]
        Resource = "arn:${local.partition}:iam::${local.account_id}:role/native_*"
      },
      {
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = local.role_arn
        Condition = { StringEquals = { "iam:PassedToService" = "bedrock-agentcore.${data.aws_partition.current.dns_suffix}" } }
      },
      {
        Effect   = "Allow"
        Action   = ["elasticfilesystem:CreateAccessPoint", "elasticfilesystem:DescribeAccessPoints", "elasticfilesystem:DescribeMountTargets", "elasticfilesystem:DescribeFileSystems", "elasticfilesystem:DescribeFileSystemPolicy"]
        Resource = [aws_efs_file_system.runs.arn, local.ap_arn]
      },
      {
        # Include the parent filesystem in EFS tag-on-create authorization.
        # Permit tagging only as part of our AP creation,
        # with the two scope tags that the provisioner verifies on readback.
        Effect   = "Allow"
        Action   = ["elasticfilesystem:TagResource"]
        Resource = [aws_efs_file_system.runs.arn, local.ap_arn]
        Condition = {
          StringEquals = { "elasticfilesystem:CreateAction" = "CreateAccessPoint" }
          "ForAllValues:StringEquals" = {
            "aws:TagKeys" = ["NativeBinding", "NativeScope"]
          }
          Null = {
            "aws:RequestTag/NativeBinding" = "false"
            "aws:RequestTag/NativeScope"   = "false"
          }
        }
      },
      {
        # AWS does not support resource-level ARNs for runtime creation. Limit
        # its supported request context; PassRole still fixes the role path and
        # every minted role must carry the native permissions boundary.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:CreateAgentRuntime"]
        Resource = "*"
        Condition = {
          "ForAllValues:StringEquals" = {
            "bedrock-agentcore:subnets"        = var.runtime_subnet_ids
            "bedrock-agentcore:securityGroups" = [aws_security_group.runtimes.id]
            "aws:TagKeys"                      = ["NativeBinding", "NativeScope"]
          }
          Null = {
            "bedrock-agentcore:subnets"        = "false"
            "bedrock-agentcore:securityGroups" = "false"
            "aws:RequestTag/NativeBinding"     = "false"
            "aws:RequestTag/NativeScope"       = "false"
          }
        }
      },
      {
        # CreateAgentRuntime authorizes its DEFAULT endpoint and initial tags
        # against the literal pre-allocation ARN "runtime/*". IAM's ${*}
        # variable matches that literal asterisk without granting these actions
        # on existing non-native runtimes. Escape Terraform interpolation.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:TagResource"]
        Resource = "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:runtime/$${*}"
      },
      {
        # Runtime creation also tags its automatically created workload
        # identity before allocating an ID. Match that literal placeholder;
        # named native identities have a separate tag-constrained grant below.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:TagResource"]
        Resource = "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default/workload-identity/$${*}"
      },
      {
        # Runtime identity creation also checks tagging on the default directory.
        # Its tag grant is shared controller authority, not a per-run boundary.
        # Identity reads, updates, deletion and token access stay denied.
        Effect = "Allow"
        Action = ["bedrock-agentcore:CreateWorkloadIdentity", "bedrock-agentcore:TagResource"]
        Resource = [
          "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default",
          "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default/workload-identity/$${*}"
        ]
        Condition = {
          "ForAllValues:StringEquals" = {
            "aws:TagKeys" = ["NativeBinding", "NativeScope"]
          }
          Null = {
            "aws:TagKeys"                  = "false"
            "aws:RequestTag/NativeBinding" = "false"
            "aws:RequestTag/NativeScope"   = "false"
          }
        }
      },
      {
        # Identity creation also checks the allocated native name. Cover the
        # documented create-and-tag operation under the same request-tag guards.
        # This controller can directly create or retag native identities;
        # the runtime execution roles do not inherit these permissions.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:CreateWorkloadIdentity", "bedrock-agentcore:TagResource"]
        Resource = "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default/workload-identity/native_*"
        Condition = {
          "ForAllValues:StringEquals" = {
            "aws:TagKeys" = ["NativeBinding", "NativeScope"]
          }
          Null = {
            "aws:TagKeys"                  = "false"
            "aws:RequestTag/NativeBinding" = "false"
            "aws:RequestTag/NativeScope"   = "false"
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:GetAgentRuntime", "bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:GetAgentRuntimeEndpoint", "bedrock-agentcore:TagResource", "bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"]
        Resource = [local.runtime_arn, "${local.runtime_arn}/runtime-endpoint/*"]
      }
    ]
  })
}

module "api" {
  source                 = "terraform-aws-modules/lambda/aws"
  version                = "~> 8.0"
  function_name          = "${local.name}-api"
  handler                = "index.handler"
  runtime                = "nodejs24.x"
  architectures          = ["arm64"]
  memory_size            = 512
  timeout                = 30
  create_role            = false
  lambda_role            = aws_iam_role.api.arn
  vpc_subnet_ids         = var.api_subnet_ids
  vpc_security_group_ids = var.api_security_group_ids
  source_path = [{
    path     = local.source_path
    patterns = ["!.build/.*"]
    commands = [
      "cd ../.. && npm run build:api -w native-runtime-control",
      ":zip lambda/native-runtime-control/.build/api"
    ]
  }]
  hash_extra = sha256("${local.source_hash}:${filesha256("${path.module}/../../../../package-lock.json")}")
  environment_variables = merge(local.base_environment, local.execution_environment, {
    NEPTUNE_ENDPOINT                   = var.neptune_endpoint
    WORKFLOW_SOURCE_BINDINGS_TABLE     = var.workflow_source_bindings_table_name
    NATIVE_PACKAGE_JOBS_TABLE          = var.package_jobs_table_name
    NATIVE_EXECUTION_QUEUE_URL         = try(aws_sqs_queue.execution[0].url, "")
    SOURCE_CONTROL_BINDINGS_TABLE      = var.source_control_bindings_table_name
    AGENT_SETTINGS_SSM_PREFIX          = local.agent_settings_prefix
    AGENT_CREDENTIAL_METADATA_FUNCTION = var.agent_credential_metadata_function_arn
  })
  cloudwatch_logs_retention_in_days = 7
  depends_on                        = [terraform_data.configuration, aws_iam_role_policy.api, aws_iam_role_policy_attachment.api_basic]
}

module "worker" {
  source        = "terraform-aws-modules/lambda/aws"
  version       = "~> 8.0"
  function_name = "${local.name}-provisioner"
  handler       = "worker.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 90
  create_role   = false
  lambda_role   = aws_iam_role.worker.arn
  source_path = [{
    path     = local.source_path
    patterns = ["!.build/.*"]
    commands = [
      "cd ../.. && npm run build:worker -w native-runtime-control",
      ":zip lambda/native-runtime-control/.build/worker"
    ]
  }]
  hash_extra                        = sha256("${local.source_hash}:${filesha256("${path.module}/../../../../package-lock.json")}")
  environment_variables             = local.base_environment
  cloudwatch_logs_retention_in_days = 7
  depends_on = [
    terraform_data.configuration, aws_iam_role_policy.worker, aws_iam_role_policy_attachment.worker_basic,
    aws_efs_file_system_policy.runs, aws_efs_mount_target.runs, aws_vpc_security_group_egress_rule.runtime_nfs
  ]
}

resource "aws_lambda_event_source_mapping" "provisioning" {
  event_source_arn        = aws_sqs_queue.provisioning.arn
  function_name           = module.worker.lambda_function_arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}

output "api_invoke_arn" { value = module.api.lambda_function_invoke_arn }
output "api_function_name" { value = module.api.lambda_function_name }
output "bindings_table_name" { value = aws_dynamodb_table.bindings.name }
output "file_system_id" { value = aws_efs_file_system.runs.id }
output "provisioning_queue_url" { value = aws_sqs_queue.provisioning.url }
output "provisioning_dlq_url" { value = aws_sqs_queue.dead_letter.url }
