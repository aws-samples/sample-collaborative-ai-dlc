# The runtime role across the engine-data rollout: unchanged until runtime
# grants are enforced, then reduced to the remote paths only.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"], zone_ids = ["use1-az1", "use1-az2"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_ecr_repository" {
    override_during = plan
    defaults        = { arn = "arn:aws:ecr:us-east-1:123456789012:repository/test" }
  }
  mock_resource "aws_dynamodb_table" {
    override_during = plan
    defaults        = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/test-v2-executions" }
  }
  mock_resource "aws_ssm_parameter" {
    override_during = plan
    defaults        = { arn = "arn:aws:ssm:us-east-1:123456789012:parameter/test/test/models" }
  }
}

mock_provider "awscc" {}

override_module {
  target  = module.agentcore_docker_build
  outputs = { image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/test:tag" }
}
override_module {
  target  = module.engine_data_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-engine-data-test", lambda_function_name = "test-engine-data-test" }
}
override_module {
  target  = module.mcp_tools_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-mcp-tools-test", lambda_function_name = "test-mcp-tools-test" }
}

variables {
  aws_sdk_ua_app_id           = "Collaborative_AI-DLC-test"
  project_name                = "test"
  environment                 = "test"
  powertools_service_name     = "test"
  powertools_log_level        = "INFO"
  aws_region                  = "us-east-1"
  neptune_endpoint            = "neptune.example"
  neptune_cluster_resource_id = "cluster-TEST"
  artifacts_bucket_name       = "test-artifacts"
  artifacts_bucket_arn        = "arn:aws:s3:::test-artifacts"
  blocks_table_name           = "test-blocks"
  blocks_table_arn            = "arn:aws:dynamodb:us-east-1:123456789012:table/test-blocks"
  connections_table_name      = "test-connections"
  connections_table_arn       = "arn:aws:dynamodb:us-east-1:123456789012:table/test-connections"
  websocket_endpoint          = "https://ws.example"
  websocket_execution_arn     = "arn:aws:execute-api:us-east-1:123456789012:ws1/test"
  aidlc_repo_ref              = "main"
  bedrock_model               = "test-model"
  bedrock_region              = "us-east-1"
  kms_key_arn                 = "arn:aws:kms:us-east-1:123456789012:key/test"
  network_mode                = "VPC"
  vpc_id                      = "vpc-1"
  vpc_cidr                    = "10.0.0.0/16"
  private_route_table_ids     = ["rtb-1"]
}

run "flag_off_keeps_direct_access" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_mcp_gateway     = false
    enable_engine_data     = false
    enforce_runtime_grants = false
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s if contains(s.Action, "dynamodb:ConditionCheckItem")]) == 1
    error_message = "Direct-path runtimes need ConditionCheckItem for workflow checkpoints."
  }
  assert {
    condition = alltrue([for prefix in ["neptune-db:", "dynamodb:", "s3:", "ssm:", "execute-api:"] : anytrue([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : anytrue([for a in s.Action : startswith(a, prefix)])
    ])])
    error_message = "The flag-off runtime role must keep its direct data access."
  }
  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s.Resource if contains(s.Action, "lambda:InvokeFunction")]), "arn:aws:lambda:us-east-1:123456789012:function:test-source-control-test")
    error_message = "The flag-off runtime role must keep the unqualified source-control function."
  }
  assert {
    condition     = contains(keys(output.runtime_environment_variables), "NEPTUNE_ENDPOINT")
    error_message = "The flag-off runtime keeps its direct-client configuration."
  }
}

run "transition_keeps_direct_access" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_mcp_gateway     = true
    enable_engine_data     = true
    enforce_runtime_grants = false
  }

  assert {
    condition = alltrue([for prefix in ["neptune-db:", "dynamodb:", "s3:", "ssm:", "execute-api:"] : anytrue([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : anytrue([for a in s.Action : startswith(a, prefix)])
    ])])
    error_message = "Legacy runtimes still need their direct data access while the broker serves them."
  }
  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s.Resource if contains(s.Action, "lambda:InvokeFunction")]), "arn:aws:lambda:us-east-1:123456789012:function:test-source-control-test")
    error_message = "Legacy runtimes still call the unqualified source-control function."
  }
  assert {
    condition     = contains(keys(output.runtime_environment_variables), "ARTIFACTS_BUCKET")
    error_message = "The transition runtime keeps its direct-client configuration."
  }
  assert {
    condition     = !contains(keys(output.runtime_environment_variables), "RUNTIME_DATA_ACCESS")
    error_message = "The transition runtime still reads the sandbox settings for payloads that carry none."
  }
}

run "enforced_grants_strip_direct_access" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_mcp_gateway     = true
    enable_engine_data     = true
    enforce_runtime_grants = true
  }

  assert {
    condition = !anytrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : [
        for a in s.Action : anytrue([for prefix in ["neptune-db:", "dynamodb:", "s3:", "ssm:", "execute-api:"] : startswith(a, prefix)])
      ]
    ]))
    error_message = "The enforced runtime role must hold no Neptune, DynamoDB, S3, SSM or websocket access."
  }
  assert {
    condition = sort(distinct(flatten([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : [for a in s.Action : "${s.Effect} ${a}"]
      ]))) == tolist([
      "Allow ecr:BatchCheckLayerAvailability",
      "Allow ecr:BatchGetImage",
      "Allow ecr:GetAuthorizationToken",
      "Allow ecr:GetDownloadUrlForLayer",
      "Allow lambda:InvokeFunction",
      "Allow lambda:SendDurableExecutionCallbackFailure",
      "Allow lambda:SendDurableExecutionCallbackHeartbeat",
      "Allow lambda:SendDurableExecutionCallbackSuccess",
      "Allow logs:CreateLogGroup",
      "Allow logs:CreateLogStream",
      "Allow logs:PutLogEvents",
      "Deny sts:AssumeRole",
    ])
    error_message = "The enforced runtime role keeps only image pull, logs, durable callbacks, the broker and the AssumeRole deny."
  }
  assert {
    condition     = flatten([for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s.Resource if contains(s.Action, "lambda:InvokeFunction")]) == ["arn:aws:lambda:us-east-1:123456789012:function:test-credential-broker-test"]
    error_message = "The enforced runtime role invokes only the broker from its base policy."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.agentcore_invoke_engine_data[0].policy).Statement[0].Resource == [
      "arn:aws:lambda:us-east-1:123456789012:function:test-engine-data-test",
      "arn:aws:lambda:us-east-1:123456789012:function:test-source-control-test:runtime",
    ]
    error_message = "engine-data and the source-control runtime alias stay invocable."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s
      if s.Effect == "Deny" && contains(s.Action, "sts:AssumeRole")
    ]) == 1
    error_message = "The runtime role keeps its Deny on sts:AssumeRole."
  }
  assert {
    condition = length(setintersection(keys(output.runtime_environment_variables), [
      "BLOCKS_TABLE", "ARTIFACTS_BUCKET", "NEPTUNE_ENDPOINT", "CONNECTIONS_TABLE", "WEBSOCKET_ENDPOINT", "MCP_SECRETS_SSM_PREFIX",
    ])) == 0
    error_message = "The enforced runtime gets no direct-client configuration."
  }
  assert {
    condition = alltrue([
      for env in [output.runtime_environment_variables, awscc_bedrockagentcore_runtime.stage_executor.environment_variables] :
      lookup(env, "RUNTIME_DATA_ACCESS", null) == "engine_data_only"
    ])
    error_message = "The enforced runtime must know its role cannot read the sandbox settings."
  }
  assert {
    condition     = output.runtime_environment_variables.SOURCE_CONTROL_FUNCTION == "arn:aws:lambda:us-east-1:123456789012:function:test-source-control-test:runtime"
    error_message = "The enforced runtime calls source-control through its runtime alias."
  }
}

# The strictest profile, with one OAuth and one API-key customer target. Every
# inline policy on the runtime role is compared whole, so a widened resource,
# an extra action, a Condition or a lost Deny fails.
run "enforced_gateway_only_has_exact_runtime_policy" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_mcp_gateway      = true
    enable_engine_data      = true
    enforce_runtime_grants  = true
    runtime_mcp_credentials = "gateway_only"

    mcp_gateway_custom_targets = {
      confluence = {
        endpoint = "https://mcp.confluence.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/oauth2credentialprovider/confluence"
          secret_arn              = "arn:aws:secretsmanager:us-east-1:123456789012:secret:bedrock-agentcore-identity!default/oauth2/confluence-AbCdEf"
          scopes                  = ["read:confluence-content.all"]
        }
        allow = {
          project_ids = ["p-1"]
          stage_ids   = ["requirements-analysis"]
          tools       = ["search"]
        }
      }
      jira = {
        endpoint = "https://mcp.jira.example.com/mcp"
        auth = {
          type                    = "api_key"
          credential_provider_arn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/jira"
          secret_arn              = "arn:aws:secretsmanager:us-east-1:123456789012:secret:bedrock-agentcore-identity!default/apikey/jira-GhIjKl"
          credential_location     = "HEADER"
          parameter_name          = "X-Api-Key"
        }
        allow = {
          project_ids = ["p-1", "p-2"]
        }
      }
    }
  }

  # Plan-time values for the role and every resource its policies name, distinct
  # so that a swapped reference fails, plus the Gateway and its grant key.
  override_resource {
    target          = aws_iam_role.agentcore
    override_during = plan
    values          = { id = "test-agentcore-test", arn = "arn:aws:iam::123456789012:role/test-agentcore-test" }
  }
  override_resource {
    target          = aws_ecr_repository.agentcore
    override_during = plan
    values          = { arn = "arn:aws:ecr:us-east-1:123456789012:repository/test-agentcore-test" }
  }
  override_resource {
    target          = aws_ecr_repository.managed_environments
    override_during = plan
    values          = { arn = "arn:aws:ecr:us-east-1:123456789012:repository/test-managed-environments-test" }
  }
  override_resource {
    target          = aws_dynamodb_table.gateway_grant_retirements
    override_during = plan
    values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/test-gateway-grant-retirements-test" }
  }
  override_resource {
    target          = aws_bedrockagentcore_gateway.mcp
    override_during = plan
    values = {
      gateway_arn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/test-mcp-test-a1b2c3d4e5"
      gateway_id  = "test-mcp-test-a1b2c3d4e5"
      gateway_url = "https://test-mcp-test-a1b2c3d4e5.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp"
    }
  }
  override_resource {
    target          = aws_kms_key.gateway_grant
    override_during = plan
    values          = { arn = "arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab", key_id = "1234abcd-12ab-34cd-56ef-1234567890ab" }
  }
  override_module {
    target  = module.mcp_interceptor_lambda
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-mcp-interceptor-test", lambda_function_name = "test-mcp-interceptor-test" }
  }

  assert {
    condition = jsondecode(aws_iam_role_policy.agentcore.policy) == {
      Version = "2012-10-17"
      Statement = [
        {
          Effect = "Allow"
          Action = ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability"]
          Resource = [
            "arn:aws:ecr:us-east-1:123456789012:repository/test-agentcore-test",
            "arn:aws:ecr:us-east-1:123456789012:repository/test-managed-environments-test",
          ]
        },
        {
          Effect   = "Allow"
          Action   = ["ecr:GetAuthorizationToken"]
          Resource = "*"
        },
        {
          Effect   = "Allow"
          Action   = ["lambda:InvokeFunction"]
          Resource = ["arn:aws:lambda:us-east-1:123456789012:function:test-credential-broker-test"]
        },
        {
          Effect   = "Deny"
          Action   = ["sts:AssumeRole"]
          Resource = "*"
        },
        {
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"]
          Resource = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/bedrock-agentcore/*"
        },
        {
          Effect = "Allow"
          Action = [
            "lambda:SendDurableExecutionCallbackSuccess",
            "lambda:SendDurableExecutionCallbackFailure",
            "lambda:SendDurableExecutionCallbackHeartbeat",
          ]
          Resource = [
            "arn:aws:lambda:us-east-1:123456789012:function:test-v2-orchestrator-test",
            "arn:aws:lambda:us-east-1:123456789012:function:test-v2-orchestrator-test:*",
          ]
        },
      ]
    }
    error_message = "The base runtime policy is image pull, logs, the broker, durable callbacks and the AssumeRole Deny, nothing else."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.agentcore_invoke_engine_data[0].policy) == {
      Version = "2012-10-17"
      Statement = [{
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        Resource = [
          "arn:aws:lambda:us-east-1:123456789012:function:test-engine-data-test",
          "arn:aws:lambda:us-east-1:123456789012:function:test-source-control-test:runtime",
        ]
      }]
    }
    error_message = "The runtime invokes exactly engine-data and the source-control runtime alias."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.agentcore_invoke_mcp_gateway[0].policy) == {
      Version = "2012-10-17"
      Statement = [{
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeGateway"]
        Resource = "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/test-mcp-test-a1b2c3d4e5"
      }]
    }
    error_message = "The runtime may only call InvokeGateway on its own Gateway."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.agentcore_deny_custom_mcp_credentials[0].policy) == {
      Version = "2012-10-17"
      Statement = [
        {
          Sid    = "DenyMcpSecrets"
          Effect = "Deny"
          Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
          Resource = [
            "arn:aws:ssm:us-east-1:123456789012:parameter/test/test/mcp-secrets/*",
            "arn:aws:ssm:us-east-1:123456789012:parameter/test/test/projects/*/mcp-secrets/*",
          ]
        },
        {
          Sid      = "DenyIdentityCredentials"
          Effect   = "Deny"
          Action   = ["bedrock-agentcore:GetResourceOauth2Token", "bedrock-agentcore:GetResourceApiKey"]
          Resource = "*"
        },
        {
          Sid    = "DenyCustomTargetProviderSecrets"
          Effect = "Deny"
          Action = ["secretsmanager:GetSecretValue"]
          Resource = [
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:bedrock-agentcore-identity!default/apikey/jira-GhIjKl",
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:bedrock-agentcore-identity!default/oauth2/confluence-AbCdEf",
          ]
        },
      ]
    }
    error_message = "The runtime is denied the MCP secrets, every Identity credential and both providers' secrets."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.agentcore_deny_gateway_grant_retirements[0].policy) == {
      Version = "2012-10-17"
      Statement = [{
        Sid    = "DenyGatewayGrantRetirements"
        Effect = "Deny"
        Action = ["dynamodb:*"]
        Resource = [
          "arn:aws:dynamodb:us-east-1:123456789012:table/test-gateway-grant-retirements-test",
          "arn:aws:dynamodb:us-east-1:123456789012:table/test-gateway-grant-retirements-test/*",
        ]
      }]
    }
    error_message = "The runtime is denied every action on the retirement table and its indexes."
  }
  assert {
    condition = alltrue([
      for role in [
        aws_iam_role_policy.agentcore.role,
        aws_iam_role_policy.agentcore_invoke_engine_data[0].role,
        aws_iam_role_policy.agentcore_invoke_mcp_gateway[0].role,
        aws_iam_role_policy.agentcore_deny_custom_mcp_credentials[0].role,
        aws_iam_role_policy.agentcore_deny_gateway_grant_retirements[0].role,
      ] : role == aws_iam_role.agentcore.id
    ])
    error_message = "All five policies are attached to the runtime role."
  }
  assert {
    condition = !anytrue(flatten([
      for policy in [
        aws_iam_role_policy.agentcore.policy,
        aws_iam_role_policy.agentcore_invoke_engine_data[0].policy,
        aws_iam_role_policy.agentcore_invoke_mcp_gateway[0].policy,
        aws_iam_role_policy.agentcore_deny_custom_mcp_credentials[0].policy,
        aws_iam_role_policy.agentcore_deny_gateway_grant_retirements[0].policy,
        ] : [
        for s in jsondecode(policy).Statement : s.Effect == "Allow" && anytrue([
          for a in flatten([s.Action]) : a == "*" || a == "lambda:InvokeFunction" || (startswith(a, "lambda:") && strcontains(a, "*"))
          ]) && anytrue([
          for r in flatten([s.Resource]) : strcontains(r, "*") || anytrue([
            for fn in [
              "arn:aws:lambda:us-east-1:123456789012:function:test-mcp-tools-test",
              "arn:aws:lambda:us-east-1:123456789012:function:test-mcp-interceptor-test",
            ] : r == fn || startswith(r, "${fn}:")
          ])
        ])
      ]
    ]))
    error_message = "No runtime policy may invoke the tools or interceptor Lambdas, qualified or not."
  }
  assert {
    # module.dynamodb_kms_runtime_access exposes nothing to assert on, so check
    # the gate that keeps the runtime role out of its role_names.
    condition     = local.runtime_direct_data_access == false
    error_message = "The runtime role must get no direct-data access, including the DynamoDB key grant."
  }
  assert {
    condition = alltrue([
      for env in [output.runtime_environment_variables, awscc_bedrockagentcore_runtime.stage_executor.environment_variables] :
      lookup(env, "RUNTIME_MCP_CREDENTIALS", null) == "gateway_only" && length(setintersection(keys(env), [
        "BLOCKS_TABLE", "ARTIFACTS_BUCKET", "NEPTUNE_ENDPOINT", "CONNECTIONS_TABLE", "WEBSOCKET_ENDPOINT", "MCP_SECRETS_SSM_PREFIX",
      ])) == 0
    ])
    error_message = "The strict runtime knows its profile and gets no direct-client configuration."
  }
}
