# Customer MCP servers behind the AgentCore Gateway: one remote MCP target per
# entry, credentials from AgentCore Identity on the Gateway role only, the
# interceptor's caller envelope as the only forwarded header, and the allow
# rules (never endpoints or credentials) handed to the interceptor. Plus the
# runtime_mcp_credentials = gateway_only profile's runtime wiring. Mock
# providers only.
mock_provider "aws" {
  mock_data "aws_partition" { defaults = { partition = "aws", dns_suffix = "amazonaws.com" } }
  mock_data "aws_region" { defaults = { region = "eu-central-1", name = "eu-central-1" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_availability_zones" {
    defaults = {
      zone_ids = ["euc1-az1", "euc1-az2"]
      names    = ["eu-central-1a", "eu-central-1b"]
    }
  }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/test" } }
  mock_resource "aws_kms_key" { defaults = { arn = "arn:aws:kms:eu-central-1:123456789012:key/grant" } }
  mock_resource "aws_dynamodb_table" { defaults = { arn = "arn:aws:dynamodb:eu-central-1:123456789012:table/test" } }
  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:eu-central-1:123456789012:repository/test"
      repository_url = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/test"
    }
  }
  mock_resource "aws_security_group" { defaults = { id = "sg-0123456789abcdef0" } }
  mock_resource "aws_subnet" { defaults = { id = "subnet-0123456789abcdef0" } }
  mock_resource "aws_bedrockagentcore_gateway" {
    defaults = { gateway_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:gateway/test-mcp-test-abc" }
  }
  mock_data "aws_ecr_image" {
    defaults = { image_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000" }
  }
}
mock_provider "awscc" {}
mock_provider "docker" {}

variables {
  aws_sdk_ua_app_id           = "Collaborative_AI-DLC-test"
  project_name                = "test"
  environment                 = "test"
  powertools_service_name     = "test"
  powertools_log_level        = "INFO"
  aws_region                  = "eu-central-1"
  neptune_endpoint            = "neptune.example"
  neptune_cluster_resource_id = "cluster-ABC"
  artifacts_bucket_name       = "artifacts"
  artifacts_bucket_arn        = "arn:aws:s3:::artifacts"
  blocks_table_name           = "blocks"
  aidlc_repo_ref              = "main"
  bedrock_model               = "model"
  bedrock_region              = "eu-central-1"
  network_mode                = "VPC"
  vpc_id                      = "vpc-1"
  vpc_cidr                    = "10.0.0.0/16"
  private_route_table_ids     = ["rtb-1"]
  kms_key_arn                 = "arn:aws:kms:eu-central-1:123456789012:key/data"
  enable_mcp_gateway          = true

  mcp_gateway_custom_targets = {
    confluence = {
      endpoint = "https://mcp.confluence.example.com/mcp"
      auth = {
        type                    = "oauth"
        credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/confluence"
        secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:bedrock-agentcore-identity!default/oauth2/confluence-AbCdEf"
        scopes                  = ["read:confluence-content.all"]
      }
      private_endpoint = {
        managed_vpc_resource = {
          vpc_identifier           = "vpc-1"
          subnet_ids               = ["subnet-1", "subnet-2"]
          endpoint_ip_address_type = "IPV4"
        }
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
        credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/apikeycredentialprovider/jira"
        secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:bedrock-agentcore-identity!default/apikey/jira-GhIjKl"
        credential_location     = "HEADER"
        parameter_name          = "X-Api-Key"
      }
      allow = {
        project_ids = ["p-1", "p-2"]
      }
    }
  }
}

override_module {
  target  = module.agentcore_docker_build
  outputs = { image_uri = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/agentcore:test" }
}
override_module {
  target  = module.mcp_tools_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:eu-central-1:123456789012:function:test-mcp-tools-test", lambda_function_name = "test-mcp-tools-test" }
}
override_module {
  target  = module.mcp_interceptor_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:eu-central-1:123456789012:function:test-mcp-interceptor-test", lambda_function_name = "test-mcp-interceptor-test" }
}


override_module {
  target  = module.engine_data_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:eu-central-1:123456789012:function:test-engine-data-test", lambda_function_name = "test-engine-data-test" }
}

run "customer_targets_behind_the_gateway" {
  command = apply
  module {
    source = "./modules/compute/agentcore"
  }

  assert {
    condition = (
      toset(keys(aws_bedrockagentcore_gateway_target.custom)) == toset(["confluence", "jira"]) &&
      aws_bedrockagentcore_gateway_target.custom["confluence"].target_configuration[0].mcp[0].mcp_server[0].endpoint == "https://mcp.confluence.example.com/mcp" &&
      aws_bedrockagentcore_gateway_target.custom["confluence"].credential_provider_configuration[0].oauth[0].grant_type == "CLIENT_CREDENTIALS" &&
      length(aws_bedrockagentcore_gateway_target.custom["confluence"].credential_provider_configuration[0].api_key) == 0 &&
      aws_bedrockagentcore_gateway_target.custom["jira"].credential_provider_configuration[0].api_key[0].credential_parameter_name == "X-Api-Key" &&
      length(aws_bedrockagentcore_gateway_target.custom["jira"].credential_provider_configuration[0].oauth) == 0
    )
    error_message = "Each customer target is a remote MCP target with its own AgentCore Identity credential provider."
  }
  assert {
    condition = alltrue([
      for t in values(aws_bedrockagentcore_gateway_target.custom) :
      toset(t.metadata_configuration[0].allowed_request_headers) == toset(["x-aidlc-caller"])
    ])
    error_message = "A customer target may only receive the interceptor's caller envelope."
  }
  assert {
    condition = (
      aws_bedrockagentcore_gateway_target.custom["confluence"].private_endpoint[0].managed_vpc_resource[0].vpc_identifier == "vpc-1" &&
      length(aws_bedrockagentcore_gateway_target.custom["jira"].private_endpoint) == 0
    )
    error_message = "private_endpoint is passed through only where configured."
  }
  assert {
    condition = (
      { for s in jsondecode(aws_iam_role_policy.mcp_gateway_custom_targets[0].policy).Statement : s.Sid => s.Resource if contains(flatten([s.Action]), "bedrock-agentcore:GetResourceOauth2Token") } ==
      {
        CustomTargetOauthTokens = [
          "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/confluence",
          "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default",
          "arn:aws:bedrock-agentcore:eu-central-1:123456789012:workload-identity-directory/default",
          "arn:aws:bedrock-agentcore:eu-central-1:123456789012:workload-identity-directory/default/workload-identity/test-mcp-test-*",
        ]
      } &&
      { for s in jsondecode(aws_iam_role_policy.mcp_gateway_custom_targets[0].policy).Statement : s.Sid => s.Resource if contains(flatten([s.Action]), "bedrock-agentcore:GetResourceApiKey") } ==
      {
        CustomTargetApiKeys = [
          "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/apikeycredentialprovider/jira",
          "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default",
          "arn:aws:bedrock-agentcore:eu-central-1:123456789012:workload-identity-directory/default",
          "arn:aws:bedrock-agentcore:eu-central-1:123456789012:workload-identity-directory/default/workload-identity/test-mcp-test-*",
        ]
      } &&
      toset(flatten([for s in jsondecode(aws_iam_role_policy.mcp_gateway_custom_targets[0].policy).Statement : s.Resource if contains(flatten([s.Action]), "secretsmanager:GetSecretValue")])) == toset([
        "arn:aws:secretsmanager:eu-central-1:123456789012:secret:bedrock-agentcore-identity!default/oauth2/confluence-AbCdEf",
        "arn:aws:secretsmanager:eu-central-1:123456789012:secret:bedrock-agentcore-identity!default/apikey/jira-GhIjKl",
      ]) &&
      toset(flatten([for s in jsondecode(aws_iam_role_policy.mcp_gateway_custom_targets[0].policy).Statement : s.Resource if contains(flatten([s.Action]), "bedrock-agentcore:GetWorkloadAccessToken")])) == toset([
        "arn:aws:bedrock-agentcore:eu-central-1:123456789012:workload-identity-directory/default",
        "arn:aws:bedrock-agentcore:eu-central-1:123456789012:workload-identity-directory/default/workload-identity/test-mcp-test-*",
      ])
    )
    error_message = "The Gateway role may fetch exactly the configured providers' tokens, API keys and secrets, through its own workload identity and the default token vault."
  }
  assert {
    condition = (
      aws_iam_role_policy.mcp_gateway_custom_targets[0].role == aws_iam_role.mcp_gateway[0].id &&
      toset(flatten([for s in jsondecode(aws_iam_role_policy.mcp_gateway_custom_targets[0].policy).Statement : s.Action])) == toset([
        "bedrock-agentcore:GetWorkloadAccessToken",
        "bedrock-agentcore:GetResourceOauth2Token",
        "bedrock-agentcore:GetResourceApiKey",
        "secretsmanager:GetSecretValue",
      ]) &&
      alltrue([for s in jsondecode(aws_iam_role_policy.mcp_gateway_custom_targets[0].policy).Statement : s.Effect == "Allow" && !contains(flatten([s.Resource]), "*")])
    )
    error_message = "Only the Gateway role holds the Identity permissions, with no wildcard resource."
  }
  assert {
    condition = jsondecode(local.mcp_gateway_custom_targets_registry) == {
      confluence = { projectIds = ["p-1"], stageIds = ["requirements-analysis"], tools = ["search"] }
      jira       = { projectIds = ["p-1", "p-2"], stageIds = null, tools = null }
    }
    error_message = "The interceptor registry carries the allow rules and nothing else (no endpoint, no credential)."
  }
  assert {
    condition = (
      output.runtime_environment_variables["AIDLC_MCP_GATEWAY_CUSTOM_TARGETS"] == "true" &&
      !anytrue([for v in values(output.runtime_environment_variables) : strcontains(v, "mcp.confluence.example.com") || strcontains(v, "token-vault") || strcontains(v, "secretsmanager")])
    )
    error_message = "The runtime only learns that customer targets exist, never their endpoints or credential providers."
  }
  assert {
    condition = alltrue([
      for policy in [aws_iam_role_policy.agentcore.policy, aws_iam_role_policy.agentcore_invoke_mcp_gateway[0].policy] : !anytrue([
        for s in jsondecode(policy).Statement : s.Effect == "Allow" && anytrue([
          for a in flatten([s.Action]) : contains(["bedrock-agentcore:GetResourceOauth2Token", "bedrock-agentcore:GetResourceApiKey", "secretsmanager:GetSecretValue"], a)
        ])
      ])
    ])
    error_message = "The runtime role must not be able to fetch a customer target credential."
  }
}

run "no_customer_targets_by_default" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {}
  }

  assert {
    condition = (
      length(aws_bedrockagentcore_gateway_target.custom) == 0 &&
      length(aws_iam_role_policy.mcp_gateway_custom_targets) == 0 &&
      !contains(keys(output.runtime_environment_variables), "AIDLC_MCP_GATEWAY_CUSTOM_TARGETS")
    )
    error_message = "Without customer targets nothing changes."
  }
}

run "customer_targets_require_the_gateway" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_mcp_gateway = false
  }
  expect_failures = [terraform_data.mcp_gateway_custom_targets_preconditions]
}

run "registry_must_fit_the_interceptor_environment" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      big = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "api_key"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/apikeycredentialprovider/big"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:big"
        }
        allow = { project_ids = [for i in range(120) : format("project-%020d", i)] }
      }
    }
  }
  expect_failures = [terraform_data.mcp_gateway_custom_targets_preconditions]
}

# The interceptor limits the registry in UTF-8 bytes: 700 CJK characters are
# 755 characters but 2155 bytes once encoded.
run "registry_limit_counts_utf8_bytes" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      t = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "api_key"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/apikeycredentialprovider/t"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:t"
        }
        allow = { project_ids = ["p"], tools = [join("", [for i in range(700) : "工"])] }
      }
    }
  }
  expect_failures = [terraform_data.mcp_gateway_custom_targets_preconditions]
}

# Exactly 2048 bytes: {"t":{"projectIds":["p"],"stageIds":null,"tools":["a工…"]}}
# with 664 three-byte characters.
run "registry_at_the_byte_limit_is_accepted" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      t = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "api_key"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/apikeycredentialprovider/t"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:t"
        }
        allow = { project_ids = ["p"], tools = [join("", ["a", join("", [for i in range(664) : "工"])])] }
      }
    }
  }

  assert {
    condition = (
      local.mcp_gateway_custom_targets_registry_bytes == 2048 &&
      length(local.mcp_gateway_custom_targets_registry) == 720 &&
      length(terraform_data.mcp_gateway_custom_targets_preconditions) == 1
    )
    error_message = "A registry of exactly 2048 UTF-8 bytes fits the interceptor's limit."
  }
}

run "rejects_reserved_name" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "aidlc" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
        }
        allow = { project_ids = ["p-1"], tools = null }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

run "rejects_separator_in_name" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "a___b" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
        }
        allow = { project_ids = ["p-1"], tools = null }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

run "rejects_plain_http_endpoint" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "wiki" = {
        endpoint = "http://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
        }
        allow = { project_ids = ["p-1"], tools = null }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

run "rejects_provider_type_mismatch" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "wiki" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/apikeycredentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
        }
        allow = { project_ids = ["p-1"], tools = null }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

run "rejects_no_space_allowed" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "wiki" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
        }
        allow = { project_ids = [], tools = null }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

run "rejects_qualified_tool_name" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "wiki" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
        }
        allow = { project_ids = ["p-1"], tools = ["wiki___search"] }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

# Auth0 needs `audience`, Entra ID v1 and AD FS `resource` on the token request.
run "oauth_custom_parameters_reach_the_target" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "wiki" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
          scopes                  = ["kb.read"]
          custom_parameters       = { audience = "https://api.example.com" }
        }
        allow = { project_ids = ["p-1"] }
      }
    }
  }

  assert {
    condition = (
      aws_bedrockagentcore_gateway_target.custom["wiki"].credential_provider_configuration[0].oauth[0].custom_parameters == tomap({ audience = "https://api.example.com" }) &&
      jsondecode(local.mcp_gateway_custom_targets_registry) == { wiki = { projectIds = ["p-1"], stageIds = null, tools = null } }
    )
    error_message = "OAuth custom parameters are passed to the target's credential provider configuration and never to the interceptor."
  }
}

run "rejects_custom_parameters_on_api_key" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "wiki" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "api_key"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/apikeycredentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
          custom_parameters       = { audience = "https://api.example.com" }
        }
        allow = { project_ids = ["p-1"] }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

run "rejects_more_than_ten_custom_parameters" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "wiki" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
          custom_parameters       = { for i in range(11) : "p${i}" => "v" }
        }
        allow = { project_ids = ["p-1"] }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

run "rejects_a_scope_over_64_characters" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "wiki" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
          scopes                  = [join("", [for i in range(65) : "s"])]
        }
        allow = { project_ids = ["p-1"] }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

run "rejects_more_than_100_scopes" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "wiki" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
          scopes                  = [for i in range(101) : "scope-${i}"]
        }
        allow = { project_ids = ["p-1"] }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

# IAM only matches the bedrock-agentcore form, so an acps ARN would yield a
# Gateway role grant that never applies.
run "rejects_an_acps_provider_arn" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    mcp_gateway_custom_targets = {
      "wiki" = {
        endpoint = "https://mcp.example.com/mcp"
        auth = {
          type                    = "oauth"
          credential_provider_arn = "arn:aws:acps:eu-central-1:123456789012:token-vault/default/oauth2credentialprovider/x"
          secret_arn              = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:x"
          scopes                  = ["kb.read"]
        }
        allow = { project_ids = ["p-1"] }
      }
    }
  }
  expect_failures = [var.mcp_gateway_custom_targets]
}

run "gateway_only_keeps_custom_mcp_credentials_out_of_the_runtime" {
  command = apply
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_engine_data      = true
    runtime_mcp_credentials = "gateway_only"
  }

  assert {
    condition     = output.runtime_environment_variables["RUNTIME_MCP_CREDENTIALS"] == "gateway_only"
    error_message = "The runtime (and managed environments, which share its environment) must know the strict profile."
  }
  assert {
    condition = !anytrue([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement :
      s.Effect == "Allow" && anytrue([for r in flatten([s.Resource]) : strcontains(r, "mcp-secrets")])
    ])
    error_message = "The runtime role must not read MCP secrets in the strict profile."
  }
  assert {
    condition = (
      aws_iam_role_policy.agentcore_deny_custom_mcp_credentials[0].role == aws_iam_role.agentcore.id &&
      alltrue([for s in jsondecode(aws_iam_role_policy.agentcore_deny_custom_mcp_credentials[0].policy).Statement : s.Effect == "Deny"]) &&
      toset(flatten([for s in jsondecode(aws_iam_role_policy.agentcore_deny_custom_mcp_credentials[0].policy).Statement : s.Action])) == toset([
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "bedrock-agentcore:GetResourceOauth2Token",
        "bedrock-agentcore:GetResourceApiKey",
        "secretsmanager:GetSecretValue",
      ]) &&
      toset(flatten([for s in jsondecode(aws_iam_role_policy.agentcore_deny_custom_mcp_credentials[0].policy).Statement : s.Resource if s.Sid == "DenyCustomTargetProviderSecrets"])) == toset([
        "arn:aws:secretsmanager:eu-central-1:123456789012:secret:bedrock-agentcore-identity!default/oauth2/confluence-AbCdEf",
        "arn:aws:secretsmanager:eu-central-1:123456789012:secret:bedrock-agentcore-identity!default/apikey/jira-GhIjKl",
      ])
    )
    error_message = "An explicit Deny keeps MCP secrets, Identity credentials and the providers' secrets away from the runtime role."
  }
}

run "allow_keeps_todays_runtime_mcp_secret_access" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }

  assert {
    condition = (
      anytrue([
        for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement :
        s.Effect == "Allow" && anytrue([for r in flatten([s.Resource]) : strcontains(r, "/mcp-secrets/*")])
      ]) &&
      length(aws_iam_role_policy.agentcore_deny_custom_mcp_credentials) == 0 &&
      !contains(keys(output.runtime_environment_variables), "RUNTIME_MCP_CREDENTIALS")
    )
    error_message = "The default profile keeps the runtime's MCP secret read and sets no strict environment."
  }
}

run "gateway_only_requires_engine_data" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    runtime_mcp_credentials = "gateway_only"
  }
  expect_failures = [terraform_data.runtime_mcp_credentials_preconditions]
}

run "rejects_an_unknown_runtime_mcp_profile" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    runtime_mcp_credentials = "deny"
  }
  expect_failures = [var.runtime_mcp_credentials]
}
