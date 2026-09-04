data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix

  lambda_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.${local.dns_suffix}" }
    }]
  })

  shared_dir = "${path.module}/../../../../lambda/shared"
  shared_sources_hash = sha256(join("", [
    for f in sort(fileset(local.shared_dir, "**/*.{js,mjs,cjs,json}")) :
    filesha256("${local.shared_dir}/${f}")
  ]))

  managed_runtime_arn                     = "arn:${local.partition}:bedrock-agentcore:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:runtime/*"
  managed_workload_identity_directory_arn = "arn:${local.partition}:bedrock-agentcore:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:workload-identity-directory/default"
  managed_workload_identity_arn           = "${local.managed_workload_identity_directory_arn}/workload-identity/*"
  ecr_registry_host                       = split("/", var.environment_repository_url)[0]
}

resource "random_id" "context_bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "build_context" {
  bucket        = "${var.project_name}-environment-builds-${var.environment}-${random_id.context_bucket_suffix.hex}"
  force_destroy = var.environment != "prod"

  tags = var.tags
}

resource "aws_s3_bucket_versioning" "build_context" {
  bucket = aws_s3_bucket.build_context.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "build_context" {
  bucket = aws_s3_bucket.build_context.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "build_context" {
  bucket = aws_s3_bucket.build_context.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "build_context" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.build_context.arn,
      "${aws_s3_bucket.build_context.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "build_context" {
  bucket = aws_s3_bucket.build_context.id
  policy = data.aws_iam_policy_document.build_context.json
}

resource "aws_ecr_repository" "managed_tools" {
  name                 = "${var.project_name}-managed-tools-${var.environment}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.environment != "prod"

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = var.tags
}

# Tool images are pinned by digest in every environment recipe snapshot, so no
# count- or age-based expiry may touch a tagged image. Untagged images are safe:
# tags are IMMUTABLE so a tag can never move off a pinned digest, and every push
# is tagged, so an untagged image here is only aborted-push garbage. Digest-aware
# cleanup for the tagged images is tracked in issue #427.
resource "aws_ecr_lifecycle_policy" "managed_tools" {
  repository = aws_ecr_repository.managed_tools.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images left behind by failed or partial pushes"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 7
      }
      action = {
        type = "expire"
      }
    }]
  })
}

resource "aws_cloudwatch_log_group" "codebuild" {
  name              = "/aws/codebuild/${var.project_name}-managed-environments-${var.environment}"
  retention_in_days = var.environment == "prod" ? 30 : 7
  tags              = var.tags
}

resource "aws_iam_role" "build" {
  name = "${var.project_name}-environment-build-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "codebuild.${local.dns_suffix}" }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "build" {
  name = "managed-environment-image-build"
  role = aws_iam_role.build.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.codebuild.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.build_context.arn
        Condition = {
          StringLike = { "s3:prefix" = ["managed-environments/contexts/*"] }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.build_context.arn}/managed-environments/contexts/*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = [
          var.core_repository_arn,
          aws_ecr_repository.managed_tools.arn,
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = var.environment_repository_arn
      },
    ]
  })
}

resource "aws_codebuild_project" "managed_environments" {
  name           = "${var.project_name}-managed-environments-${var.environment}"
  service_role   = aws_iam_role.build.arn
  build_timeout  = 60
  queued_timeout = 60

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/amazonlinux-aarch64-standard:3.0"
    type                        = "ARM_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.codebuild.name
      stream_name = "image-build"
      status      = "ENABLED"
    }
  }

  source {
    type = "NO_SOURCE"
    buildspec = yamlencode({
      version = 0.2
      phases = {
        pre_build = {
          commands = [
            "aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin ${local.ecr_registry_host}",
            "mkdir -p build-context",
            "aws s3 cp s3://$CONTEXT_BUCKET/$CONTEXT_PREFIX/ build-context/ --recursive",
            "cd \"$CODEBUILD_SRC_DIR/build-context\"",
            "sha256sum -c checksums.sha256",
            "base_ref=$(jq -r '.base.imageUri + \"@sha256:\" + (.base.imageDigest | sub(\"^sha256:\"; \"\"))' manifest.json)",
            "grep -Fx \"FROM $base_ref\" Dockerfile >/dev/null",
            "chmod 0555 verification.sh",
          ]
        }
        build = {
          commands = [
            "cd \"$CODEBUILD_SRC_DIR/build-context\"",
            "export image_ref=$IMAGE_REPOSITORY_URI:$IMAGE_TAG",
            "docker build --platform linux/arm64 --tag $image_ref .",
            "./verification.sh $image_ref",
            "docker push $image_ref",
            "aws s3 cp verification.json s3://$CONTEXT_BUCKET/$CONTEXT_PREFIX/verification.json --sse AES256",
          ]
        }
      }
    })
  }

  tags = var.tags
}

resource "aws_iam_role" "control" {
  name               = "${var.project_name}-environment-control-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "control_basic" {
  role       = aws_iam_role.control.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "control" {
  name = "managed-environment-control"
  role = aws_iam_role.control.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:TransactWriteItems",
        ]
        Resource = [
          var.registry_table_arn,
          "${var.registry_table_arn}/index/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.build_context.arn}/managed-environments/contexts/*"
      },
      {
        Effect   = "Allow"
        Action   = ["codebuild:StartBuild"]
        Resource = aws_codebuild_project.managed_environments.arn
      },
    ]
  })
}

module "control_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-environment-control-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 60
  artifacts_dir = "builds/managed-environments/environment-control"

  source_path = [{
    path = "${path.module}/../../../../lambda/environments"
    commands = [
      "cd ../.. && npm run build -w environments -- --outdir=../../terraform/builds/managed-environments/environment-control/source",
      ":zip terraform/builds/managed-environments/environment-control/source",
    ]
  }]
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.control.arn

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  environment_variables = {
    ENVIRONMENT_REGISTRY_TABLE      = var.registry_table_name
    BUILD_CONTEXT_BUCKET            = aws_s3_bucket.build_context.id
    ENVIRONMENT_CODEBUILD_PROJECT   = aws_codebuild_project.managed_environments.name
    ENVIRONMENT_ECR_REPOSITORY_NAME = var.environment_repository_name
    ENVIRONMENT_ECR_REPOSITORY_URI  = var.environment_repository_url
    CORE_IMAGE_URI                  = var.core_image_uri
    CORE_IMAGE_DIGEST               = var.core_image_digest
    CORE_IMAGE_SIZE_BYTES           = tostring(var.core_image_size_bytes)
    CORE_RUNTIME_ARN                = var.core_runtime_arn
    CORE_RUNTIME_VERSION            = var.core_runtime_version
    RUNTIME_COMPATIBILITY_VERSION   = var.runtime_compatibility_version
    MAX_ENVIRONMENT_IMAGE_MB        = "2048"
    CORS_ALLOWED_ORIGINS            = var.cors_allowed_origins
  }
}

resource "aws_iam_role" "status" {
  name               = "${var.project_name}-environment-status-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "status_basic" {
  role       = aws_iam_role.status.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "status" {
  name = "managed-environment-status"
  role = aws_iam_role.status.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
        ]
        Resource = [
          var.registry_table_arn,
          "${var.registry_table_arn}/index/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:DescribeImages",
          "ecr:DescribeImageScanFindings",
        ]
        Resource = var.environment_repository_arn
      },
      {
        Effect = "Allow"
        Action = [
          "bedrock-agentcore:CreateAgentRuntime",
          "bedrock-agentcore:CreateAgentRuntimeEndpoint",
          "bedrock-agentcore:GetAgentRuntime",
          "bedrock-agentcore:GetAgentRuntimeEndpoint",
          "bedrock-agentcore:TagResource",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = ["bedrock-agentcore:CreateWorkloadIdentity"]
        Resource = [
          local.managed_workload_identity_directory_arn,
          local.managed_workload_identity_arn,
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:StopRuntimeSession",
        ]
        Resource = [local.managed_runtime_arn, "${local.managed_runtime_arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = var.runtime_role_arn
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "bedrock-agentcore.${local.dns_suffix}"
          }
        }
      },
    ]
  })
}

module "status_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-environment-status-${var.environment}"
  handler       = "status.handler"
  runtime       = "nodejs24.x"
  timeout       = 300
  artifacts_dir = "builds/managed-environments/environment-status"

  source_path = [{
    path = "${path.module}/../../../../lambda/environments"
    commands = [
      "cd ../.. && npm run build -w environments -- --outdir=../../terraform/builds/managed-environments/environment-status/source",
      ":zip terraform/builds/managed-environments/environment-status/source",
    ]
  }]
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.status.arn

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  environment_variables = {
    ENVIRONMENT_REGISTRY_TABLE      = var.registry_table_name
    ENVIRONMENT_ECR_REPOSITORY_NAME = var.environment_repository_name
    ENVIRONMENT_ECR_REPOSITORY_URI  = var.environment_repository_url
    MANAGED_RUNTIME_ROLE_ARN        = var.runtime_role_arn
    MANAGED_RUNTIME_NETWORK_MODE    = var.runtime_network_mode
    MANAGED_RUNTIME_SUBNETS         = jsonencode(var.runtime_subnet_ids)
    MANAGED_RUNTIME_SECURITY_GROUPS = jsonencode(var.runtime_security_group_ids)
    MANAGED_RUNTIME_ENVIRONMENT     = jsonencode(var.runtime_environment_variables)
    MANAGED_RUNTIME_TAGS            = jsonencode(var.tags)
    MAX_ENVIRONMENT_IMAGE_MB        = "2048"
  }
}

resource "aws_cloudwatch_event_rule" "build_status" {
  name = "${var.project_name}-environment-build-status-${var.environment}"

  event_pattern = jsonencode({
    source        = ["aws.codebuild"]
    "detail-type" = ["CodeBuild Build State Change"]
    detail = {
      "project-name" = [aws_codebuild_project.managed_environments.name]
      "build-status" = ["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"]
    }
  })
}

resource "aws_cloudwatch_event_target" "build_status" {
  rule      = aws_cloudwatch_event_rule.build_status.name
  target_id = "managed-environment-build-status"
  arn       = module.status_lambda.lambda_function_arn
}

resource "aws_lambda_permission" "build_status" {
  statement_id  = "AllowManagedEnvironmentBuildEvents"
  action        = "lambda:InvokeFunction"
  function_name = module.status_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.build_status.arn
}

resource "aws_cloudwatch_event_rule" "scan_status" {
  name = "${var.project_name}-environment-scan-status-${var.environment}"

  event_pattern = jsonencode({
    source        = ["aws.ecr"]
    "detail-type" = ["ECR Image Scan"]
    detail = {
      "repository-name" = [var.environment_repository_name]
      "scan-status"     = ["COMPLETE"]
    }
  })
}

resource "aws_cloudwatch_event_target" "scan_status" {
  rule      = aws_cloudwatch_event_rule.scan_status.name
  target_id = "managed-environment-scan-status"
  arn       = module.status_lambda.lambda_function_arn
}

resource "aws_lambda_permission" "scan_status" {
  statement_id  = "AllowManagedEnvironmentScanEvents"
  action        = "lambda:InvokeFunction"
  function_name = module.status_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.scan_status.arn
}

resource "aws_cloudwatch_event_rule" "runtime_validation" {
  name                = "${var.project_name}-environment-runtime-validation-${var.environment}"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "runtime_validation" {
  rule      = aws_cloudwatch_event_rule.runtime_validation.name
  target_id = "managed-environment-runtime-validation"
  arn       = module.status_lambda.lambda_function_arn
  input     = jsonencode({ action = "poll" })
}

resource "aws_lambda_permission" "runtime_validation" {
  statement_id  = "AllowManagedEnvironmentRuntimeValidation"
  action        = "lambda:InvokeFunction"
  function_name = module.status_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.runtime_validation.arn
}

resource "aws_cloudwatch_log_group" "tool_codebuild" {
  name              = "/aws/codebuild/${var.project_name}-managed-tools-${var.environment}"
  retention_in_days = var.environment == "prod" ? 30 : 7
  tags              = var.tags
}

resource "aws_iam_role" "tool_build" {
  name = "${var.project_name}-tool-build-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "codebuild.${local.dns_suffix}" }
    }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "tool_build" {
  name = "managed-tool-build"
  role = aws_iam_role.tool_build.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.tool_codebuild.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.build_context.arn
        Condition = {
          StringLike = { "s3:prefix" = ["managed-tools/*"] }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.build_context.arn}/managed-tools/*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = var.core_repository_arn
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = aws_ecr_repository.managed_tools.arn
      },
    ]
  })
}

resource "aws_codebuild_project" "managed_tools" {
  name           = "${var.project_name}-managed-tools-${var.environment}"
  service_role   = aws_iam_role.tool_build.arn
  build_timeout  = 60
  queued_timeout = 60

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_MEDIUM"
    image                       = "aws/codebuild/amazonlinux-aarch64-standard:3.0"
    type                        = "ARM_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.tool_codebuild.name
      stream_name = "tool-build"
      status      = "ENABLED"
    }
  }

  source {
    type = "NO_SOURCE"
    buildspec = yamlencode({
      version = 0.2
      phases = {
        pre_build = {
          commands = [
            "aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin ${local.ecr_registry_host}",
            "mkdir -p build-context",
            "aws s3 cp s3://$CONTEXT_BUCKET/$CONTEXT_PREFIX/ build-context/ --recursive",
            "cd \"$CODEBUILD_SRC_DIR/build-context\"",
            "sha256sum -c checksums.sha256",
            "chmod 0555 install.sh verify.sh build-tool.sh",
          ]
        }
        build = {
          commands = [
            "cd \"$CODEBUILD_SRC_DIR/build-context\"",
            "./build-tool.sh",
          ]
        }
      }
    })
  }

  tags = var.tags
}

resource "aws_iam_role" "tool_control" {
  name               = "${var.project_name}-tool-control-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "tool_control_basic" {
  role       = aws_iam_role.tool_control.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "tool_control" {
  name = "managed-tool-control"
  role = aws_iam_role.tool_control.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:TransactWriteItems",
        ]
        Resource = [
          var.registry_table_arn,
          "${var.registry_table_arn}/index/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.build_context.arn}/managed-tools/contexts/*"
      },
      {
        Effect   = "Allow"
        Action   = ["codebuild:StartBuild"]
        Resource = aws_codebuild_project.managed_tools.arn
      },
    ]
  })
}

module "tool_control_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-tool-control-${var.environment}"
  handler       = "tools-index.handler"
  runtime       = "nodejs24.x"
  timeout       = 60
  artifacts_dir = "builds/managed-environments/tool-control"

  source_path = [{
    path = "${path.module}/../../../../lambda/environments"
    commands = [
      "cd ../.. && npm run build -w environments -- --outdir=../../terraform/builds/managed-environments/tool-control/source",
      ":zip terraform/builds/managed-environments/tool-control/source",
    ]
  }]
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.tool_control.arn

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  environment_variables = {
    ENVIRONMENT_REGISTRY_TABLE    = var.registry_table_name
    BUILD_CONTEXT_BUCKET          = aws_s3_bucket.build_context.id
    TOOL_CODEBUILD_PROJECT        = aws_codebuild_project.managed_tools.name
    TOOL_ECR_REPOSITORY_NAME      = aws_ecr_repository.managed_tools.name
    TOOL_ECR_REPOSITORY_URI       = aws_ecr_repository.managed_tools.repository_url
    CORE_IMAGE_URI                = var.core_image_uri
    CORE_IMAGE_DIGEST             = var.core_image_digest
    RUNTIME_COMPATIBILITY_VERSION = var.runtime_compatibility_version
    CORS_ALLOWED_ORIGINS          = var.cors_allowed_origins
  }
}

resource "aws_cloudwatch_event_rule" "tool_catalog_bootstrap" {
  name                = "${var.project_name}-tool-catalog-bootstrap-${var.environment}"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "tool_catalog_bootstrap" {
  rule      = aws_cloudwatch_event_rule.tool_catalog_bootstrap.name
  target_id = "managed-tool-catalog-bootstrap"
  arn       = module.tool_control_lambda.lambda_function_arn
  input     = jsonencode({ action = "bootstrap" })
}

resource "aws_lambda_permission" "tool_catalog_bootstrap" {
  statement_id  = "AllowManagedToolCatalogBootstrap"
  action        = "lambda:InvokeFunction"
  function_name = module.tool_control_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.tool_catalog_bootstrap.arn
}

resource "aws_iam_role" "tool_status" {
  name               = "${var.project_name}-tool-status-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "tool_status_basic" {
  role       = aws_iam_role.tool_status.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "tool_status" {
  name = "managed-tool-status"
  role = aws_iam_role.tool_status.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan",
        ]
        Resource = [
          var.registry_table_arn,
          "${var.registry_table_arn}/index/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.build_context.arn
        Condition = {
          StringLike = { "s3:prefix" = ["managed-tools/contexts/*"] }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.build_context.arn}/managed-tools/contexts/*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:DescribeImages",
          "ecr:DescribeImageScanFindings",
        ]
        Resource = aws_ecr_repository.managed_tools.arn
      },
    ]
  })
}

module "tool_status_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-tool-status-${var.environment}"
  handler       = "tools-status.handler"
  runtime       = "nodejs24.x"
  timeout       = 300
  artifacts_dir = "builds/managed-environments/tool-status"

  source_path = [{
    path = "${path.module}/../../../../lambda/environments"
    commands = [
      "cd ../.. && npm run build -w environments -- --outdir=../../terraform/builds/managed-environments/tool-status/source",
      ":zip terraform/builds/managed-environments/tool-status/source",
    ]
  }]
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.tool_status.arn

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  environment_variables = {
    ENVIRONMENT_REGISTRY_TABLE = var.registry_table_name
    BUILD_CONTEXT_BUCKET       = aws_s3_bucket.build_context.id
    TOOL_ECR_REPOSITORY_NAME   = aws_ecr_repository.managed_tools.name
    TOOL_ECR_REPOSITORY_URI    = aws_ecr_repository.managed_tools.repository_url
    MAX_TOOL_IMAGE_MB          = "1536"
  }
}

resource "aws_cloudwatch_event_rule" "tool_build_status" {
  name = "${var.project_name}-tool-build-status-${var.environment}"

  event_pattern = jsonencode({
    source        = ["aws.codebuild"]
    "detail-type" = ["CodeBuild Build State Change"]
    detail = {
      "project-name" = [aws_codebuild_project.managed_tools.name]
      "build-status" = ["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"]
    }
  })
}

resource "aws_cloudwatch_event_target" "tool_build_status" {
  rule      = aws_cloudwatch_event_rule.tool_build_status.name
  target_id = "managed-tool-build-status"
  arn       = module.tool_status_lambda.lambda_function_arn
}

resource "aws_lambda_permission" "tool_build_status" {
  statement_id  = "AllowManagedToolBuildEvents"
  action        = "lambda:InvokeFunction"
  function_name = module.tool_status_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.tool_build_status.arn
}

resource "aws_cloudwatch_event_rule" "tool_scan_status" {
  name = "${var.project_name}-tool-scan-status-${var.environment}"

  event_pattern = jsonencode({
    source        = ["aws.ecr"]
    "detail-type" = ["ECR Image Scan"]
    detail = {
      "repository-name" = [aws_ecr_repository.managed_tools.name]
      "scan-status"     = ["COMPLETE"]
    }
  })
}

resource "aws_cloudwatch_event_target" "tool_scan_status" {
  rule      = aws_cloudwatch_event_rule.tool_scan_status.name
  target_id = "managed-tool-scan-status"
  arn       = module.tool_status_lambda.lambda_function_arn
}

resource "aws_lambda_permission" "tool_scan_status" {
  statement_id  = "AllowManagedToolScanEvents"
  action        = "lambda:InvokeFunction"
  function_name = module.tool_status_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.tool_scan_status.arn
}

resource "aws_cloudwatch_event_rule" "tool_status_poll" {
  name                = "${var.project_name}-tool-status-poll-${var.environment}"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "tool_status_poll" {
  rule      = aws_cloudwatch_event_rule.tool_status_poll.name
  target_id = "managed-tool-status-poll"
  arn       = module.tool_status_lambda.lambda_function_arn
  input     = jsonencode({ action = "poll" })
}

resource "aws_lambda_permission" "tool_status_poll" {
  statement_id  = "AllowManagedToolStatusPoll"
  action        = "lambda:InvokeFunction"
  function_name = module.tool_status_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.tool_status_poll.arn
}
