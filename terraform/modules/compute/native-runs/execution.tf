locals {
  agent_settings_prefix = "/${var.project_name}/${var.environment}"
  ssm_prefix_arn        = "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${local.agent_settings_prefix}"
  graph_arn             = "arn:${local.partition}:neptune-db:${local.region}:${local.account_id}:${var.neptune_cluster_resource_id}/*"
  execution_environment = {
    NATIVE_EXECUTION_ENABLED            = "true"
    NATIVE_EXECUTION_ADMISSION_ENABLED  = tostring(var.execution_enabled)
    NATIVE_EXECUTION_IMAGE_URI          = "${var.image_repository_url}@${var.image_digest}"
    NATIVE_EXECUTION_IMAGE_DIGEST       = var.image_digest
    NATIVE_EXECUTION_PUBLICATION_BUCKET = aws_s3_bucket.publications.id
    NATIVE_PACKAGES_BUCKET              = var.native_packages_bucket_name
  }
  execution_api_statements = [
    {
      Sid      = "BuildNativeResult"
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = module.results.lambda_function_arn
    },
    {
      Sid      = "DownloadGeneratedNativeResult"
      Effect   = "Allow"
      Action   = ["s3:GetObjectVersion"]
      Resource = "${aws_s3_bucket.publications.arn}/native-results/v1/*"
    },
    { Sid = "ReadNativeOutputHistory", Effect = "Allow", Action = ["dynamodb:Query"], Resource = aws_dynamodb_table.bindings.arn },
    {
      # TransactWriteItems authorizes its constituent operations individually.
      # Read permissions shared by the authority's execution command operations.
      Sid      = "ReadNativeExecutionPins"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem"]
      Resource = aws_dynamodb_table.bindings.arn
    },
    {
      Sid      = "ReadNativeCodeBinding"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem"]
      Resource = var.source_control_bindings_table_arn
    },
    {
      Sid      = "ReadNativeModelSelection"
      Effect   = "Allow"
      Action   = ["ssm:GetParameter"]
      Resource = ["${local.ssm_prefix_arn}/cli-models", "${local.ssm_prefix_arn}/tier-models"]
    },
    {
      Sid      = "ResolveNativeCredentialMetadata"
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = var.agent_credential_metadata_function_arn
    },
    {
      Sid      = "ReadCommittedNativePublication"
      Effect   = "Allow"
      Action   = ["s3:GetObjectVersion"]
      Resource = "${aws_s3_bucket.publications.arn}/native-executions/*"
    },
    {
      Sid      = "EnqueueNativeExecution"
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = try(aws_sqs_queue.execution[0].arn, "")
    },
  ]
  # This is a maximum boundary, never a runtime grant. The controller's inline
  # nativeExecutionPolicy narrows bytes and the read-only cancellation fence to
  # exact attempt pins. Runtime writes cannot match the separate control prefix.
  execution_runtime_boundary_statements = [
    {
      Sid      = "ReadPinnedNativePackageVersions"
      Effect   = "Allow"
      Action   = ["s3:GetObjectVersion"]
      Resource = "${var.native_packages_bucket_arn}/native-packages/v1/*"
    },
    {
      Sid      = "PublishNativeAttemptVersions"
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObjectVersion"]
      Resource = "${aws_s3_bucket.publications.arn}/native-executions/*"
    },
    {
      Sid      = "ReadNativeCancellationFence"
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "${aws_s3_bucket.publications.arn}/native-execution-control/v1/*"
    },
    {
      # Mandatory resume state, separate from public artifacts and optional
      # debug archives. Per-runtime inline policy narrows to its exact attempt.
      Sid      = "PreserveNativeRecoveryCheckpoints"
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"]
      Resource = "${aws_s3_bucket.publications.arn}/native-recovery/v1/*"
    },
  ]
}

# Keep durable publications when execution is toggled off. This storage belongs
# to the existing native-runs module lifetime, not to optional debugging or the
# worker's enablement count. No object/noncurrent-version expiry is configured.
resource "aws_s3_bucket" "publications" {
  bucket        = "${local.name}-pub-${substr(sha256("${local.account_id}:${local.region}"), 0, 8)}"
  force_destroy = false
  tags          = merge(var.tags, { NativePublicationStorage = "true" })
}
resource "aws_s3_bucket_versioning" "publications" {
  bucket = aws_s3_bucket.publications.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "publications" {
  bucket = aws_s3_bucket.publications.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_ownership_controls" "publications" {
  bucket = aws_s3_bucket.publications.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_public_access_block" "publications" {
  bucket                  = aws_s3_bucket.publications.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_policy" "publications" {
  bucket = aws_s3_bucket.publications.id
  # Deny only: a resource-policy Allow could bypass a narrower per-run grant.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.publications.arn, "${aws_s3_bucket.publications.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_sqs_queue" "execution" {
  count                      = 1
  name                       = "${local.name}-execution"
  visibility_timeout_seconds = 720
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true
  # No receive-count cutoff. Successful reconciliation re-enqueues a fresh
  # pointer with DelaySeconds=5 and acknowledges this message; failures retry.
  tags = var.tags
}

resource "aws_iam_role" "execution_worker" {
  count              = 1
  name               = "${local.name}-execution"
  assume_role_policy = local.lambda_trust
  tags               = var.tags
}
resource "aws_iam_role_policy_attachment" "execution_worker_basic" {
  count      = 1
  role       = aws_iam_role.execution_worker[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
resource "aws_iam_role_policy" "execution_worker" {
  count = 1
  name  = "native-execution-control"
  role  = aws_iam_role.execution_worker[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "SubmitFencedObservations", Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = "${local.base_environment.NATIVE_AUTHORITY_FUNCTION}:execution" },
      {
        Sid      = "NativeExecutionAuthority"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.bindings.arn
      },
      {
        Sid      = "ReadPinnedSourceMetadata"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = [var.workflow_source_bindings_table_arn, var.package_jobs_table_arn, var.source_control_bindings_table_arn]
      },
      {
        # Execution checks membership. Only the independent projector writes graph data.
        Sid      = "AuthorizeNativeExecution"
        Effect   = "Allow"
        Action   = ["neptune-db:connect", "neptune-db:ReadDataViaQuery"]
        Resource = local.graph_arn
      },
      {
        Sid      = "ReconcileNativeExecutionQueue"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility", "sqs:SendMessage"]
        Resource = aws_sqs_queue.execution[0].arn
      },
      {
        Sid      = "ResolveOwnedNativeCredentials"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = module.execution_credentials[0].lambda_function_arn
      },
      {
        Sid      = "ReadCommittedNativePublication"
        Effect   = "Allow"
        Action   = ["s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.publications.arn}/native-executions/*"
      },
      {
        # The controller verifies every pinned object version before committing
        # a checkpoint receipt. It does not upload or alter private CLI bytes.
        Sid      = "VerifyNativeRecoveryCheckpoints"
        Effect   = "Allow"
        Action   = ["s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.publications.arn}/native-recovery/v1/*"
      },
      {
        # S3 returns AccessDenied for a missing GetObject key unless the caller
        # can list the bucket. The controller's conditional fence initialization
        # needs to distinguish an absent record from an authorization failure.
        # This bucket-metadata permission belongs only to the trusted controller;
        # it is not added to runtime boundaries or the member-facing API.
        Sid      = "DistinguishMissingNativeControlRecords"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.publications.arn
      },
      {
        # Only the controller writes ACTIVE/CANCELLED. Runtime roles read the
        # latest state from an exact attempt key; publication write grants do
        # not cover this prefix. State transitions are enforced by the worker.
        Sid      = "MaintainNativeCancellationFence"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.publications.arn}/native-execution-control/v1/*"
      },
      {
        Sid      = "UpgradeAndReconcileNativeRuntime"
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:UpdateAgentRuntime", "bedrock-agentcore:GetAgentRuntime", "bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:GetAgentRuntimeEndpoint", "bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"]
        Resource = [local.runtime_arn, "${local.runtime_arn}/runtime-endpoint/exec_*"]
      },
      {
        # UpdateAgentRuntime supplies the same previously verified execution
        # role; allow passing only native roles to this service.
        Sid       = "PassExistingNativeRuntimeRole"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = local.role_arn
        Condition = { StringEquals = { "iam:PassedToService" = "bedrock-agentcore.${data.aws_partition.current.dns_suffix}" } }
      },
      {
        Sid      = "PinExistingNativeRolePolicy"
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:GetRolePolicy", "iam:PutRolePolicy"]
        Resource = local.role_arn
      },
      {
        Sid      = "VerifyNativeFilesystemAccessPoints"
        Effect   = "Allow"
        Action   = ["elasticfilesystem:DescribeAccessPoints"]
        Resource = aws_efs_file_system.runs.arn
      },
      {
        # AccessPointId requests also authorize the access-point resource.
        # Its opaque ID cannot encode our namespace, so require the management
        # tags written by the native provisioner. The upgrader independently
        # checks the exact AP ARN, filesystem, root and POSIX user before use.
        Sid      = "VerifyTaggedNativeAccessPoint"
        Effect   = "Allow"
        Action   = ["elasticfilesystem:DescribeAccessPoints"]
        Resource = "arn:${local.partition}:elasticfilesystem:${local.region}:${local.account_id}:access-point/fsap-*"
        Condition = {
          Null = {
            "aws:ResourceTag/NativeBinding" = "false"
            "aws:ResourceTag/NativeScope"   = "false"
          }
          StringLike = {
            "aws:ResourceTag/NativeBinding" = "????????-????-4???-????-????????????"
            "aws:ResourceTag/NativeScope"   = "????????????????????????????????????????????????????????????????"
          }
        }
      },
    ]
  })
}

# A new controller-only principal. It intentionally does not share or extend the
# legacy runtime-callable credential broker role, signing secret or policies.
resource "aws_iam_role" "execution_credentials" {
  count              = 1
  name               = "${local.name}-credentials"
  assume_role_policy = local.lambda_trust
  tags               = var.tags
}
resource "aws_iam_role_policy_attachment" "execution_credentials_basic" {
  count      = 1
  role       = aws_iam_role.execution_credentials[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
resource "aws_iam_role_policy" "execution_credentials" {
  count = 1
  name  = "native-execution-credential-resolution"
  role  = aws_iam_role.execution_credentials[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadNativeExecutionAuthority"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.bindings.arn
      },
      {
        Sid      = "ReadMembership"
        Effect   = "Allow"
        Action   = ["neptune-db:ReadDataViaQuery", "neptune-db:connect"]
        Resource = local.graph_arn
      },
      {
        Sid      = "ReadAndInvalidateSourceBinding"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = var.source_control_bindings_table_arn
      },
      {
        Sid      = "PreserveProviderCredentialRotation"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
        Resource = [var.git_connections_table_arn, var.git_provider_connections_table_arn]
      },
      {
        Sid      = "MigrateLegacyConnection"
        Effect   = "Allow"
        Action   = ["dynamodb:DeleteItem"]
        Resource = var.git_connections_table_arn
      },
      {
        Sid      = "ReadAndRotateGitToken"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter"]
        Resource = "${local.ssm_prefix_arn}/git-token/*"
      },
      {
        Sid    = "ReadPinnedModelCredential"
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          for path in [
            "bedrock-bearer-token", "kiro-api-key",
            "users/*/agent-credentials/bedrock-bearer-token", "users/*/agent-credentials/kiro-api-key",
            "projects/*/agent-credentials/bedrock-bearer-token", "projects/*/agent-credentials/kiro-api-key",
          ] : "${local.ssm_prefix_arn}/${path}"
        ]
      },
      {
        Sid      = "ReadGitHubAppConfiguration"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = var.github_app_config_param_arn
      },
      {
        Sid      = "ReadProviderSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [var.github_app_private_key_secret_arn, var.gitlab_oauth_secret_arn, var.bitbucket_oauth_secret_arn]
      },
    ]
  })
}

module "execution_credentials" {
  count                  = 1
  source                 = "terraform-aws-modules/lambda/aws"
  version                = "~> 8.0"
  function_name          = "${local.name}-credentials"
  handler                = "execution-credentials-entry.handler"
  runtime                = "nodejs24.x"
  architectures          = ["arm64"]
  memory_size            = 512
  timeout                = 60
  create_role            = false
  lambda_role            = aws_iam_role.execution_credentials[0].arn
  vpc_subnet_ids         = var.api_subnet_ids
  vpc_security_group_ids = var.api_security_group_ids
  create_package         = false
  local_existing_package = module.packages["execution-credentials"].local_filename
  environment_variables = merge(local.execution_environment, {
    NATIVE_RUNTIME_BINDINGS_TABLE      = aws_dynamodb_table.bindings.name
    NATIVE_RUNTIME_ACCOUNT_ID          = local.account_id
    NATIVE_RUNTIME_FILE_SYSTEM_ID      = aws_efs_file_system.runs.id
    NATIVE_PREPARATION_PROJECT_IDS     = jsonencode(var.project_ids)
    AWS_PARTITION                      = local.partition
    NEPTUNE_ENDPOINT                   = var.neptune_endpoint
    SOURCE_CONTROL_BINDINGS_TABLE      = var.source_control_bindings_table_name
    GIT_CONNECTIONS_TABLE              = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE     = var.git_provider_connections_table_name
    GITHUB_APP_CONFIG_PARAM            = var.github_app_config_param_name
    GITHUB_APP_PRIVATE_KEY_SECRET_NAME = var.github_app_private_key_secret_name
    GITLAB_OAUTH_SECRET_NAME           = var.gitlab_oauth_secret_name
    GITLAB_REDIRECT_URI                = var.gitlab_redirect_uri
    BITBUCKET_OAUTH_SECRET_NAME        = var.bitbucket_oauth_secret_name
    AGENT_SETTINGS_SSM_PREFIX          = local.agent_settings_prefix
    POWERTOOLS_SERVICE_NAME            = "native-execution-credentials"
    POWERTOOLS_LOG_LEVEL               = "SILENT"
    POWERTOOLS_LOGGER_LOG_EVENT        = "false"
    POWERTOOLS_LOGGER_SAMPLE_RATE      = "0"
  })
  cloudwatch_logs_retention_in_days = 7
  depends_on = [
    terraform_data.configuration,
    aws_iam_role_policy.execution_credentials,
    aws_iam_role_policy_attachment.execution_credentials_basic,
  ]
}

module "execution_worker" {
  count         = 1
  source        = "terraform-aws-modules/lambda/aws"
  version       = "~> 8.0"
  function_name = "${local.name}-execution"
  handler       = "execution-worker.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 512
  # Bounds a control/transport reconciliation, never the asynchronous model turn.
  timeout = 120
  # Polling deliberately sends the next SQS pointer to this same function.
  # Lambda's default recursion cutoff otherwise drops the chain before a long
  # turn finishes. Protected leases and terminal states still govern each run.
  recursive_loop         = "Allow"
  create_role            = false
  lambda_role            = aws_iam_role.execution_worker[0].arn
  vpc_subnet_ids         = var.api_subnet_ids
  vpc_security_group_ids = var.api_security_group_ids
  create_package         = false
  local_existing_package = module.packages["execution-worker"].local_filename
  environment_variables = merge(local.base_environment, local.execution_environment, {
    NEPTUNE_ENDPOINT                      = var.neptune_endpoint
    WORKFLOW_SOURCE_BINDINGS_TABLE        = var.workflow_source_bindings_table_name
    NATIVE_PACKAGE_JOBS_TABLE             = var.package_jobs_table_name
    SOURCE_CONTROL_BINDINGS_TABLE         = var.source_control_bindings_table_name
    NATIVE_EXECUTION_QUEUE_URL            = aws_sqs_queue.execution[0].url
    NATIVE_EXECUTION_CREDENTIALS_FUNCTION = module.execution_credentials[0].lambda_function_arn
    CONNECTIONS_TABLE                     = var.connections_table_name
    WEBSOCKET_ENDPOINT                    = var.websocket_endpoint
    POWERTOOLS_LOGGER_LOG_EVENT           = "false"
  })
  cloudwatch_logs_retention_in_days = 7
  depends_on = [
    terraform_data.configuration,
    aws_iam_role_policy.execution_worker,
    aws_iam_role_policy_attachment.execution_worker_basic,
    aws_s3_bucket_versioning.publications,
    aws_s3_bucket_policy.publications,
    aws_s3_bucket_public_access_block.publications,
    aws_s3_bucket_ownership_controls.publications,
    aws_s3_bucket_server_side_encryption_configuration.publications,
  ]
}

resource "aws_lambda_event_source_mapping" "execution" {
  count                   = 1
  event_source_arn        = aws_sqs_queue.execution[0].arn
  function_name           = module.execution_worker[0].lambda_function_arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}

output "publication_bucket_name" { value = aws_s3_bucket.publications.id }
output "execution_queue_url" { value = try(aws_sqs_queue.execution[0].url, null) }
output "execution_worker_function_name" { value = try(module.execution_worker[0].lambda_function_name, null) }
