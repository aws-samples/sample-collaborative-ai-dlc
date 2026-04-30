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

  tags = var.tags
}

# User Pool Client
resource "aws_cognito_user_pool_client" "main" {
  name         = "${var.project_name}-${var.environment}-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH"
  ]

  # Token validity
  access_token_validity  = 60 # 1 hour
  id_token_validity      = 60 # 1 hour
  refresh_token_validity = 7  # 7 days (reduced from 30 — limits token reuse window)

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  # Prevent user existence errors
  prevent_user_existence_errors = "ENABLED"
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