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
  project_name                  = "auth-domain-test"
  environment                   = "test"
  powertools_service_name       = "auth-domain-test"
  powertools_log_level          = "INFO"
  app_url                       = "https://app.example.com"
  auth_mode                     = "local"
  custom_domain                 = "auth.app.example.com"
  custom_domain_certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-000000000000"
}

run "provision_without_cutover" {
  command = apply
  module {
    source = "./modules/auth"
  }
  assert {
    condition     = endswith(output.hosted_ui_domain, ".auth.eu-central-1.amazoncognito.com")
    error_message = "Provisioning a custom domain must retain the generated login origin."
  }
  assert {
    condition     = output.oidc_idp_callback_url == "${output.hosted_ui_domain}/oauth2/idpresponse"
    error_message = "The effective IdP callback must stay on the selected login origin."
  }
  assert {
    condition     = output.custom_domain_dns_target != ""
    error_message = "The custom domain must still be provisioned for DNS preparation."
  }
}

run "activate_prepared_domain" {
  command = apply
  module {
    source = "./modules/auth"
  }
  variables {
    custom_domain_active = true
  }
  assert {
    condition     = output.hosted_ui_domain == "https://auth.app.example.com"
    error_message = "Explicit activation must select the custom login domain."
  }
  assert {
    condition     = output.saml_acs_url == "https://auth.app.example.com/saml2/idpresponse"
    error_message = "SAML must use the same activated origin as OIDC and frontend login."
  }
}

run "rollback_without_domain_replacement" {
  command = apply
  module {
    source = "./modules/auth"
  }
  variables {
    custom_domain_active = false
  }
  assert {
    condition     = output.hosted_ui_domain == run.provision_without_cutover.hosted_ui_domain
    error_message = "Rollback must restore the original generated login origin."
  }
  assert {
    condition     = output.custom_domain_dns_target == run.provision_without_cutover.custom_domain_dns_target
    error_message = "Login rollback must preserve the provisioned custom domain."
  }
}

run "preserve_existing_hybrid_login" {
  command = apply
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
        role_claim        = "groups"
        role_mappings     = { platform-admin = ["admins"] }
      }
    }
  }
  assert {
    condition     = output.hosted_ui_domain == run.provision_without_cutover.hosted_ui_domain
    error_message = "Provisioning must not change an existing hybrid login origin."
  }
}

run "preserve_existing_sso_only_login" {
  command = apply
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
    auth_mode = "sso-only"
    sso_providers = {
      CorporateOIDC = {
        display_name      = "Corporate login"
        type              = "oidc"
        issuer_url        = "https://idp.example.com"
        client_id         = "test-client"
        client_secret_arn = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:test-client-AbCdEf"
        email_claim       = "email"
        role_claim        = "groups"
        role_mappings     = { platform-admin = ["admins"] }
      }
    }
  }
  assert {
    condition     = output.hosted_ui_domain == run.provision_without_cutover.hosted_ui_domain
    error_message = "Provisioning must not change an existing SSO-only login origin."
  }
}
