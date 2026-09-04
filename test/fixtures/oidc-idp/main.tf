data "aws_caller_identity" "current" {}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  resource_prefix = "${var.name_prefix}-${random_id.suffix.hex}"
}

data "archive_file" "role_claim" {
  type        = "zip"
  source_file = "${path.module}/index.mjs"
  output_path = "${path.module}/.role-claim.zip"
}

resource "aws_iam_role" "role_claim" {
  name = "${local.resource_prefix}-role-claim"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "role_claim_logs" {
  role       = aws_iam_role.role_claim.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "role_claim" {
  function_name = "${local.resource_prefix}-role-claim"
  role          = aws_iam_role.role_claim.arn
  handler       = "index.handler"
  runtime       = "nodejs24.x"

  filename         = data.archive_file.role_claim.output_path
  source_code_hash = data.archive_file.role_claim.output_base64sha256
}

resource "aws_lambda_permission" "allow_cognito" {
  statement_id   = "AllowDisposableCognitoPool"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.role_claim.function_name
  principal      = "cognito-idp.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_cognito_user_pool" "idp" {
  name                = local.resource_prefix
  username_attributes = ["email"]

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_numbers   = true
    require_symbols   = true
    require_uppercase = true
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  lambda_config {
    pre_token_generation = aws_lambda_function.role_claim.arn
  }

  depends_on = [aws_lambda_permission.allow_cognito]
}

resource "aws_cognito_user_group" "user" {
  name         = "aidlc-user"
  user_pool_id = aws_cognito_user_pool.idp.id
  description  = "Users allowed to enter the downstream AI-DLC deployment"
  precedence   = 10
}

resource "aws_cognito_user_group" "admin" {
  name         = "aidlc-admin"
  user_pool_id = aws_cognito_user_pool.idp.id
  description  = "Users mapped to the downstream platform-admin role"
  precedence   = 5
}

resource "aws_cognito_user_pool_domain" "idp" {
  domain       = local.resource_prefix
  user_pool_id = aws_cognito_user_pool.idp.id
}

resource "aws_cognito_user_pool_client" "downstream" {
  name         = "aidlc-downstream"
  user_pool_id = aws_cognito_user_pool.idp.id

  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = [var.downstream_callback_url]
  supported_identity_providers         = ["COGNITO"]
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
}

resource "aws_secretsmanager_secret" "client_secret" {
  name                    = "${local.resource_prefix}/client-secret"
  description             = "Disposable OIDC client secret for the AI-DLC SSO test fixture"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "client_secret" {
  secret_id     = aws_secretsmanager_secret.client_secret.id
  secret_string = aws_cognito_user_pool_client.downstream.client_secret
}
