# The protected producer never executes project commands in its own Lambda.
# Each check/reviewer gets a fresh CodeBuild boundary and one input/output
# capability. Coding roles can invoke only their immutable binding alias.
locals {
  workflow_engine_name    = "${local.name}-workflow"
  workflow_engine_arn     = "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.workflow_engine_name}"
  workflow_job_name       = "${local.name}-workflow-job"
  workflow_job_arn        = "arn:${local.partition}:codebuild:${local.region}:${local.account_id}:project/${local.workflow_job_name}"
  workflow_review_path    = "/native-reviews/"
  workflow_review_arn     = "arn:${local.partition}:iam::${local.account_id}:role${local.workflow_review_path}native_review_*"
  workflow_credential_arn = "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.name}-credentials"
  # Only Start's authority captures a version. Keeping this separate avoids a
  # credentials -> engine -> credentials environment/version dependency cycle.
  workflow_capture_environment = {
    NATIVE_WORKFLOW_ENGINE_ARN     = local.workflow_engine_arn
    NATIVE_WORKFLOW_ENGINE_SHA256  = trimprefix(var.image_digest, "sha256:")
    NATIVE_WORKFLOW_ENGINE_VERSION = aws_lambda_function.workflow_engine.version
  }
  workflow_image_statements = [
    {
      Sid      = "PullQualifiedImage"
      Effect   = "Allow"
      Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
      Resource = var.image_repository_arn
    },
    { Sid = "EcrLogin", Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
  ]
  workflow_job_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "codebuild.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnEquals    = { "aws:SourceArn" = local.workflow_job_arn }
      }
    }]
  })
  workflow_job_buildspec = jsonencode({
    version  = "0.2"
    "run-as" = "root"
    phases = {
      pre_build  = { commands = ["/usr/local/bin/node /opt/agentcore/native/workflow-job.mjs prepare"] }
      build      = { commands = ["/usr/local/bin/node /opt/agentcore/native/workflow-job.mjs run"] }
      post_build = { commands = ["/usr/local/bin/node /opt/agentcore/native/workflow-job.mjs publish"] }
    }
  })
}

resource "aws_iam_role" "workflow_check" {
  name                 = "${local.name}-workflow-check"
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn != "" ? var.iam_permissions_boundary_arn : null
  assume_role_policy   = local.workflow_job_trust
  tags                 = var.tags
}
resource "aws_iam_role_policy" "workflow_check" {
  name   = "native-workflow-image"
  role   = aws_iam_role.workflow_check.id
  policy = jsonencode({ Version = "2012-10-17", Statement = local.workflow_image_statements })
}
resource "aws_iam_policy" "workflow_review_boundary" {
  name = "${local.name}-workflow-review"
  path = var.iam_role_path
  # This maximum is narrowed to one immutable alias by the producer's
  # per-binding inline policy. No Git, storage, table or engine grant exists.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.workflow_image_statements, [{
      Sid      = "OwnModelCredential"
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = "${local.workflow_credential_arn}:review_*"
    }])
  })
  tags = var.tags
}
resource "aws_codebuild_project" "workflow" {
  name           = local.workflow_job_name
  service_role   = aws_iam_role.workflow_check.arn
  build_timeout  = 10
  queued_timeout = 5
  artifacts { type = "NO_ARTIFACTS" }
  source {
    type      = "NO_SOURCE"
    buildspec = local.workflow_job_buildspec
  }
  environment {
    type                        = "ARM_CONTAINER"
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "${var.image_repository_url}@${var.image_digest}"
    image_pull_credentials_type = "SERVICE_ROLE"
    privileged_mode             = false
  }
  logs_config {
    cloudwatch_logs { status = "DISABLED" }
    s3_logs { status = "DISABLED" }
  }
  tags       = var.tags
  depends_on = [aws_iam_role_policy.workflow_check]
}

resource "aws_iam_role" "workflow_engine" {
  name                 = local.workflow_engine_name
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn != "" ? var.iam_permissions_boundary_arn : null
  assume_role_policy   = local.lambda_trust
  tags                 = var.tags
}
resource "aws_iam_role_policy_attachment" "workflow_engine_basic" {
  role       = aws_iam_role.workflow_engine.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
resource "aws_iam_role_policy" "workflow_engine" {
  name = "native-workflow-producer"
  role = aws_iam_role.workflow_engine.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadCapturedNativeAuthority"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = [aws_dynamodb_table.bindings.arn, var.workflow_source_bindings_table_arn, var.package_jobs_table_arn]
      },
      {
        Sid       = "JournalProtectedWorkflow"
        Effect    = "Allow"
        Action    = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"]
        Resource  = aws_dynamodb_table.bindings.arn
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["NATIVE#*"] } }
      },
      {
        Sid      = "CheckCurrentSpaceAccess"
        Effect   = "Allow"
        Action   = ["neptune-db:connect", "neptune-db:ReadDataViaQuery"]
        Resource = local.graph_arn
      },
      {
        Sid      = "UseExistingNativeInputOwners"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = [var.source_control_function_arn, var.trackers_function_arn]
      },
      {
        Sid    = "ReadExactRuntimeAndPublication"
        Effect = "Allow"
        Action = ["s3:GetObjectVersion"]
        Resource = [
          "${var.native_packages_bucket_arn}/native-packages/v1/*",
          "${aws_s3_bucket.publications.arn}/native-executions/*",
          "${aws_s3_bucket.publications.arn}/native-workflow-input/v1/*",
        ]
      },
      {
        Sid    = "RecordPrivateWorkflowVersions"
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:GetObjectVersion"]
        Resource = [
          "${aws_s3_bucket.publications.arn}/native-workflow-state/v1/*",
          "${aws_s3_bucket.publications.arn}/native-workflow-output/v1/*",
          "${aws_s3_bucket.publications.arn}/native-workflow-job/v1/*",
        ]
      },
      {
        Sid      = "CaptureFinishedJobVersion"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.publications.arn}/native-workflow-job/v1/*/result.json.gz"
      },
      {
        Sid      = "StartIsolatedWorkflowJobs"
        Effect   = "Allow"
        Action   = ["codebuild:StartBuild"]
        Resource = local.workflow_job_arn
      },
      {
        Sid      = "ObserveAndStopOwnedWorkflowJobs"
        Effect   = "Allow"
        Action   = ["codebuild:BatchGetBuilds", "codebuild:StopBuild"]
        Resource = local.workflow_job_arn
      },
      {
        Sid       = "PassOnlyWorkflowJobRoles"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [aws_iam_role.workflow_check.arn, local.workflow_review_arn]
        Condition = { StringEquals = { "iam:PassedToService" = "codebuild.amazonaws.com" } }
      },
      {
        Sid      = "BindModelOnlyReviewerVersion"
        Effect   = "Allow"
        Action   = ["lambda:GetAlias", "lambda:CreateAlias"]
        Resource = [local.workflow_credential_arn, "${local.workflow_credential_arn}:review_*"]
      },
      {
        Sid       = "CreateBoundedReviewerRoles"
        Effect    = "Allow"
        Action    = ["iam:CreateRole"]
        Resource  = local.workflow_review_arn
        Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.workflow_review_boundary.arn } }
      },
      {
        Sid      = "TagReviewerRoles"
        Effect   = "Allow"
        Action   = ["iam:TagRole"]
        Resource = local.workflow_review_arn
        Condition = {
          StringLike                  = { "aws:RequestTag/NativeWorkflowReviewer" = "review_????????????????????????????????" }
          "ForAllValues:StringEquals" = { "aws:TagKeys" = ["NativeWorkflowReviewer"] }
        }
      },
      {
        Sid      = "ValidateReviewerRoles"
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:PutRolePolicy"]
        Resource = local.workflow_review_arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "workflow_engine" {
  name              = "/aws/lambda/${local.workflow_engine_name}"
  retention_in_days = 7
  tags              = var.tags
}
resource "aws_ecr_repository_policy" "workflow_engine" {
  repository = split(":repository/", var.image_repository_arn)[1]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "NativeWorkflowEngineImage"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
      # Lambda documents one condition for its image retrieval: the function
      # ARN in aws:SourceArn (its example admits `function:*`). It does not say
      # whether a published version presents a qualified ARN, or that it sends
      # aws:SourceAccount. Admit this function and its qualifiers only; the ARN
      # already names the account.
      Condition = {
        ArnLike = { "aws:SourceArn" = [local.workflow_engine_arn, "${local.workflow_engine_arn}:*"] }
      }
    }]
  })
}
resource "aws_lambda_function" "workflow_engine" {
  function_name = local.workflow_engine_name
  role          = aws_iam_role.workflow_engine.arn
  package_type  = "Image"
  image_uri     = "${var.image_repository_url}@${var.image_arm64_manifest_digest}"
  architectures = ["arm64"]
  memory_size   = 2048
  timeout       = 900
  publish       = true
  ephemeral_storage { size = 2048 }
  # aws-lambda-ric 4 reads the handler and task root from the environment, not
  # from its arguments or working directory. Set both in the entry point so the
  # function does not depend on what the service provides for a non-AWS base
  # image. The installed qualification runs exactly this entry point and command.
  image_config {
    entry_point = [
      "/usr/bin/env",
      "LAMBDA_TASK_ROOT=/opt/native-runtime-control",
      "_HANDLER=workflow-engine-entry.handler",
      "/usr/local/bin/node",
      "/opt/native-lambda-interface/node_modules/aws-lambda-ric/index.mjs",
    ]
    command           = ["workflow-engine-entry.handler"]
    working_directory = "/opt/native-runtime-control"
  }
  vpc_config {
    subnet_ids         = var.api_subnet_ids
    security_group_ids = var.api_security_group_ids
  }
  environment {
    variables = merge(local.execution_environment, {
      NATIVE_RUNTIME_BINDINGS_TABLE         = aws_dynamodb_table.bindings.name
      NATIVE_RUNTIME_ACCOUNT_ID             = local.account_id
      NATIVE_RUNTIME_FILE_SYSTEM_ID         = aws_efs_file_system.runs.id
      AWS_PARTITION                         = local.partition
      NEPTUNE_ENDPOINT                      = var.neptune_endpoint
      WORKFLOW_SOURCE_BINDINGS_TABLE        = var.workflow_source_bindings_table_name
      NATIVE_PACKAGE_JOBS_TABLE             = var.package_jobs_table_name
      SOURCE_CONTROL_FUNCTION               = var.source_control_function_arn
      TRACKERS_FUNCTION                     = var.trackers_function_arn
      NATIVE_WORKFLOW_ENGINE_ARN            = local.workflow_engine_arn
      NATIVE_WORKFLOW_ENGINE_SHA256         = trimprefix(var.image_digest, "sha256:")
      NATIVE_WORKFLOW_JOB_PROJECT           = aws_codebuild_project.workflow.name
      NATIVE_WORKFLOW_JOB_PROJECT_ARN       = local.workflow_job_arn
      NATIVE_WORKFLOW_CHECK_ROLE            = aws_iam_role.workflow_check.arn
      NATIVE_WORKFLOW_REVIEW_ROLE_PATH      = local.workflow_review_path
      NATIVE_WORKFLOW_REVIEW_BOUNDARY       = aws_iam_policy.workflow_review_boundary.arn
      NATIVE_WORKFLOW_IMAGE_REPOSITORY_ARN  = var.image_repository_arn
      NATIVE_EXECUTION_CREDENTIALS_FUNCTION = local.workflow_credential_arn
      NATIVE_EXECUTION_CREDENTIALS_VERSION  = module.execution_credentials[0].lambda_function_version
      POWERTOOLS_SERVICE_NAME               = "native-workflow-engine"
      POWERTOOLS_LOG_LEVEL                  = "SILENT"
      POWERTOOLS_LOGGER_LOG_EVENT           = "false"
      POWERTOOLS_LOGGER_SAMPLE_RATE         = "0"
    })
  }
  tags = var.tags
  depends_on = [
    aws_ecr_repository_policy.workflow_engine,
    aws_iam_role_policy.workflow_engine,
    aws_iam_role_policy_attachment.workflow_engine_basic,
    aws_cloudwatch_log_group.workflow_engine,
  ]
}
