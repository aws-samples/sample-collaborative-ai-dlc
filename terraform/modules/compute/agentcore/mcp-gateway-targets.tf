# ---------------------------------------------------------------------------
# Customer MCP servers behind the Gateway (mcp_gateway_custom_targets)
#
# runtime CLI -> aidlc-gateway-tools proxy (SigV4, grant) -> Gateway (AWS_IAM)
#   -> mcp-interceptor (grant, session, live scope; per-target allow rule)
#   -> customer MCP server, called with the credential the Gateway fetches
#      from AgentCore Identity (OAuth client credentials or API key)
#
# The credential providers are created out of band and referenced by ARN, so
# no customer secret is in Terraform state, in the runtime or in the Lambdas.
# The interceptor receives the allow rules only (names, spaces, stages, tools).
# Each target only accepts the x-aidlc-caller header the interceptor derives
# from the signed grant (lambda/shared/mcp/gateway-custom-targets.js).
# ---------------------------------------------------------------------------

locals {
  mcp_gateway_custom_targets = local.mcp_gateway_enabled ? var.mcp_gateway_custom_targets : {}
  # The registry the interceptor enforces: no endpoint, no credential.
  mcp_gateway_custom_targets_registry = jsonencode({
    for name, target in var.mcp_gateway_custom_targets : name => {
      projectIds = target.allow.project_ids
      stageIds   = target.allow.stage_ids
      tools      = target.allow.tools
    }
  })
  # Shares the interceptor's 4 KB Lambda environment budget
  # (MAX_CUSTOM_TARGETS_BYTES in gateway-custom-targets.js, a UTF-8 byte count).
  # length() counts characters, so the bytes come from the Base64 encoding of
  # the UTF-8 string: 3 bytes per 4 characters, less one per padding "=".
  mcp_gateway_custom_targets_registry_max_bytes = 2048
  mcp_gateway_custom_targets_registry_base64    = base64encode(local.mcp_gateway_custom_targets_registry)
  mcp_gateway_custom_targets_registry_bytes = (
    length(local.mcp_gateway_custom_targets_registry_base64) / 4 * 3 -
    length(regex("=*$", local.mcp_gateway_custom_targets_registry_base64))
  )
  mcp_gateway_customer_caller_header = "x-aidlc-caller"
  # The Gateway's workload identity (the service names it <gateway name>-<suffix>)
  # and the account's default token vault. GetResourceOauth2Token and
  # GetResourceApiKey are authorized against both as well as the provider.
  mcp_gateway_identity_arn_prefix = "arn:${local.partition}:bedrock-agentcore:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}"
  mcp_gateway_workload_identity_arns = local.mcp_gateway_enabled ? [
    "${local.mcp_gateway_identity_arn_prefix}:workload-identity-directory/default",
    "${local.mcp_gateway_identity_arn_prefix}:workload-identity-directory/default/workload-identity/${aws_bedrockagentcore_gateway.mcp[0].name}-*",
  ] : []
  mcp_gateway_token_vault_arn = "${local.mcp_gateway_identity_arn_prefix}:token-vault/default"
}

resource "terraform_data" "mcp_gateway_custom_targets_preconditions" {
  count = length(var.mcp_gateway_custom_targets) > 0 ? 1 : 0

  lifecycle {
    precondition {
      condition     = local.mcp_gateway_enabled
      error_message = "mcp_gateway_custom_targets requires enable_mcp_gateway: the interceptor is what authorizes calls to them."
    }
    precondition {
      condition     = local.mcp_gateway_custom_targets_registry_bytes <= local.mcp_gateway_custom_targets_registry_max_bytes
      error_message = "mcp_gateway_custom_targets allow rules exceed 2048 bytes once encoded for the interceptor; shorten or merge them."
    }
  }
}

# The Gateway role fetches each target's credential from AgentCore Identity,
# and nothing else: its workload access token, then exactly the configured
# providers and their secrets. The credential actions are also authorized
# against the token vault and the Gateway's workload identity, so those are
# granted with each provider. Actions and resources per
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-outbound-auth.html
# (sections "Set up outbound authorization with an OAuth client" and "... with
# an API key"). A provider secret encrypted with a customer managed key also
# needs kms:Decrypt for this role (not granted here).
resource "aws_iam_role_policy" "mcp_gateway_custom_targets" {
  count = length(local.mcp_gateway_custom_targets) > 0 ? 1 : 0

  name = "custom-mcp-target-credentials"
  role = aws_iam_role.mcp_gateway[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "GatewayWorkloadAccessToken"
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:GetWorkloadAccessToken"]
        Resource = local.mcp_gateway_workload_identity_arns
      },
      {
        Sid      = "CustomTargetProviderSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = sort(distinct([for t in values(local.mcp_gateway_custom_targets) : t.auth.secret_arn]))
      },
      ], anytrue([for t in values(local.mcp_gateway_custom_targets) : t.auth.type == "oauth"]) ? [{
        Sid    = "CustomTargetOauthTokens"
        Effect = "Allow"
        Action = ["bedrock-agentcore:GetResourceOauth2Token"]
        Resource = concat(
          sort(distinct([for t in values(local.mcp_gateway_custom_targets) : t.auth.credential_provider_arn if t.auth.type == "oauth"])),
          [local.mcp_gateway_token_vault_arn],
          local.mcp_gateway_workload_identity_arns,
        )
      }] : [],
      anytrue([for t in values(local.mcp_gateway_custom_targets) : t.auth.type == "api_key"]) ? [{
        Sid    = "CustomTargetApiKeys"
        Effect = "Allow"
        Action = ["bedrock-agentcore:GetResourceApiKey"]
        Resource = concat(
          sort(distinct([for t in values(local.mcp_gateway_custom_targets) : t.auth.credential_provider_arn if t.auth.type == "api_key"])),
          [local.mcp_gateway_token_vault_arn],
          local.mcp_gateway_workload_identity_arns,
        )
    }] : [])
  })
}

resource "aws_bedrockagentcore_gateway_target" "custom" {
  for_each = local.mcp_gateway_custom_targets

  gateway_identifier = aws_bedrockagentcore_gateway.mcp[0].gateway_id
  name               = each.key
  description        = each.value.description == null ? "Customer MCP server ${each.key}" : each.value.description

  target_configuration {
    mcp {
      mcp_server {
        endpoint = each.value.endpoint
      }
    }
  }

  credential_provider_configuration {
    dynamic "oauth" {
      for_each = each.value.auth.type == "oauth" ? [each.value.auth] : []
      content {
        provider_arn      = oauth.value.credential_provider_arn
        scopes            = oauth.value.scopes
        custom_parameters = oauth.value.custom_parameters
        grant_type        = "CLIENT_CREDENTIALS"
      }
    }
    dynamic "api_key" {
      for_each = each.value.auth.type == "api_key" ? [each.value.auth] : []
      content {
        provider_arn              = api_key.value.credential_provider_arn
        credential_location       = api_key.value.credential_location
        credential_parameter_name = api_key.value.parameter_name
        credential_prefix         = api_key.value.prefix
      }
    }
  }

  # Only the interceptor's caller envelope; the interceptor never sets
  # Authorization, which would replace the credential provider's.
  metadata_configuration {
    allowed_request_headers = [local.mcp_gateway_customer_caller_header]
  }

  dynamic "private_endpoint" {
    for_each = each.value.private_endpoint == null ? [] : [each.value.private_endpoint]
    content {
      dynamic "managed_vpc_resource" {
        for_each = private_endpoint.value.managed_vpc_resource == null ? [] : [private_endpoint.value.managed_vpc_resource]
        content {
          vpc_identifier           = managed_vpc_resource.value.vpc_identifier
          subnet_ids               = managed_vpc_resource.value.subnet_ids
          endpoint_ip_address_type = managed_vpc_resource.value.endpoint_ip_address_type
          security_group_ids       = managed_vpc_resource.value.security_group_ids
          routing_domain           = managed_vpc_resource.value.routing_domain
        }
      }
      dynamic "self_managed_lattice_resource" {
        for_each = private_endpoint.value.self_managed_lattice_resource == null ? [] : [private_endpoint.value.self_managed_lattice_resource]
        content {
          resource_configuration_identifier = self_managed_lattice_resource.value.resource_configuration_identifier
        }
      }
    }
  }

  depends_on = [
    terraform_data.mcp_gateway_custom_targets_preconditions,
    aws_iam_role_policy.mcp_gateway_custom_targets,
  ]
}

# ---------------------------------------------------------------------------
# runtime_mcp_credentials = gateway_only: the runtime role (shared with managed
# environment runtimes) loses its MCP secret read above, and an explicit Deny
# keeps every custom MCP credential out of reach whatever is granted later:
# the space and platform MCP secrets, AgentCore Identity tokens and API keys,
# and the configured providers' secrets.
# ---------------------------------------------------------------------------

resource "terraform_data" "runtime_mcp_credentials_preconditions" {
  count = var.runtime_mcp_credentials == "gateway_only" ? 1 : 0

  lifecycle {
    precondition {
      condition     = local.mcp_gateway_enabled && local.engine_data_enabled
      error_message = "runtime_mcp_credentials = \"gateway_only\" requires enable_mcp_gateway and enable_engine_data."
    }
  }
}

resource "aws_iam_role_policy" "agentcore_deny_custom_mcp_credentials" {
  count = var.runtime_mcp_credentials == "gateway_only" ? 1 : 0

  name = "deny-custom-mcp-credentials"
  role = aws_iam_role.agentcore.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid    = "DenyMcpSecrets"
        Effect = "Deny"
        Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = [
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/mcp-secrets/*",
          "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/projects/*/mcp-secrets/*",
        ]
      },
      {
        Sid      = "DenyIdentityCredentials"
        Effect   = "Deny"
        Action   = ["bedrock-agentcore:GetResourceOauth2Token", "bedrock-agentcore:GetResourceApiKey"]
        Resource = "*"
      },
      ], length(local.mcp_gateway_custom_targets) > 0 ? [{
        Sid      = "DenyCustomTargetProviderSecrets"
        Effect   = "Deny"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = sort(distinct([for t in values(local.mcp_gateway_custom_targets) : t.auth.secret_arn]))
    }] : [])
  })

  depends_on = [terraform_data.runtime_mcp_credentials_preconditions]
}
