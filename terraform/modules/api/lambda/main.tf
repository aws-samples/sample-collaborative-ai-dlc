data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix

  # Lambdas that bundle code from lambda/shared/** via esbuild (gitlab, github,
  # projects, trackers) are packaged by the terraform-aws-modules/lambda module,
  # which only hashes each Lambda's OWN source_path directory. A change in a
  # bundled shared file therefore does NOT change the package hash and the Lambda
  # is silently NOT redeployed. To fix this, we fold a hash of the entire shared
  # tree into each affected module's `hash_extra`, so any shared-file edit forces
  # a rebuild. Covers nested dirs (e.g. git-providers/) via the "**" glob.
  shared_dir = "${path.module}/../../../../lambda/shared"
  shared_sources_hash = sha256(join("", [
    for f in sort(fileset(local.shared_dir, "**/*.{js,mjs,cjs,json}")) :
    filesha256("${local.shared_dir}/${f}")
  ]))

  # Neptune IAM resource ARN (scoped to the specific cluster only)
  neptune_resource_arn = "arn:${local.partition}:neptune-db:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:${var.neptune_cluster_resource_id}/*"

  # Reusable assume-role policy for Lambda services
  lambda_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.${local.dns_suffix}" }
    }]
  })

  # Neptune CRUD permissions (12 read/write Lambdas)
  neptune_statement = {
    Effect = "Allow"
    Action = [
      "neptune-db:ReadDataViaQuery",
      "neptune-db:WriteDataViaQuery",
      "neptune-db:DeleteDataViaQuery",
      "neptune-db:connect"
    ]
    Resource = local.neptune_resource_arn
  }
}

# =============================================================================
# Least-privilege IAM roles — one per Lambda responsibility domain.
#
# Threat model: avoids an over-privileged shared role.
# Prior to this split, all 16 REST-API Lambdas shared a single role with
# permissions for SecretsManager, SSM git-token/*, ECS RunTask, IAM PassRole,
# Cognito ListUsers — a compromise of any Lambda exposed all of them.
#
# After the split each Lambda receives only the permissions its handler
# actually invokes (verified by AWS SDK imports + commands + env vars audit).
# Blast radius reduced by ~90%.
# =============================================================================

# -----------------------------------------------------------------------------
# Role 1: neptune-reader (10 Lambdas, pure Neptune CRUD)
# Lambdas: users, sprints, requirements, user-stories,
#          code-files, reviews, sprint-graph, general-info, timeline-events,
#          purge-neptune
# -----------------------------------------------------------------------------
resource "aws_iam_role" "neptune_reader" {
  name               = "${var.project_name}-neptune-reader-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "neptune_reader_basic" {
  role       = aws_iam_role.neptune_reader.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "neptune_reader_vpc" {
  role       = aws_iam_role.neptune_reader.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "neptune_reader" {
  name = "neptune-access"
  role = aws_iam_role.neptune_reader.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.neptune_statement,
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = compact([var.git_connections_table_arn, var.git_provider_connections_table_arn])
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Role 2: neptune-questions (1 Lambda — questions)
# Adds DynamoDB UpdateItem/GetItem on the agent-questions table.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "neptune_questions" {
  name               = "${var.project_name}-neptune-questions-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "neptune_questions_basic" {
  role       = aws_iam_role.neptune_questions.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "neptune_questions_vpc" {
  role       = aws_iam_role.neptune_questions.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "neptune_questions" {
  name = "neptune-and-questions-table"
  role = aws_iam_role.neptune_questions.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.neptune_statement,
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = [var.agent_questions_table_arn]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Role 3: github-connector (1 Lambda — github)
# OAuth callback + token storage; no Neptune, no ECS, no Cognito.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "github_connector" {
  name               = "${var.project_name}-github-connector-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "github_connector_basic" {
  role       = aws_iam_role.github_connector.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "github_connector" {
  name = "github-oauth-and-token-storage"
  role = aws_iam_role.github_connector.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource = compact([
          var.git_connections_table_arn,
          var.git_provider_connections_table_arn,
          var.tracker_connections_table_arn,
        ])
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [var.github_oauth_secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Role 3b: trackers (1 Lambda — trackers)
# Provider-agnostic tracker integration. Needs Neptune (project + binding
# lookups), DDB read/delete on git-connections + tracker-connections, and
# SSM read/delete on git-token params (for github-issues token resolution
# and disconnect). Phase 3 will add Secrets Manager scope for Jira OAuth.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "trackers" {
  name               = "${var.project_name}-trackers-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "trackers_basic" {
  role       = aws_iam_role.trackers.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "trackers_vpc" {
  role       = aws_iam_role.trackers.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "trackers" {
  name = "tracker-providers"
  role = aws_iam_role.trackers.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        local.neptune_statement,
        {
          Effect = "Allow"
          Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
          Resource = compact([
            var.git_connections_table_arn,
            var.git_provider_connections_table_arn,
            var.tracker_connections_table_arn,
          ])
        },
        {
          Effect   = "Allow"
          Action   = ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"]
          Resource = "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
        },
        # Jira Cloud (Phase 3 / #197): the trackers lambda owns the Jira OAuth
        # flow end to end — it reads the OAuth credentials from Secrets Manager
        # and persists access + refresh tokens into a dedicated SSM prefix so
        # the GitHub-token policy stays scoped narrowly.
        {
          Effect   = "Allow"
          Action   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter"]
          Resource = "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/jira-token/*"
        },
      ],
      # Tracker OAuth secrets — read for OAuth flows, write from the
      # Admin "Tracker OAuth Apps" panel. Jira, GitHub and GitLab all flow
      # through the trackers Lambda's admin endpoints.
      var.jira_oauth_secret_arn != "" ? [
        {
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
          Resource = [var.jira_oauth_secret_arn]
        }
      ] : [],
      var.github_oauth_secret_arn != "" ? [
        {
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
          Resource = [var.github_oauth_secret_arn]
        }
      ] : [],
      var.gitlab_oauth_secret_arn != "" ? [
        {
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
          Resource = [var.gitlab_oauth_secret_arn]
        }
      ] : [],
      var.bitbucket_oauth_secret_arn != "" ? [
        {
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
          Resource = [var.bitbucket_oauth_secret_arn]
        }
      ] : [],
    )
  })
}

# -----------------------------------------------------------------------------
# Role 4: cognito-reader (1 Lambda — cognito-users)
# Only ListUsers on the project's user pool.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "cognito_reader" {
  name               = "${var.project_name}-cognito-reader-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "cognito_reader_basic" {
  role       = aws_iam_role.cognito_reader.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "cognito_reader" {
  name = "cognito-list-users"
  role = aws_iam_role.cognito_reader.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["cognito-idp:ListUsers"]
        Resource = var.cognito_user_pool_arn
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Role 5: agents-orchestrator (1 Lambda — agents)
# Superset role: Neptune + multiple DynamoDB tables + SSM agent-settings +
# ECS RunTask/DescribeTasks/StopTask (scoped to this cluster and the agent
# task-definition family) + iam:PassRole (scoped to the two ECS task roles).
# This is the most privileged Lambda role — intentionally isolated.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "agents_orchestrator" {
  name               = "${var.project_name}-agents-orchestrator-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "agents_orchestrator_basic" {
  role       = aws_iam_role.agents_orchestrator.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "agents_orchestrator_vpc" {
  role       = aws_iam_role.agents_orchestrator.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "agents_orchestrator" {
  name = "agents-orchestration"
  role = aws_iam_role.agents_orchestrator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.neptune_statement,
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"
        ]
        Resource = concat(
          var.dynamodb_table_arns,
          [for arn in var.dynamodb_table_arns : "${arn}/index/*"],
          compact([
            var.git_connections_table_arn,
            var.git_connections_table_arn != "" ? "${var.git_connections_table_arn}/index/*" : "",
            var.git_provider_connections_table_arn,
            var.git_provider_connections_table_arn != "" ? "${var.git_provider_connections_table_arn}/index/*" : ""
          ])
        )
      },
      # SSM: read and write agent settings (bearer token + MCP servers) via Admin UI
      {
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"]
        Resource = [
          "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/bedrock-bearer-token",
          "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/mcp-servers",
          "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/cli-models",
          "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/kiro-api-key",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
      },
      # Just-in-time GitLab token refresh (POST /git/refresh-token): rotate the
      # stored access token using the refresh token + GitLab OAuth secret so
      # long-running construction jobs don't push/MR with an expired token.
      # PutParameter writes the rotated token back; GetSecretValue reads the
      # GitLab OAuth client credentials. GitHub needs neither (tokens don't
      # expire). The gitlab secret ARN is empty when GitLab OAuth isn't
      # provisioned, so the statement is dropped via compact().
      {
        Effect   = "Allow"
        Action   = ["ssm:PutParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.gitlab_oauth_secret_arn != "" ? [var.gitlab_oauth_secret_arn] : ["arn:${local.partition}:secretsmanager:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:secret:nonexistent-gitlab-oauth-*"]
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.bitbucket_oauth_secret_arn != "" ? [var.bitbucket_oauth_secret_arn] : ["arn:${local.partition}:secretsmanager:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:secret:nonexistent-bitbucket-oauth-*"]
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = "${var.agent_task_definition_family_arn}:*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = var.ecs_cluster_arn
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:DescribeTasks", "ecs:StopTask"]
        Resource = "arn:${local.partition}:ecs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:task/*/*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = var.ecs_cluster_arn
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = compact([var.agent_task_role_arn, var.agent_execution_role_arn])
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.${local.dns_suffix}"
          }
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Role 6: neptune-artifacts (2 Lambdas — projects, tasks)
# Neptune CRUD + S3 GetObject/PutObject on the artifacts bucket
# (used to sign presigned URLs for steering-rule docs).
# -----------------------------------------------------------------------------
resource "aws_iam_role" "neptune_artifacts" {
  name               = "${var.project_name}-neptune-artifacts-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "neptune_artifacts_basic" {
  role       = aws_iam_role.neptune_artifacts.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "neptune_artifacts_vpc" {
  role       = aws_iam_role.neptune_artifacts.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "neptune_artifacts" {
  name = "neptune-and-artifacts-bucket"
  role = aws_iam_role.neptune_artifacts.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.neptune_statement,
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = ["${var.artifacts_bucket_arn}/steering/*"]
      }
    ]
  })
}

# Security group for Lambda
resource "aws_security_group" "lambda" {
  name        = "${var.project_name}-lambda-sg-${var.environment}"
  description = "Security group for Lambda functions"
  vpc_id      = var.vpc_id

  egress {
    description = "Allow egress for AWS API calls (DynamoDB, Neptune, S3, Cognito, Bedrock) via VPC endpoints / NAT"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Projects Lambda
module "projects_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-projects-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/projects"
      commands = [
        "cd ../.. && npm run build -w projects",
        ":zip lambda/projects/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.neptune_artifacts.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT               = var.neptune_endpoint
    ENVIRONMENT                    = var.environment
    CORS_ALLOWED_ORIGINS           = var.cors_allowed_origins
    GIT_CONNECTIONS_TABLE          = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE = var.git_provider_connections_table_name
    ARTIFACTS_BUCKET               = var.artifacts_bucket_name
  }
}

# Users Lambda
module "users_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-users-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/users"
      npm_requirements = true
    },
    {
      path          = "${path.module}/../../../../lambda/shared"
      prefix_in_zip = "shared"
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# Sprints Lambda
module "sprints_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-sprints-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/sprints"
      commands = [
        "cd ../.. && npm run build -w sprints",
        ":zip lambda/sprints/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
    # Server-origin sprint.phaseChanged fanout: the sprints lambda pushes the
    # event to sprint-channel WS connections.
    CONNECTIONS_TABLE  = var.connections_table_name
    WEBSOCKET_ENDPOINT = var.websocket_api_endpoint_https
  }
}

# Requirements Lambda
module "requirements_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-requirements-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/requirements"
      npm_requirements = true
    },
    {
      path          = "${path.module}/../../../../lambda/shared"
      prefix_in_zip = "shared"
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# User Stories Lambda
module "user_stories_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-user-stories-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/user-stories"
      npm_requirements = true
    },
    {
      path          = "${path.module}/../../../../lambda/shared"
      prefix_in_zip = "shared"
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# Tasks Lambda
module "tasks_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-tasks-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/tasks"
      commands = [
        "cd ../.. && npm run build -w tasks",
        ":zip lambda/tasks/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_artifacts.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# Code Files Lambda
module "code_files_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-code-files-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/code-files"
      npm_requirements = true
    },
    {
      path          = "${path.module}/../../../../lambda/shared"
      prefix_in_zip = "shared"
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# Reviews Lambda
module "reviews_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-reviews-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/reviews"
      npm_requirements = true
    },
    {
      path          = "${path.module}/../../../../lambda/shared"
      prefix_in_zip = "shared"
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# Questions Lambda
module "questions_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-questions-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/questions"
      commands = [
        # Anchor on the module path (absolute) instead of a relative `cd ../..`
        # so the build does not depend on the command's working directory.
        "cd ${abspath("${path.module}/../../../..")} && npm run build -w questions",
        ":zip lambda/questions/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_questions.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT      = var.neptune_endpoint
    ENVIRONMENT           = var.environment
    AGENT_QUESTIONS_TABLE = var.agent_questions_table_name
    CORS_ALLOWED_ORIGINS  = var.cors_allowed_origins
    # Server-origin question.answered fanout: the questions lambda pushes the
    # event to sprint-channel WS connections.
    CONNECTIONS_TABLE  = var.connections_table_name
    WEBSOCKET_ENDPOINT = var.websocket_api_endpoint_https
  }
}

# Sprint Graph Lambda
module "sprint_graph_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-sprint-graph-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/sprint-graph"
      commands = [
        "cd ../.. && npm run build -w sprint-graph",
        ":zip lambda/sprint-graph/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# General Info Lambda
module "general_info_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-general-info-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/general-info"
      npm_requirements = true
    },
    {
      path          = "${path.module}/../../../../lambda/shared"
      prefix_in_zip = "shared"
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# GitHub Lambda
module "github_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-github-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/github"
      commands = [
        "cd ../.. && npm run build -w github-lambda",
        ":zip lambda/github/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.github_connector.arn

  environment_variables = {
    GITHUB_OAUTH_SECRET_NAME       = var.github_oauth_secret_name
    GIT_CONNECTIONS_TABLE          = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE = var.git_provider_connections_table_name
    GIT_TOKEN_SSM_PREFIX           = "${var.project_name}/${var.environment}/git-token"
    GITHUB_REDIRECT_URI            = var.github_redirect_uri
    ENVIRONMENT                    = var.environment
    CORS_ALLOWED_ORIGINS           = var.cors_allowed_origins
  }
}

# -----------------------------------------------------------------------------
# Role 3c: gitlab-connector (1 Lambda — gitlab)
# OAuth callback + token storage for GitLab; mirrors github-connector.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "gitlab_connector" {
  name               = "${var.project_name}-gitlab-connector-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "gitlab_connector_basic" {
  role       = aws_iam_role.gitlab_connector.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "gitlab_connector" {
  name = "gitlab-oauth-and-token-storage"
  role = aws_iam_role.gitlab_connector.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = compact([var.git_connections_table_arn, var.git_provider_connections_table_arn])
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [var.gitlab_oauth_secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
      }
    ]
  })
}

# GitLab Lambda
module "gitlab_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-gitlab-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/gitlab"
      commands = [
        "cd ../.. && npm run build -w gitlab-lambda",
        ":zip lambda/gitlab/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.gitlab_connector.arn

  environment_variables = {
    GITLAB_OAUTH_SECRET_NAME       = var.gitlab_oauth_secret_name
    GIT_CONNECTIONS_TABLE          = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE = var.git_provider_connections_table_name
    GIT_TOKEN_SSM_PREFIX           = "${var.project_name}/${var.environment}/git-token"
    GITLAB_REDIRECT_URI            = var.gitlab_redirect_uri
    ENVIRONMENT                    = var.environment
    CORS_ALLOWED_ORIGINS           = var.cors_allowed_origins
  }
}

# -----------------------------------------------------------------------------
# Role 3d: bitbucket-connector (1 Lambda — bitbucket)
# OAuth callback + token storage for Bitbucket; mirrors github/gitlab-connector.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "bitbucket_connector" {
  name               = "${var.project_name}-bitbucket-connector-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "bitbucket_connector_basic" {
  role       = aws_iam_role.bitbucket_connector.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "bitbucket_connector" {
  name = "bitbucket-oauth-and-token-storage"
  role = aws_iam_role.bitbucket_connector.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = compact([var.git_connections_table_arn, var.git_provider_connections_table_arn])
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [var.bitbucket_oauth_secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
      }
    ]
  })
}

# Bitbucket Lambda
module "bitbucket_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-bitbucket-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/bitbucket"
      commands = [
        "cd ../.. && npm run build -w bitbucket-lambda",
        ":zip lambda/bitbucket/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.bitbucket_connector.arn

  environment_variables = {
    BITBUCKET_OAUTH_SECRET_NAME    = var.bitbucket_oauth_secret_name
    GIT_CONNECTIONS_TABLE          = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE = var.git_provider_connections_table_name
    GIT_TOKEN_SSM_PREFIX           = "${var.project_name}/${var.environment}/git-token"
    BITBUCKET_REDIRECT_URI         = var.bitbucket_redirect_uri
    ENVIRONMENT                    = var.environment
    CORS_ALLOWED_ORIGINS           = var.cors_allowed_origins
  }
}

# Trackers Lambda — provider-agnostic tracker integration (issue #196).
# Hosts the github-issues provider in Phase 2; Jira and others slot in later.
# Needs Neptune (project + binding lookups), DDB on git-connections + tracker-
# connections, and SSM decrypt on git-token params. The dedicated trackers
# IAM role bundles all of these.
module "trackers_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-trackers-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/trackers"
      commands = [
        "cd ../.. && npm run build -w trackers",
        ":zip lambda/trackers/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.trackers.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT               = var.neptune_endpoint
    GIT_CONNECTIONS_TABLE          = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE = var.git_provider_connections_table_name
    TRACKER_CONNECTIONS_TABLE      = var.tracker_connections_table_name
    GIT_TOKEN_SSM_PREFIX           = "${var.project_name}/${var.environment}/git-token"
    JIRA_OAUTH_SECRET_NAME         = var.jira_oauth_secret_name
    JIRA_REDIRECT_URI              = var.jira_redirect_uri
    JIRA_TOKEN_SSM_PREFIX          = "${var.project_name}/${var.environment}/jira-token"
    GITHUB_OAUTH_SECRET_NAME       = var.github_oauth_secret_name
    GITLAB_OAUTH_SECRET_NAME       = var.gitlab_oauth_secret_name
    GITLAB_REDIRECT_URI            = var.gitlab_redirect_uri
    BITBUCKET_OAUTH_SECRET_NAME    = var.bitbucket_oauth_secret_name
    BITBUCKET_REDIRECT_URI         = var.bitbucket_redirect_uri
    ENVIRONMENT                    = var.environment
    CORS_ALLOWED_ORIGINS           = var.cors_allowed_origins
  }
}

# Timeline Events Lambda
module "timeline_events_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-timeline-events-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/timeline-events"
      commands = [
        "cd ../.. && npm run build -w timeline-events",
        ":zip lambda/timeline-events/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# -----------------------------------------------------------------------------
# Role: discussions (1 Lambda — discussions)
# Neptune CRUD + read access to the realtime doc-token secret (issues HMAC
# scope tokens after a membership check) + the discussion-locks / read-state
# tables (creation + message guards) + connections-table fan-out
# (server-driven discussion.message broadcasts) + a synchronous invoke of the
# agents lambda for assist dispatch.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "discussions" {
  name               = "${var.project_name}-discussions-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "discussions_basic" {
  role       = aws_iam_role.discussions.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "discussions_vpc" {
  role       = aws_iam_role.discussions.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "discussions" {
  name = "neptune-doc-secret-locks-fanout"
  role = aws_iam_role.discussions.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.neptune_statement,
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = var.realtime_doc_secret_param_arn
      },
      {
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = [
          var.discussion_locks_table_arn,
          var.discussion_read_state_table_arn,
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = ["${var.discussion_read_state_table_arn}", "${var.connections_table_arn}/index/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = "${var.websocket_execution_arn}/*"
      },
      {
        # Assist dispatch: synchronous invoke of the agents lambda with
        # phase:'discussion' (assist runs as a pool-worker 'discussion' phase).
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = "arn:${local.partition}:lambda:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-agents-${var.environment}"
      }
    ]
  })
}

# Discussions Lambda
module "discussions_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-discussions-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/discussions"
      commands = [
        "cd ../.. && npm run build -w discussions",
        ":zip lambda/discussions/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.discussions.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT      = var.neptune_endpoint
    ENVIRONMENT           = var.environment
    CORS_ALLOWED_ORIGINS  = var.cors_allowed_origins
    REALTIME_SECRET_PARAM = var.realtime_doc_secret_param_name
    LOCKS_TABLE           = var.discussion_locks_table_name
    READ_STATE_TABLE      = var.discussion_read_state_table_name
    CONNECTIONS_TABLE     = var.connections_table_name
    WEBSOCKET_ENDPOINT    = var.websocket_api_endpoint_https
    AGENTS_LAMBDA         = "${var.project_name}-agents-${var.environment}"
    # Takeover-safety invariant: must match `timeout` above; the
    # lambda asserts message-guard pending window (120 s) > this at init.
    LAMBDA_TIMEOUT_SECONDS = "30"
  }
}

# Cognito Users Lambda (lists users from Cognito - no VPC needed)
module "cognito_users_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-cognito-users-${var.environment}"
  description   = "Lists users from Cognito User Pool"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  timeout       = 15

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/cognito-users"
      npm_requirements = true
    },
    {
      path          = "${path.module}/../../../../lambda/shared"
      prefix_in_zip = "shared"
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.cognito_reader.arn

  environment_variables = {
    COGNITO_USER_POOL_ID = var.cognito_user_pool_id
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# Purge Neptune Lambda (admin utility, invoked directly via CLI)
module "purge_neptune_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-purge-neptune-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 60

  source_path = [
    {
      path = "${path.module}/../../../../lambda/purge-neptune"
      commands = [
        "cd ../.. && npm run build -w purge-neptune",
        ":zip lambda/purge-neptune/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# Tracker-fields migration Lambda (admin one-shot, invoked directly via CLI).
# Backfills the polymorphic tracker_* properties on Sprint vertices and the
# synthetic HAS_TRACKER edges on legacy issue-integration Projects (issue
# #194 / phase #195). Idempotent; supports {dryRun:true} payload. Stays
# deployed permanently — OSS forks are on their own upgrade timelines.
module "migrate_tracker_fields_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-migrate-tracker-fields-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 300

  source_path = [
    {
      path = "${path.module}/../../../../lambda/migrate-tracker-fields"
      commands = [
        "cd ../.. && npm run build -w migrate-tracker-fields",
        ":zip lambda/migrate-tracker-fields/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.neptune_reader.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT = var.neptune_endpoint
    ENVIRONMENT      = var.environment
  }
}

# -----------------------------------------------------------------------------
# Server-origin realtime fanout.
#
# question.answered (questions + agents lambdas) and sprint.phaseChanged
# (sprints lambda) are emitted server-side via lambda/shared/ws-fanout.js —
# the ws-message client allowlist is EMPTY. These roles gain only the
# narrow fan-out permissions (connections-index query + PostToConnection).
# -----------------------------------------------------------------------------
resource "aws_iam_role_policy" "realtime_fanout" {
  for_each = {
    neptune_reader      = aws_iam_role.neptune_reader.id    # sprints lambda
    neptune_questions   = aws_iam_role.neptune_questions.id # questions lambda
    agents_orchestrator = aws_iam_role.agents_orchestrator.id
  }
  name = "realtime-fanout"
  role = each.value
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = ["${var.connections_table_arn}/index/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = "${var.websocket_execution_arn}/*"
      }
    ]
  })
}

# =============================================================================
# Create PR Lambda — invoked by the construction MCP server (trigger_pr_creation)
# =============================================================================
module "create_pr_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-create-pull-request-${var.environment}"
  handler       = "create-pr.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/create-pr"
      commands = [
        "cd ../.. && npm run build -w create-pr",
        ":zip lambda/create-pr/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.create_pr.arn
}

resource "aws_iam_role" "create_pr" {
  name               = "${var.project_name}-create-pull-request-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "create_pr_basic" {
  role       = aws_iam_role.create_pr.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
