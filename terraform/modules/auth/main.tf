data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  sso_enabled        = var.auth_mode != "local"
  local_enabled      = var.auth_mode != "sso-only"
  sso_provider_names = nonsensitive(toset(keys(var.sso_providers)))
  oidc_provider_names = nonsensitive(toset([
    for name, provider in var.sso_providers : name
    if lower(provider.type) == "oidc"
  ]))
  role_config = {
    providers = {
      for name, provider in var.sso_providers : name => {
        roleMappings        = provider.role_mappings
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
}

data "aws_secretsmanager_secret_version" "oidc_client_secret" {
  for_each  = local.oidc_provider_names
  secret_id = var.sso_providers[each.key].client_secret_arn
}

module "sso_token_lambda" {
  count   = local.sso_enabled ? 1 : 0
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

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

  environment_variables = {
    SSO_ROLE_CONFIG = jsonencode(local.role_config)
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

resource "random_id" "cognito_domain" {
  byte_length = 4
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${substr(replace(lower("${var.project_name}-${var.environment}"), "/[^a-z0-9-]/", "-"), 0, 50)}-${random_id.cognito_domain.hex}"
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_identity_provider" "main" {
  for_each = local.sso_provider_names

  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = each.key
  provider_type = upper(var.sso_providers[each.key].type) == "OIDC" ? "OIDC" : "SAML"

  provider_details = lower(var.sso_providers[each.key].type) == "oidc" ? {
    attributes_request_method = "GET"
    authorize_scopes          = join(" ", var.sso_providers[each.key].scopes)
    client_id                 = var.sso_providers[each.key].client_id
    client_secret             = data.aws_secretsmanager_secret_version.oidc_client_secret[each.key].secret_string
    oidc_issuer               = var.sso_providers[each.key].issuer_url
    } : merge(
    var.sso_providers[each.key].metadata_url != "" ? { MetadataURL = var.sso_providers[each.key].metadata_url } : {},
    var.sso_providers[each.key].metadata_xml != "" ? { MetadataFile = var.sso_providers[each.key].metadata_xml } : {},
    { IDPSignout = "false" },
  )

  attribute_mapping = merge(
    { email = var.sso_providers[each.key].email_claim },
    var.sso_providers[each.key].name_claim != "" ? { name = var.sso_providers[each.key].name_claim } : {},
    var.sso_providers[each.key].role_claim != "" ? { "custom:sso_roles" = var.sso_providers[each.key].role_claim } : {},
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
  access_token_validity  = 60 # 1 hour
  id_token_validity      = 60 # 1 hour
  refresh_token_validity = local.sso_enabled ? 1 : 7

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
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
