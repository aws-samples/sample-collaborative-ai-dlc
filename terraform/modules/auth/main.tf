data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  # Provisioning a custom domain must not cut over existing SSO redirects before
  # its DNS and upstream IdP callbacks are ready.
  hosted_ui_origin = (
    var.custom_domain != "" && var.custom_domain_active ? "https://${aws_cognito_user_pool_domain.custom[0].domain}" :
    "https://${aws_cognito_user_pool_domain.main.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
  )

  sso_enabled        = var.auth_mode != "local"
  local_enabled      = var.auth_mode != "sso-only"
  all_lambdas_in_vpc = var.lambda_vpc_scope == "all"
  sso_provider_names = nonsensitive(toset(keys(var.sso_providers)))
  oidc_provider_names = nonsensitive(toset([
    for name, provider in var.sso_providers : name
    if lower(provider.type) == "oidc"
  ]))
  role_config = {
    providers = {
      for name, provider in var.sso_providers : name => {
        roleMappings = {
          for role, values in provider.role_mappings : role => values
          if contains(jsondecode(file("${path.module}/../../../config/platform-roles.json")), role)
        }
        requiredClaimValues = provider.required_claim_values
      }
    }
  }
  app_client_write_attributes = distinct(concat(
    ["custom:avatar_url", "custom:display_name"],
    local.sso_enabled ? ["email"] : [],
    anytrue([for provider in values(var.sso_providers) : provider.name_claim != ""]) ? ["name"] : [],
    anytrue([for provider in values(var.sso_providers) : provider.role_claim != ""]) ? ["custom:sso_roles"] : [],
  ))
  shared_dir = "${path.module}/../../../lambda/shared"
  sso_sources_hash = sha256(join("", concat(
    [
      for file in sort(fileset(local.shared_dir, "**/*.{js,mjs,cjs,json}")) :
      filesha256("${local.shared_dir}/${file}")
    ],
    [filesha256("${path.module}/../../../config/platform-roles.json")]
  )))

  # Without an explicit value, refresh tokens keep their historical lifetimes:
  # one day with enterprise SSO, seven days in local mode.
  refresh_token_validity_hours = coalesce(var.refresh_token_validity_hours, local.sso_enabled ? 24 : 168)
}

data "aws_secretsmanager_secret_version" "oidc_client_secret" {
  for_each  = local.oidc_provider_names
  secret_id = var.sso_providers[each.key].client_secret_arn
}

module "sso_token_lambda" {
  count   = local.sso_enabled ? 1 : 0
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  role_path                 = var.iam_role_path
  role_permissions_boundary = var.iam_permissions_boundary_arn == "" ? null : var.iam_permissions_boundary_arn

  function_name = "${var.project_name}-sso-token-${var.environment}"
  description   = "Authoritative enterprise SSO role mapping"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 10

  source_path = [
    {
      path = "${path.module}/../../../lambda/sso-token"
      commands = [
        "cd ../.. && npm run build -w sso-token-lambda",
        ":zip lambda/sso-token/.build",
      ]
    }
  ]

  hash_extra = local.sso_sources_hash

  vpc_subnet_ids         = local.all_lambdas_in_vpc ? var.vpc_subnet_ids : null
  vpc_security_group_ids = local.all_lambdas_in_vpc ? var.vpc_security_group_ids : null
  attach_network_policy  = local.all_lambdas_in_vpc

  # Records each federated sign-in's claims for member role calculation. Only
  # USER# items, and only writes; KMS use is limited to DynamoDB. Attached by the
  # module before the function is updated, so recording never runs unauthorized.
  attach_policy_statements = true
  policy_statements = merge(
    {
      record_sso_claims = {
        effect    = "Allow"
        actions   = ["dynamodb:PutItem"]
        resources = [var.access_table_arn]
        condition = {
          user_items = {
            test     = "ForAllValues:StringLike"
            variable = "dynamodb:LeadingKeys"
            values   = ["USER#*"]
          }
        }
      }
    },
    var.kms_key_arn == "" ? {} : {
      use_dynamodb_encryption_key = {
        effect    = "Allow"
        actions   = ["kms:DescribeKey", "kms:Decrypt", "kms:Encrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*"]
        resources = [var.kms_key_arn]
        condition = {
          via_dynamodb = {
            test     = "StringLike"
            variable = "kms:ViaService"
            values   = ["dynamodb.*.${data.aws_partition.current.dns_suffix}"]
          }
        }
      }
      allow_dynamodb_resource_grant = {
        effect    = "Allow"
        actions   = ["kms:CreateGrant"]
        resources = [var.kms_key_arn]
        condition = {
          via_dynamodb = {
            test     = "StringLike"
            variable = "kms:ViaService"
            values   = ["dynamodb.*.${data.aws_partition.current.dns_suffix}"]
          }
          aws_resource_grant = {
            test     = "Bool"
            variable = "kms:GrantIsForAWSResource"
            values   = ["true"]
          }
        }
      }
    },
  )

  environment_variables = {
    AWS_SDK_UA_APP_ID       = var.aws_sdk_ua_app_id
    POWERTOOLS_SERVICE_NAME = var.powertools_service_name
    POWERTOOLS_LOG_LEVEL    = var.powertools_log_level
    SSO_ROLE_CONFIG         = jsonencode(local.role_config)
    ACCESS_TABLE            = var.access_table_name
  }
}

resource "aws_lambda_permission" "allow_cognito_sso_token" {
  count = local.sso_enabled ? 1 : 0

  statement_id   = "AllowCognitoUserPoolInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = module.sso_token_lambda[0].lambda_function_name
  principal      = "cognito-idp.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

# Cognito User Pool
resource "aws_cognito_user_pool" "main" {
  name = "${var.project_name}-${var.environment}-user-pool"

  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  # Email sign-in configuration (use email as username)
  username_attributes = ["email"]

  # Custom attributes
  schema {
    name                = "display_name"
    attribute_data_type = "String"
    mutable             = true
    required            = false
    string_attribute_constraints {
      min_length = 1
      max_length = 50
    }
  }

  schema {
    name                = "sso_roles"
    attribute_data_type = "String"
    mutable             = true
    required            = false
    string_attribute_constraints {
      min_length = 0
      max_length = 2048
    }
  }

  schema {
    name                = "avatar_url"
    attribute_data_type = "String"
    mutable             = true
    required            = false
    string_attribute_constraints {
      min_length = 0
      max_length = 500
    }
  }

  # Password policy
  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_numbers   = true
    require_symbols   = true
    require_uppercase = true
  }

  # MFA — optional so existing users aren't locked out, but available for
  # anyone who wants to enroll (TOTP via authenticator app).
  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  # Email configuration
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  # Account recovery
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Admin-only user creation. Disables the public SignUp API so an attacker
  # who reads the (public) app client id from the JS bundle cannot enroll an
  # account and obtain a valid JWT. Deployers provision users via the admin
  # API (see README step 5).
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  dynamic "lambda_config" {
    for_each = local.sso_enabled ? [1] : []
    content {
      pre_token_generation = module.sso_token_lambda[0].lambda_function_arn
    }
  }

  tags = var.tags

  depends_on = [aws_lambda_permission.allow_cognito_sso_token]
}

resource "aws_wafv2_web_acl_association" "user_pool" {
  count = var.waf_enabled ? 1 : 0

  resource_arn = aws_cognito_user_pool.main.arn
  web_acl_arn  = var.web_acl_arn
}

resource "random_id" "cognito_domain" {
  byte_length = 4
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${substr(replace(lower("${var.project_name}-${var.environment}"), "/[^a-z0-9-]/", "-"), 0, 50)}-${random_id.cognito_domain.hex}"
  user_pool_id = aws_cognito_user_pool.main.id
}

# Optional custom managed-login domain. A user pool can hold one prefix domain
# and one custom domain at the same time, so the prefix domain stays in place
# and disabling custom_domain_active rolls back without replacing either domain.
resource "aws_cognito_user_pool_domain" "custom" {
  count = var.custom_domain != "" ? 1 : 0

  domain          = var.custom_domain
  certificate_arn = var.custom_domain_certificate_arn
  user_pool_id    = aws_cognito_user_pool.main.id
}

resource "aws_cognito_identity_provider" "main" {
  for_each = local.sso_provider_names

  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = each.key
  provider_type = upper(var.sso_providers[each.key].type) == "OIDC" ? "OIDC" : "SAML"

  # Cognito adds attributes_url_add_attributes and the username -> sub mapping
  # to every OIDC provider itself. Set both to the values Cognito uses, or
  # every plan offers to remove them.
  provider_details = lower(var.sso_providers[each.key].type) == "oidc" ? {
    attributes_request_method     = "GET"
    attributes_url_add_attributes = "false"
    authorize_scopes              = join(" ", var.sso_providers[each.key].scopes)
    client_id                     = var.sso_providers[each.key].client_id
    client_secret                 = data.aws_secretsmanager_secret_version.oidc_client_secret[each.key].secret_string
    oidc_issuer                   = var.sso_providers[each.key].issuer_url
    } : merge(
    var.sso_providers[each.key].metadata_url != "" ? { MetadataURL = var.sso_providers[each.key].metadata_url } : {},
    var.sso_providers[each.key].metadata_xml != "" ? { MetadataFile = var.sso_providers[each.key].metadata_xml } : {},
    { IDPSignout = "false" },
  )

  attribute_mapping = merge(
    { email = var.sso_providers[each.key].email_claim },
    var.sso_providers[each.key].name_claim != "" ? { name = var.sso_providers[each.key].name_claim } : {},
    # Cognito keeps this value when the IdP omits the claim. TODO: map an absent
    # claim to empty with the inbound federation trigger once the provider
    # supports it (hashicorp/terraform-provider-aws#47954).
    var.sso_providers[each.key].role_claim != "" ? { "custom:sso_roles" = var.sso_providers[each.key].role_claim } : {},
    lower(var.sso_providers[each.key].type) == "oidc" ? { username = "sub" } : {},
  )
}

# User Pool Client
resource "aws_cognito_user_pool_client" "main" {
  name         = "${var.project_name}-${var.environment}-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    for flow in ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"] :
    flow if flow != "ALLOW_USER_SRP_AUTH" || local.local_enabled
  ]

  allowed_oauth_flows_user_pool_client = local.sso_enabled
  allowed_oauth_flows                  = local.sso_enabled ? ["code"] : []
  # Hosted SSO tokens deliberately omit aws.cognito.signin.user.admin so a
  # federated user cannot call GetUser or UpdateUserAttributes.
  allowed_oauth_scopes = local.sso_enabled ? [
    "openid",
    "email",
    "profile",
  ] : []
  # Cognito only maps IdP claims into app-client-writable attributes. The
  # hosted tokens above cannot exercise these write permissions. Local users
  # can update profile attributes, but cannot write the Cognito-owned
  # `identities` attribute that makes the role mapper treat a user as federated.
  write_attributes = local.app_client_write_attributes
  callback_urls    = local.sso_enabled ? ["${var.app_url}/auth/callback"] : []
  logout_urls      = local.sso_enabled ? ["${var.app_url}/login"] : []
  supported_identity_providers = local.sso_enabled ? concat(
    local.local_enabled ? ["COGNITO"] : [],
    sort(keys(var.sso_providers)),
  ) : ["COGNITO"]

  # Token validity
  access_token_validity  = var.access_token_validity_minutes
  id_token_validity      = var.id_token_validity_minutes
  refresh_token_validity = local.refresh_token_validity_hours

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }

  # Prevent user existence errors
  prevent_user_existence_errors = "ENABLED"

  depends_on = [aws_cognito_identity_provider.main]
}

# Cognito Groups
resource "aws_cognito_user_group" "member" {
  name         = "member"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Member role with basic access"
  precedence   = 3
}

resource "aws_cognito_user_group" "approver" {
  name         = "approver"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Approver role with review permissions"
  precedence   = 2
}

resource "aws_cognito_user_group" "owner" {
  name         = "owner"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Owner role with full permissions"
  precedence   = 1
}

# Platform administrators: may change platform-wide settings (agent settings,
# tracker OAuth apps, GitHub auth mode, migrations, user management) and
# author workflows/building blocks. Membership is assigned
# out-of-band, e.g.:
#   aws cognito-idp admin-add-user-to-group \
#     --user-pool-id <pool> --username <user> --group-name platform-admin
resource "aws_cognito_user_group" "platform_admin" {
  name         = "platform-admin"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Platform administrator with access to platform-wide settings"
  precedence   = 0
}
