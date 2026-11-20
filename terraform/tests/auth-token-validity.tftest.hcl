mock_provider "aws" {
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id  = "eu-central-1_Test123"
      arn = "arn:aws:cognito-idp:eu-central-1:111122223333:userpool/eu-central-1_Test123"
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "eu-central-1"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111122223333"
    }
  }

  mock_data "aws_secretsmanager_secret_version" {
    defaults = {
      secret_string = "test-only-secret"
    }
  }
}

mock_provider "random" {}

variables {
  aws_sdk_ua_app_id       = "Collaborative_AI-DLC-test"
  project_name            = "auth-token-test"
  environment             = "test"
  powertools_service_name = "auth-token-test"
  powertools_log_level    = "INFO"
  app_url                 = "https://app.example.com"
  auth_mode               = "local"
}

run "local_defaults_keep_existing_lifetimes" {
  command = plan

  module {
    source = "./modules/auth"
  }

  assert {
    condition     = aws_cognito_user_pool_client.main.access_token_validity == 60 && aws_cognito_user_pool_client.main.id_token_validity == 60
    error_message = "Access and ID tokens must keep their one-hour default."
  }

  assert {
    condition     = aws_cognito_user_pool_client.main.refresh_token_validity == 168
    error_message = "Local mode must keep the seven-day refresh token default."
  }

  assert {
    condition = (
      aws_cognito_user_pool_client.main.token_validity_units[0].access_token == "minutes" &&
      aws_cognito_user_pool_client.main.token_validity_units[0].id_token == "minutes" &&
      aws_cognito_user_pool_client.main.token_validity_units[0].refresh_token == "hours"
    )
    error_message = "Token lifetimes must be expressed in minutes and refresh tokens in hours."
  }
}

run "sso_default_keeps_one_day_refresh" {
  command = plan

  module {
    source = "./modules/auth"
  }

  override_module {
    target = module.sso_token_lambda[0]
    outputs = {
      lambda_function_name = "test-sso-token"
      lambda_function_arn  = "arn:aws:lambda:eu-central-1:111122223333:function:test-sso-token"
    }
  }

  variables {
    auth_mode = "hybrid"
    sso_providers = {
      CorporateOIDC = {
        display_name      = "Corporate login"
        type              = "oidc"
        issuer_url        = "https://idp.example.com"
        client_id         = "test-client"
        client_secret_arn = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:test-client-AbCdEf"
        email_claim       = "email"
      }
    }
  }

  assert {
    condition     = aws_cognito_user_pool_client.main.refresh_token_validity == 24
    error_message = "Enterprise SSO must keep the one-day refresh token default."
  }
}

run "explicit_lifetimes_override_defaults" {
  command = plan

  module {
    source = "./modules/auth"
  }

  override_module {
    target = module.sso_token_lambda[0]
    outputs = {
      lambda_function_name = "test-sso-token"
      lambda_function_arn  = "arn:aws:lambda:eu-central-1:111122223333:function:test-sso-token"
    }
  }

  variables {
    auth_mode = "hybrid"
    sso_providers = {
      CorporateOIDC = {
        display_name      = "Corporate login"
        type              = "oidc"
        issuer_url        = "https://idp.example.com"
        client_id         = "test-client"
        client_secret_arn = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:test-client-AbCdEf"
        email_claim       = "email"
      }
    }
    access_token_validity_minutes = 10
    id_token_validity_minutes     = 30
    refresh_token_validity_hours  = 10
  }

  assert {
    condition     = aws_cognito_user_pool_client.main.access_token_validity == 10
    error_message = "An explicit access token lifetime must reach the app client."
  }

  assert {
    condition     = aws_cognito_user_pool_client.main.id_token_validity == 30
    error_message = "An explicit ID token lifetime must reach the app client."
  }

  assert {
    condition     = aws_cognito_user_pool_client.main.refresh_token_validity == 10
    error_message = "An explicit refresh token lifetime must replace the mode default."
  }
}

run "rejects_access_token_below_cognito_minimum" {
  command = plan

  module {
    source = "./modules/auth"
  }

  variables {
    access_token_validity_minutes = 4
  }

  expect_failures = [var.access_token_validity_minutes]
}

run "rejects_id_token_above_cognito_maximum" {
  command = plan

  module {
    source = "./modules/auth"
  }

  variables {
    id_token_validity_minutes = 1441
  }

  expect_failures = [var.id_token_validity_minutes]
}

run "rejects_fractional_refresh_token_hours" {
  command = plan

  module {
    source = "./modules/auth"
  }

  variables {
    refresh_token_validity_hours = 1.5
  }

  expect_failures = [var.refresh_token_validity_hours]
}

run "rejects_refresh_token_below_one_hour" {
  command = plan

  module {
    source = "./modules/auth"
  }

  variables {
    refresh_token_validity_hours = 0
  }

  expect_failures = [var.refresh_token_validity_hours]
}
