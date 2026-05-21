data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix

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
# Threat model reference: §7.1 Pattern 2 (over-privileged shared role).
# Prior to this split, all 16 REST-API Lambdas shared a single role with
# permissions for SecretsManager, SSM git-token/*, ECS RunTask, IAM PassRole,
# Cognito ListUsers — a compromise of any Lambda exposed all of them.
#
# After the split each Lambda receives only the permissions its handler
# actually invokes (verified by AWS SDK imports + commands + env vars audit).
# Blast radius reduced by ~90%.
# =============================================================================

# -----------------------------------------------------------------------------
# Role 1: neptune-reader (12 Lambdas, pure Neptune CRUD)
# Lambdas: projects, users, sprints, requirements, user-stories, tasks,
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
        Resource = [var.git_connections_table_arn]
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
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = [var.git_connections_table_arn]
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
            var.git_connections_table_arn != "" ? "${var.git_connections_table_arn}/index/*" : ""
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
          "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/kiro-api-key",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
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
        Effect = "Allow"
        Action = ["ecs:DescribeTasks", "ecs:StopTask"]
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
      path             = "${path.module}/../../../../lambda/projects"
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
    GIT_CONNECTIONS_TABLE = var.git_connections_table_name
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
      path             = "${path.module}/../../../../lambda/sprints"
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
  runtime       = "nodejs18.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/tasks"
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
  runtime       = "nodejs18.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/questions"
      npm_requirements = true
    },
    {
      path          = "${path.module}/../../../../lambda/shared"
      prefix_in_zip = "shared"
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
  }
}

# Sprint Graph Lambda
module "sprint_graph_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-sprint-graph-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/sprint-graph"
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
  runtime       = "nodejs18.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/github"
      npm_requirements = true
    },
    {
      path          = "${path.module}/../../../../lambda/shared"
      prefix_in_zip = "shared"
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.github_connector.arn

  environment_variables = {
    GITHUB_OAUTH_SECRET_NAME = var.github_oauth_secret_name
    GIT_CONNECTIONS_TABLE    = var.git_connections_table_name
    GIT_TOKEN_SSM_PREFIX     = "${var.project_name}/${var.environment}/git-token"
    GITHUB_REDIRECT_URI      = var.github_redirect_uri
    ENVIRONMENT              = var.environment
    CORS_ALLOWED_ORIGINS     = var.cors_allowed_origins
  }
}

# Timeline Events Lambda
module "timeline_events_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-timeline-events-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/timeline-events"
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
  runtime       = "nodejs18.x"
  timeout       = 60

  source_path = [
    {
      path             = "${path.module}/../../../../lambda/purge-neptune"
      npm_requirements = true
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
