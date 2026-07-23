data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix

  # Lambdas that bundle code from lambda/shared/** via esbuild are packaged by
  # the terraform-aws-modules/lambda module,
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
  neptune_resource_arn = "arn:${local.partition}:neptune-db:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:${var.neptune_cluster_resource_id}/*"

  # Both forms are needed because durable invocations target the `live` alias.
  v2_orchestrator_function_arns = [
    "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-v2-orchestrator-${var.environment}",
    "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-v2-orchestrator-${var.environment}:*",
  ]

  source_control_function_arn    = "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-source-control-${var.environment}"
  credential_broker_function_arn = "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-credential-broker-${var.environment}"

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

# Project membership management also invalidates any OAuth bindings delegated
# by a removed member. Keep that write grant isolated from the read-only
# Lambdas that share neptune-reader.
resource "aws_iam_role" "users" {
  name               = "${var.project_name}-users-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "users_basic" {
  role       = aws_iam_role.users.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "users_vpc" {
  role       = aws_iam_role.users.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "users" {
  name = "membership-and-binding-invalidation"
  role = aws_iam_role.users.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.neptune_statement,
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:UpdateItem"]
        Resource = [var.source_control_bindings_table_arn]
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# Role 2: neptune-questions (1 Lambda — questions)
# Read-only sprint Q&A history: plain Neptune access. (The DynamoDB
# agent-questions statement went with the retired v1 answer/resume path.)
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
      local.neptune_statement
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
          var.source_control_bindings_table_arn,
          "${var.source_control_bindings_table_arn}/index/*",
        ])
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [var.github_oauth_secret_arn]
      },
      # GitHub App auth: read the private key for installation-token minting
      # and validation probes; write it from the Admin "GitHub Integration"
      # card (PUT /github/admin/config, platform-admin gated).
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
        Resource = [var.github_app_private_key_secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
      },
      # App identity config is managed independently from OAuth. Projects bind
      # a discovered installation per repository.
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter"]
        Resource = [var.github_app_config_param_arn]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Role 3b: trackers (1 Lambda — trackers)
# Provider-agnostic tracker integration. Git-backed issue operations invoke the
# project source-control service. This role only deletes Git OAuth parameters
# when a user disconnects; it never reads repository credentials.
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
          Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"]
          Resource = compact([
            var.git_connections_table_arn,
            var.git_provider_connections_table_arn,
            var.tracker_connections_table_arn,
            var.source_control_bindings_table_arn,
            "${var.source_control_bindings_table_arn}/index/*",
          ])
        },
        {
          Effect   = "Allow"
          Action   = ["lambda:InvokeFunction"]
          Resource = [local.source_control_function_arn]
        },
        {
          Effect   = "Allow"
          Action   = ["ssm:DeleteParameter"]
          Resource = "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
        },
        # Jira Cloud (Phase 3 / #197): the trackers lambda owns the Jira OAuth
        # flow end to end — it reads the OAuth credentials from Secrets Manager
        # and persists access + refresh tokens into a dedicated SSM prefix so
        # the GitHub-token policy stays scoped narrowly.
        {
          Effect   = "Allow"
          Action   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter"]
          Resource = "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/jira-token/*"
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
    )
  })
}

# -----------------------------------------------------------------------------
# Role 4: cognito-reader (1 Lambda — cognito-users)
# ListUsers (user directory) + platform-admin group management (list members,
# add/remove — the Admin page's User Management card; the Lambda enforces the
# platform-admin gate before any group mutation).
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
        Effect = "Allow"
        Action = [
          "cognito-idp:ListUsers",
          "cognito-idp:ListUsersInGroup",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
        ]
        Resource = var.cognito_user_pool_arn
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Role 5: agents-orchestrator (1 Lambda — agents)
# Superset role: Neptune + multiple DynamoDB tables + SSM agent-settings +
# AgentCore runtime invoke (v2 model discovery). The v1 ECS dispatch perms
# (RunTask/StopTask/DescribeTasks + iam:PassRole) were removed with the v1
# execution engine. Still intentionally isolated from the other Lambda roles.
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
        )
      },
      # SSM: read and write agent settings (bearer token, CLI models, Kiro API
      # key, derive enrichment mode, model pricing) via Admin UI
      {
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"]
        Resource = [
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/bedrock-bearer-token",
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/cli-models",
          # Agent tier → model configuration (incl. fallback + quorum rows),
          # merged under a project's tier_models at intent create.
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/tier-models",
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/kiro-api-key",
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/derive-enrichment",
          # Platform stage-skipping toggle (per-intent stage skipping;
          # snapshotted onto the execution META row at intent create).
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/stage-skipping",
          # Platform default for project PR delivery inheritance.
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/pr-strategy",
          # Composer LLM-bypass toggle (deterministic keyword match vs always-LLM).
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/compose-llm-bypass",
          # Global custom MCP servers injected into every agent session (merged
          # with project-level entries at intent-create).
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/custom-mcp-servers",
          # Token→USD price table, refreshed from the Price List API on model
          # discovery and read by the intents lambda to compute cost.
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/model-pricing",
        ]
      },
      # GLOBAL-tier MCP secrets (one SecureString per referenced ${VAR}). The
      # agents lambda lists them (set-state only, no decrypt), rotates (Put) and
      # clears (Delete) them from the Admin MCP editor. Kept in a SEPARATE
      # statement because it needs GetParametersByPath + DeleteParameter and a
      # wildcard path, which the fixed settings params above do not.
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
          "ssm:PutParameter",
          "ssm:DeleteParameter",
        ]
        Resource = [
          # The path NODE itself — GetParametersByPath authorizes against the
          # queried path, which `/*` (children only) does NOT match.
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/mcp-secrets",
          # The per-var parameters under it (Get/Put/Delete of {VAR}).
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/mcp-secrets/*",
        ]
      },
      # Model discovery for the project-settings picker (GET /agents/capabilities
      # ?models=1): list the region's Bedrock inference profiles (claude/opencode
      # models) and invoke the v2 runtime's `capabilities` command (Kiro's model
      # list + per-CLI auth state). ListInferenceProfiles is not resource-scopable.
      {
        Effect   = "Allow"
        Action   = ["bedrock:ListInferenceProfiles"]
        Resource = "*"
      },
      # Token→USD pricing: read published Bedrock model prices from the AWS Price
      # List API on model discovery, to refresh the model-pricing SSM table.
      # pricing:GetProducts is not resource-scopable.
      {
        Effect   = "Allow"
        Action   = ["pricing:GetProducts"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
        Resource = [var.agentcore_runtime_arn, "${var.agentcore_runtime_arn}/*"]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Role 6: neptune-artifacts (Projects Lambda)
# Neptune CRUD + S3 presign for project custom agent rules (custom-rules/
# prefix): the projects lambda mints presigned PUT/GET URLs so the browser
# uploads/downloads the .md bodies directly.
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
      # Project custom agent rules: presign PUT/GET for the .md bodies under
      # the custom-rules/ prefix, and permanently purge on delete — the bucket
      # is versioned, so we delete all versions (DeleteObjectVersion +
      # ListBucketVersions) rather than leave a retrievable delete marker.
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
        ]
        Resource = ["${var.artifacts_bucket_arn}/custom-rules/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucketVersions"]
        Resource = [var.artifacts_bucket_arn]
        Condition = {
          StringLike = { "s3:prefix" = ["custom-rules/*"] }
        }
      },
      # Project deletion reuses the intent cascade, which purges every
      # committed attachment version for each child intent. This shared role
      # is also used by tasks, so keep the grant restricted to the attachment
      # prefix rather than broadening bucket access.
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
        ]
        Resource = ["${var.artifacts_bucket_arn}/intent-attachments/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucketVersions"]
        Resource = [var.artifacts_bucket_arn]
        Condition = {
          StringLike = { "s3:prefix" = ["intent-attachments/*"] }
        }
      },
      # Project-tier MCP secrets: the projects lambda lists (set-state only),
      # rotates (Put) and clears (Delete) per-var SecureStrings under
      # projects/<id>/mcp-secrets/*. It also READS the GLOBAL custom-mcp-servers
      # config (refs-only) to run the save-time cross-tier collision check.
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
          "ssm:PutParameter",
          "ssm:DeleteParameter",
        ]
        Resource = [
          # The path NODE per project — GetParametersByPath authorizes against
          # the queried path itself, which `/*` (children only) does NOT match.
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/projects/*/mcp-secrets",
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/projects/*/mcp-secrets/*",
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/custom-mcp-servers",
        ]
      },
    ]
  })
}

# Project delete cascades into every child intent, reusing the intents lambda's
# hardened deletion (shared/intent-deletion.js). That needs, beyond Neptune:
# drain each EXEC#<id> partition in the v2 process table (incl. METRIC# rows),
# remove intent-scoped Yjs docs, stop live AgentCore sessions, and wake parked
# durable callbacks with a cancel sentinel. The role is assumed only by the
# Projects Lambda; Tasks uses its own Neptune-only role below.
resource "aws_iam_role_policy" "projects_intent_cascade" {
  name = "projects-intent-cascade"
  role = aws_iam_role.neptune_artifacts.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # v2 process table: enumerate a project's executions (GSI1) then drain
        # each EXEC#<id> partition (Query + BatchWrite delete).
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:DeleteItem",
          "dynamodb:BatchWriteItem",
        ]
        Resource = [
          var.v2_executions_table_arn,
          "${var.v2_executions_table_arn}/index/*",
        ]
      },
      {
        # Yjs documents: remove the intent-scoped realtime docs (gate editors,
        # discussion threads, presence) for each deleted intent.
        Effect   = "Allow"
        Action   = ["dynamodb:DeleteItem"]
        Resource = [var.yjs_documents_table_arn]
      },
      {
        # Wake a parked run's suspended durable callback with a cancel sentinel
        # so nothing resumes into a deleted partition.
        Effect   = "Allow"
        Action   = ["lambda:SendDurableExecutionCallbackSuccess"]
        Resource = local.v2_orchestrator_function_arns
      },
      {
        # Stop a deleted intent's live AgentCore session(s).
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:StopRuntimeSession"]
        Resource = [var.agentcore_runtime_arn, "${var.agentcore_runtime_arn}/*"]
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# Role 6b: neptune-tasks (Tasks Lambda)
# Tasks only need direct Neptune access. Keeping this separate prevents a task
# handler from inheriting project deletion, S3, SSM, or AgentCore permissions.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "neptune_tasks" {
  name               = "${var.project_name}-neptune-tasks-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "neptune_tasks_basic" {
  role       = aws_iam_role.neptune_tasks.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "neptune_tasks_vpc" {
  role       = aws_iam_role.neptune_tasks.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "neptune_tasks" {
  name = "neptune-access"
  role = aws_iam_role.neptune_tasks.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [local.neptune_statement]
  })
}

# -----------------------------------------------------------------------------
# Role 7: blocks (2 Lambdas — building-blocks CRUD + seed-blocks)
# DynamoDB RW on the blocks table + its GSI1, plus S3 RW scoped to the blocks/
# prefix (content-addressed block bodies/scripts) and the aidlc-runtime/ prefix
# (the seed job's commit-pinned internal runtime snapshot) of the artifacts
# bucket. No Neptune, no VPC — pure DDB + S3.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "blocks" {
  name               = "${var.project_name}-blocks-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "blocks_basic" {
  role       = aws_iam_role.blocks.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "blocks" {
  name = "blocks-table-and-bucket"
  role = aws_iam_role.blocks.id
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
          # Scan: the seed-blocks reseed mode scans for SYSTEM-owned partitions
          # to clear before rewriting the baseline (rare admin op, small table).
          "dynamodb:Scan",
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem",
        ]
        Resource = [var.blocks_table_arn, "${var.blocks_table_arn}/index/*"]
      },
      {
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject"]
        Resource = [
          "${var.artifacts_bucket_arn}/blocks/*",
          "${var.artifacts_bucket_arn}/aidlc-runtime/*",
        ]
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

# Project source-control service. This is the only API-facing component allowed
# to resolve delegated credentials and call repository provider APIs.
resource "aws_iam_role" "source_control" {
  name               = "${var.project_name}-source-control-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "source_control_basic" {
  role       = aws_iam_role.source_control.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "source_control_vpc" {
  role       = aws_iam_role.source_control.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "source_control" {
  name = "project-source-control"
  role = aws_iam_role.source_control.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.neptune_statement,
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchWriteItem",
          "dynamodb:TransactWriteItems",
        ]
        Resource = [
          var.source_control_bindings_table_arn,
          "${var.source_control_bindings_table_arn}/index/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ]
        Resource = compact([
          var.git_connections_table_arn,
          var.git_provider_connections_table_arn,
        ])
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
      },
      {
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = compact([
          var.github_app_config_param_arn,
        ])
      },
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = compact([
          var.github_app_private_key_secret_arn,
          var.gitlab_oauth_secret_arn,
        ])
      },
    ]
  })
}

module "source_control_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-source-control-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 120

  source_path = [
    {
      path = "${path.module}/../../../../lambda/source-control"
      commands = [
        "cd ../.. && npm run build -w source-control",
        ":zip lambda/source-control/.build",
      ]
    }
  ]
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.source_control.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  environment_variables = {
    NEPTUNE_ENDPOINT                   = var.neptune_endpoint
    SOURCE_CONTROL_BINDINGS_TABLE      = var.source_control_bindings_table_name
    GIT_CONNECTIONS_TABLE              = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE     = var.git_provider_connections_table_name
    GITHUB_APP_CONFIG_PARAM            = var.github_app_config_param_name
    GITHUB_APP_PRIVATE_KEY_SECRET_NAME = var.github_app_private_key_secret_name
    GITLAB_OAUTH_SECRET_NAME           = var.gitlab_oauth_secret_name
    GITLAB_REDIRECT_URI                = var.gitlab_redirect_uri
    ENVIRONMENT                        = var.environment
    CORS_ALLOWED_ORIGINS               = var.cors_allowed_origins
  }
}

# AgentCore-only credential broker. It has no API Gateway or event source; the
# runtime role is the sole role granted lambda:InvokeFunction below.
resource "aws_iam_role" "credential_broker" {
  name               = "${var.project_name}-credential-broker-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "credential_broker_basic" {
  role       = aws_iam_role.credential_broker.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "credential_broker" {
  name = "agentcore-credential-resolution"
  role = aws_iam_role.credential_broker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = [var.v2_executions_table_arn, var.source_control_bindings_table_arn]
      },
      {
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = compact([
          var.git_connections_table_arn,
          var.git_provider_connections_table_arn,
        ])
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = [var.github_app_config_param_arn]
      },
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = compact([
          var.github_app_private_key_secret_arn,
          var.gitlab_oauth_secret_arn,
        ])
      },
    ]
  })
}

module "credential_broker_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-credential-broker-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/credential-broker"
      commands = [
        "cd ../.. && npm run build -w credential-broker",
        ":zip lambda/credential-broker/.build",
      ]
    }
  ]
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.credential_broker.arn

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  environment_variables = {
    V2_PROCESS_TABLE                   = var.v2_executions_table_name
    SOURCE_CONTROL_BINDINGS_TABLE      = var.source_control_bindings_table_name
    GIT_CONNECTIONS_TABLE              = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE     = var.git_provider_connections_table_name
    GITHUB_APP_CONFIG_PARAM            = var.github_app_config_param_name
    GITHUB_APP_PRIVATE_KEY_SECRET_NAME = var.github_app_private_key_secret_name
    GITLAB_OAUTH_SECRET_NAME           = var.gitlab_oauth_secret_name
    GITLAB_REDIRECT_URI                = var.gitlab_redirect_uri
  }
}

# Projects Lambda
module "projects_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-projects-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  # Project delete cascades sequentially through every child intent (each a
  # multi-store purge), so give it more headroom than the 30s CRUD default. API
  # Gateway still caps the synchronous response at 29s, but the cascade drops the
  # Project vertex LAST, so a client-side timeout on a big project leaves it
  # listed and the delete simply re-runs to completion.
  timeout = 300

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
    SOURCE_CONTROL_BINDINGS_TABLE  = var.source_control_bindings_table_name
    ARTIFACTS_BUCKET               = var.artifacts_bucket_name
    # Project delete fans out into the intents' process state: the v2 process
    # table (drained per intent, incl. metrics), the intent-scoped Yjs docs, and
    # the AgentCore runtime (stop live sessions of deleted intents).
    V2_PROCESS_TABLE      = var.v2_executions_table_name
    YJS_DOCUMENTS_TABLE   = var.yjs_documents_table_name
    AGENTCORE_RUNTIME_ARN = var.agentcore_runtime_arn
    # MCP secrets: the base SSM prefix for per-var SecureStrings (project tier at
    # {prefix}/projects/<id>/mcp-secrets/<VAR>) + the global config read for the
    # save-time cross-tier collision check.
    MCP_SECRETS_SSM_PREFIX    = "/${var.project_name}/${var.environment}"
    AGENT_SETTINGS_SSM_PREFIX = "/${var.project_name}/${var.environment}"
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
      path = "${path.module}/../../../../lambda/users"
      commands = [
        "cd ../.. && npm run build -w users",
        ":zip lambda/users/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.users.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT              = var.neptune_endpoint
    SOURCE_CONTROL_BINDINGS_TABLE = var.source_control_bindings_table_name
    ENVIRONMENT                   = var.environment
    CORS_ALLOWED_ORIGINS          = var.cors_allowed_origins
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
      path = "${path.module}/../../../../lambda/requirements"
      commands = [
        "cd ../.. && npm run build -w requirements",
        ":zip lambda/requirements/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

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
      path = "${path.module}/../../../../lambda/user-stories"
      commands = [
        "cd ../.. && npm run build -w user-stories",
        ":zip lambda/user-stories/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

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
  lambda_role = aws_iam_role.neptune_tasks.arn

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
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/code-files"
      commands = [
        "cd ../.. && npm run build -w code-files",
        ":zip lambda/code-files/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

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
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/reviews"
      commands = [
        "cd ../.. && npm run build -w reviews",
        ":zip lambda/reviews/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

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
    NEPTUNE_ENDPOINT     = var.neptune_endpoint
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
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
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/general-info"
      commands = [
        "cd ../.. && npm run build -w general-info",
        ":zip lambda/general-info/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

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
    GITHUB_OAUTH_SECRET_NAME           = var.github_oauth_secret_name
    GIT_CONNECTIONS_TABLE              = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE     = var.git_provider_connections_table_name
    GIT_TOKEN_SSM_PREFIX               = "${var.project_name}/${var.environment}/git-token"
    GITHUB_REDIRECT_URI                = var.github_redirect_uri
    GITHUB_APP_CONFIG_PARAM            = var.github_app_config_param_name
    GITHUB_APP_PRIVATE_KEY_SECRET_NAME = var.github_app_private_key_secret_name
    ENVIRONMENT                        = var.environment
    CORS_ALLOWED_ORIGINS               = var.cors_allowed_origins
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
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
        ]
        Resource = compact([
          var.git_connections_table_arn,
          var.git_provider_connections_table_arn,
          var.source_control_bindings_table_arn,
          "${var.source_control_bindings_table_arn}/index/*",
        ])
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [var.gitlab_oauth_secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
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
    SOURCE_CONTROL_BINDINGS_TABLE  = var.source_control_bindings_table_name
    GIT_TOKEN_SSM_PREFIX           = "${var.project_name}/${var.environment}/git-token"
    GITLAB_REDIRECT_URI            = var.gitlab_redirect_uri
    ENVIRONMENT                    = var.environment
    CORS_ALLOWED_ORIGINS           = var.cors_allowed_origins
  }
}

# -----------------------------------------------------------------------------
# Role 3d: bitbucket-connector (1 Lambda — bitbucket)
# OAuth callback + token storage; no Neptune, no ECS, no Cognito. Mirrors the
# gitlab-connector role (Bitbucket tokens refresh like GitLab's).
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
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
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

# Trackers Lambda — provider-agnostic tracker integration. Git-backed providers
# delegate issue operations to the project source-control service.
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
    JIRA_OAUTH_SECRET_NAME         = var.jira_oauth_secret_name
    JIRA_REDIRECT_URI              = var.jira_redirect_uri
    JIRA_TOKEN_SSM_PREFIX          = "${var.project_name}/${var.environment}/jira-token"
    GITHUB_OAUTH_SECRET_NAME       = var.github_oauth_secret_name
    GITLAB_OAUTH_SECRET_NAME       = var.gitlab_oauth_secret_name
    GITLAB_REDIRECT_URI            = var.gitlab_redirect_uri
    SOURCE_CONTROL_FUNCTION        = module.source_control_lambda.lambda_function_name
    SOURCE_CONTROL_BINDINGS_TABLE  = var.source_control_bindings_table_name
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
# tables (creation + message/assist guards) + connections-table fan-out
# (server-driven discussion.message broadcasts) + Quorum AgentCore invocation.
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
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
        Resource = [var.agentcore_runtime_arn, "${var.agentcore_runtime_arn}/*"]
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
    AGENTCORE_RUNTIME_ARN = var.agentcore_runtime_arn
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
  description   = "Cognito user directory + platform-admin role management"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 15

  source_path = [
    {
      path = "${path.module}/../../../../lambda/cognito-users"
      commands = [
        "cd ../.. && npm run build -w cognito-users-lambda",
        ":zip lambda/cognito-users/.build",
      ]
    }
  ]

  # Force a rebuild when bundled lambda/shared/** changes (see local above).
  hash_extra = local.shared_sources_hash

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

# Building Blocks Lambda — CRUD over the reusable-block library. DynamoDB + S3
# only, so no VPC config. Generic over all block types; block metadata lives in
# the blocks table, bodies/scripts in the artifacts bucket under blocks/.
module "building_blocks_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-building-blocks-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/building-blocks"
      commands = [
        "cd ../.. && npm run build -w building-blocks",
        ":zip lambda/building-blocks/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.blocks.arn

  environment_variables = {
    BLOCKS_TABLE         = var.blocks_table_name
    ARTIFACTS_BUCKET     = var.artifacts_bucket_name
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
  }
}

# Seed-blocks Lambda (admin one-shot, invoked directly via CLI). Writes the
# SYSTEM baseline library blocks into the blocks table + artifacts bucket.
# Idempotent (attribute_not_exists guard); supports {dryRun:true}. Mirrors the
# migrate-tracker-fields operational-job pattern. Reuses the blocks IAM role.
# Stays deployed permanently — OSS forks are on their own upgrade timelines.
module "seed_blocks_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-seed-blocks-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 300

  source_path = [
    {
      path = "${path.module}/../../../../lambda/seed-blocks"
      commands = [
        "cd ../.. && npm run build -w seed-blocks",
        ":zip lambda/seed-blocks/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.blocks.arn

  environment_variables = {
    BLOCKS_TABLE     = var.blocks_table_name
    ARTIFACTS_BUCKET = var.artifacts_bucket_name
    ENVIRONMENT      = var.environment
    AIDLC_REPO_REF   = var.aidlc_repo_ref
  }
}

# Workflows Lambda — composition over the block library: a workflow references
# and arranges library blocks (grouping tree + skill placements + scope/
# guardrail refs). Workflows share the blocks table (WF#… partitions) and the
# blocks IAM role; no S3 (workflows carry no bodies), so no VPC config.
module "workflows_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-workflows-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path = "${path.module}/../../../../lambda/workflows"
      commands = [
        "cd ../.. && npm run build -w workflows",
        ":zip lambda/workflows/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.blocks.arn

  environment_variables = {
    BLOCKS_TABLE         = var.blocks_table_name
    ENVIRONMENT          = var.environment
    CORS_ALLOWED_ORIGINS = var.cors_allowed_origins
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
    v2_orchestrator     = aws_iam_role.v2_orchestrator.id # durable orchestrator live fan-out
    intents             = aws_iam_role.intents.id         # artifact edit / quorum-edit reload hints
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
# v2 intents API Lambda
#
# CRUD over v2 intents: reads/writes the v2 process table (DynamoDB), reads
# project membership + artifacts from Neptune (VPC), mints intent realtime scope
# tokens (realtime doc secret), reads the blocks table to pin a workflow version,
# starts the orchestrator durable execution (lambda:InvokeFunction), and resumes
# a parked run by completing its durable callback
# (lambda:SendDurableExecutionCallbackSuccess).
# =============================================================================

resource "aws_iam_role" "intents" {
  name               = "${var.project_name}-intents-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "intents_basic" {
  role       = aws_iam_role.intents.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "intents_vpc" {
  role       = aws_iam_role.intents.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "intents" {
  name = "v2-intents"
  role = aws_iam_role.intents.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.neptune_statement,
      {
        # v2 process table: read/write execution state + GSI1 list. Delete /
        # BatchWrite drain the whole EXEC#<id> partition on intent delete.
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:DeleteItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:TransactWriteItems",
        ]
        Resource = [
          var.v2_executions_table_arn,
          "${var.v2_executions_table_arn}/index/*",
        ]
      },
      {
        # Yjs documents: remove the intent-scoped realtime docs (gate editors,
        # discussion threads, presence) when an intent is deleted.
        Effect   = "Allow"
        Action   = ["dynamodb:DeleteItem"]
        Resource = [var.yjs_documents_table_arn]
      },
      {
        # Blocks table: resolve a workflow's latest version to pin at create
        # (GetItem on the META row) and validate the intent's scope against the
        # pinned workflow snapshot (Query on the base table + GSI1).
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = [var.blocks_table_arn, "${var.blocks_table_arn}/index/*"]
      },
      {
        # Realtime scope-token signing secret + the Admin global cli-models
        # default (merged under the project selection at intent create, so the
        # runtime model precedence is project > global > agentBlock > env) +
        # the derive-enrichment mode (snapshotted onto the execution META row
        # at intent create so the toggle needs no redeploy).
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          var.realtime_doc_secret_param_arn,
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/cli-models",
          # Admin global tier-models config (agent tier → model rows + fallback
          # + quorum), merged under the project's tier_models at intent create.
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/tier-models",
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/derive-enrichment",
          # Platform stage-skipping toggle (effective value — project override
          # over this — snapshotted onto the execution META at intent create).
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/stage-skipping",
          # Platform default for project PR delivery inheritance.
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/pr-strategy",
          # Composer LLM-bypass toggle (deterministic keyword match vs always-LLM).
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/compose-llm-bypass",
          # Global custom MCP servers default (merged under the project's custom
          # MCP servers at intent create, snapshotted onto the execution META).
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/custom-mcp-servers",
          # Token→USD price table (written by the agents lambda) — read to attach
          # cost to the intent's metric samples in the detail/rollup DTOs.
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/model-pricing",
        ]
      },
      {
        # Start the orchestrator (Event invoke) + complete a parked durable
        # callback to resume a suspended run.
        Effect = "Allow"
        Action = [
          "lambda:InvokeFunction",
          "lambda:SendDurableExecutionCallbackSuccess",
        ]
        Resource = local.v2_orchestrator_function_arns
      },
      {
        # Validate project bindings before Start and perform authenticated
        # review operations without resolving credentials in this Lambda.
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = [local.source_control_function_arn]
      },
      {
        # Watchdog repair: verify stale local rows against the durable execution
        # service before marking them failed. The authenticated lane repair
        # endpoint also stops an orphaned durable run before relaunching it.
        Effect   = "Allow"
        Action   = ["lambda:GetDurableExecution", "lambda:ListDurableExecutionsByFunction", "lambda:StopDurableExecution"]
        Resource = local.v2_orchestrator_function_arns
      },
      {
        # Compose report uploads: presign the PUT (report-mode composer input)
        # and read the bounded excerpt back at compose dispatch. Namespaced
        # under compose-reports/ so this grant can't touch artifact bodies.
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${var.artifacts_bucket_arn}/compose-reports/*"
      },
      {
        # DRAFT intent prompt attachments: mint browser PUT URLs, validate
        # committed objects, and purge removed/versioned objects.
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource = "${var.artifacts_bucket_arn}/intent-attachments/*"
      },
      {
        # Async Lambda invocation failures are delivered to this queue after
        # Lambda exhausts its own retry policy.
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.intents_attachment_events_dlq.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucketVersions"]
        Resource = var.artifacts_bucket_arn
      },
      {
        # Manual graph-projection backfill (POST .../intents/{id}/derive):
        # dispatch the derive-artifacts command to the AgentCore runtime.
        # StopRuntimeSession: rewind/cancel/delete stop the intent's live
        # session so a relaunch starts a fresh microVM on the CURRENT image
        # (zombie-session field incident) and a cancelled run frees compute.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"]
        Resource = [var.agentcore_runtime_arn, "${var.agentcore_runtime_arn}/*"]
      },
    ]
  })
}

module "intents_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-intents-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 120

  source_path = [
    {
      path = "${path.module}/../../../../lambda/intents"
      commands = [
        "cd ../.. && npm run build -w intents",
        ":zip lambda/intents/.build",
      ]
    }
  ]
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.intents.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  environment_variables = {
    NEPTUNE_ENDPOINT      = var.neptune_endpoint
    ENVIRONMENT           = var.environment
    CORS_ALLOWED_ORIGINS  = var.cors_allowed_origins
    V2_PROCESS_TABLE      = var.v2_executions_table_name
    BLOCKS_TABLE          = var.blocks_table_name
    REALTIME_SECRET_PARAM = var.realtime_doc_secret_param_name
    # Intent-scoped realtime docs are removed on intent delete.
    YJS_DOCUMENTS_TABLE = var.yjs_documents_table_name
    # Admin global cli-models default lives under this SSM prefix; the intents
    # lambda merges it under the project selection at intent create.
    AGENT_SETTINGS_SSM_PREFIX = "/${var.project_name}/${var.environment}"
    # The AgentCore stage-executor runtime — for the manual derive backfill
    # (POST .../intents/{id}/derive, platform admin).
    AGENTCORE_RUNTIME_ARN = var.agentcore_runtime_arn
    # Compose report uploads (presigned PUT + bounded read-back at dispatch).
    ARTIFACTS_BUCKET = var.artifacts_bucket_name
    # Server-origin realtime reload hints (artifact edited/verified, quorum
    # edit lifecycle) on the intent channel — lambda/shared/ws-fanout.js.
    CONNECTIONS_TABLE  = var.connections_table_name
    WEBSOCKET_ENDPOINT = var.websocket_api_endpoint_https
    # Qualified name (function:alias) — durable functions reject $LATEST invokes.
    V2_ORCHESTRATOR_FUNCTION          = "${module.v2_orchestrator_lambda.lambda_function_name}:${module.v2_orchestrator_alias.lambda_alias_name}"
    SOURCE_CONTROL_FUNCTION           = module.source_control_lambda.lambda_function_name
    DURABLE_EXECUTION_TIMEOUT_SECONDS = "31622400"
  }
}

resource "aws_cloudwatch_event_rule" "intents_durable_watchdog" {
  name                = "${var.project_name}-intents-durable-watchdog-${var.environment}"
  description         = "Repair v2 intents whose durable orchestrator expired while process state remained active"
  schedule_expression = "rate(1 day)"
}

resource "aws_cloudwatch_event_target" "intents_durable_watchdog" {
  rule      = aws_cloudwatch_event_rule.intents_durable_watchdog.name
  target_id = "intents-durable-watchdog"
  arn       = module.intents_lambda.lambda_function_arn
  input     = jsonencode({ action = "repair-durable-executions" })
}

resource "aws_lambda_permission" "intents_durable_watchdog" {
  statement_id  = "AllowExecutionFromDurableWatchdog"
  action        = "lambda:InvokeFunction"
  function_name = module.intents_lambda.lambda_function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.intents_durable_watchdog.arn
}

resource "aws_sqs_queue" "intents_attachment_events_dlq" {
  name                      = "${var.project_name}-intents-attachment-events-dlq-${var.environment}"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue_policy" "intents_attachment_events_dlq" {
  queue_url = aws_sqs_queue.intents_attachment_events_dlq.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.intents_attachment_events_dlq.arn
      Condition = {
        ArnEquals = {
          "aws:SourceArn" = aws_cloudwatch_event_rule.intents_attachment_created.arn
        }
      }
      }, {
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.intents_attachment_events_dlq.arn
      Condition = {
        ArnEquals = {
          "aws:SourceArn" = module.intents_lambda.lambda_function_arn
        }
      }
    }]
  })
}

resource "aws_cloudwatch_event_rule" "intents_attachment_created" {
  name        = "${var.project_name}-intents-attachment-created-${var.environment}"
  description = "Promote intent attachment uploads after S3 confirms object creation"
  event_pattern = jsonencode({
    source        = ["aws.s3"]
    "detail-type" = ["Object Created"]
    detail = {
      bucket = { name = [var.artifacts_bucket_name] }
      object = { key = [{ prefix = "intent-attachments/staging/" }] }
    }
  })
}

resource "aws_cloudwatch_event_target" "intents_attachment_created" {
  rule      = aws_cloudwatch_event_rule.intents_attachment_created.name
  target_id = "intents-attachment-created"
  arn       = module.intents_lambda.lambda_function_arn

  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 12
  }

  dead_letter_config {
    arn = aws_sqs_queue.intents_attachment_events_dlq.arn
  }
}

resource "aws_lambda_permission" "intents_attachment_created" {
  statement_id  = "AllowExecutionFromAttachmentEvents"
  action        = "lambda:InvokeFunction"
  function_name = module.intents_lambda.lambda_function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.intents_attachment_created.arn
}

resource "aws_lambda_function_event_invoke_config" "intents_attachment_created" {
  function_name                = module.intents_lambda.lambda_function_name
  maximum_event_age_in_seconds = 3600
  maximum_retry_attempts       = 2

  destination_config {
    on_failure {
      destination = aws_sqs_queue.intents_attachment_events_dlq.arn
    }
  }
}

# =============================================================================
# v2 orchestrator Lambda (durable function)
#
# Sequences an intent's stages end to end. NOT VPC-attached: it reaches Neptune
# only THROUGH the AgentCore runtime (init-ws/run-stage), and reads the v2
# process + blocks tables over the public DynamoDB endpoint. Durable execution
# checkpoints each run-stage and suspends on human-gate callbacks.
# =============================================================================

resource "aws_iam_role" "v2_orchestrator" {
  name               = "${var.project_name}-v2-orchestrator-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "v2_orchestrator_basic" {
  role       = aws_iam_role.v2_orchestrator.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "v2_orchestrator" {
  name = "v2-orchestrator"
  role = aws_iam_role.v2_orchestrator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Durable execution: checkpoint + replay state.
        Effect   = "Allow"
        Action   = ["lambda:CheckpointDurableExecution", "lambda:GetDurableExecutionState"]
        Resource = local.v2_orchestrator_function_arns
      },
      {
        # Invoke the AgentCore stage-executor runtime (init-ws / run-stage) and
        # release a parked session's warm compute (D1 release-on-park).
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"]
        Resource = ["${var.agentcore_runtime_arn}", "${var.agentcore_runtime_arn}/*"]
      },
      {
        # v2 process table: drive execution + stage + gate state.
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = [
          var.v2_executions_table_arn,
          "${var.v2_executions_table_arn}/index/*",
        ]
      },
      {
        # Blocks table: load the pinned workflow + block metadata for the plan.
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = [var.blocks_table_arn, "${var.blocks_table_arn}/index/*"]
      },
      {
        # Provider API operations are delegated to the source-control service.
        # The durable history therefore contains only project/repository refs.
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = [local.source_control_function_arn]
      }
    ]
  })
}

module "v2_orchestrator_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-v2-orchestrator-${var.environment}"
  handler       = "index.lambdaHandler"
  runtime       = "nodejs24.x"
  # A single run-stage invoke can be long; the durable runtime suspends across
  # waits, but one step (a stage) must fit the function timeout.
  timeout = 900

  # Enable durable execution (checkpoint/replay + zero-compute waits).
  durable_config_execution_timeout = 31622400
  durable_config_retention_period  = 90

  # Durable functions reject invokes against the unqualified ($LATEST) ARN —
  # the caller MUST target a published version or alias. Publish a version on
  # every deploy; the `live` alias below pins the invocable qualified name.
  publish = true

  # Durable functions only support structured (JSON) CloudWatch logs.
  logging_log_format = "JSON"

  source_path = [
    {
      path = "${path.module}/../../../../lambda/v2-orchestrator"
      commands = [
        "cd ../.. && npm run build -w v2-orchestrator",
        ":zip lambda/v2-orchestrator/.build",
      ]
    }
  ]
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.v2_orchestrator.arn

  environment_variables = {
    ENVIRONMENT             = var.environment
    V2_PROCESS_TABLE        = var.v2_executions_table_name
    BLOCKS_TABLE            = var.blocks_table_name
    AGENTCORE_RUNTIME_ARN   = var.agentcore_runtime_arn
    SOURCE_CONTROL_FUNCTION = module.source_control_lambda.lambda_function_name
    # Live realtime fan-out (lambda/shared/ws-fanout.js) — the orchestrator emits
    # execution/workspace lifecycle events on the intent:<id> channel itself, since
    # it is the only component that owns those transitions (the runtime broadcasts
    # stage-level events). Reaches the connections table over the public DDB
    # endpoint (the orchestrator is not VPC-attached).
    CONNECTIONS_TABLE                    = var.connections_table_name
    WEBSOCKET_ENDPOINT                   = var.websocket_api_endpoint_https
    DURABLE_EXECUTION_TIMEOUT_SECONDS    = "31622400"
    DURABLE_GATE_DEADLINE_MARGIN_SECONDS = "300"
  }

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7
}

# `live` alias for the orchestrator — durable functions are invocable only via a
# qualified name (version or alias). lambda/intents targets this alias so the
# version it invokes tracks each deploy without the caller hardcoding a number.
module "v2_orchestrator_alias" {
  source  = "terraform-aws-modules/lambda/aws//modules/alias"
  version = "~> 8.0"

  name             = "live"
  function_name    = module.v2_orchestrator_lambda.lambda_function_name
  function_version = module.v2_orchestrator_lambda.lambda_function_version

  # The function's own resource policy already grants the intents role invoke;
  # no extra alias-scoped triggers needed.
  create_async_event_config = false
}
