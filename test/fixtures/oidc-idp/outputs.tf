output "user_pool_id" {
  description = "Disposable upstream Cognito User Pool ID."
  value       = aws_cognito_user_pool.idp.id
}

output "managed_login_url" {
  description = "Disposable upstream Cognito managed-login origin."
  value       = "https://${aws_cognito_user_pool_domain.idp.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "provider_config" {
  description = "SSO configuration accepted by install.sh and deploy-terraform.sh."
  value = {
    providers = [{
      name            = "DisposableCognito"
      displayName     = "Disposable test IdP"
      type            = "oidc"
      issuerUrl       = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.idp.id}"
      clientId        = aws_cognito_user_pool_client.downstream.id
      clientSecretArn = aws_secretsmanager_secret.client_secret.arn
      scopes          = ["openid", "email", "profile"]
      claims = {
        email = "email"
        name  = "name"
        roles = "aidlc_roles"
      }
      roleMappings = {
        platform-admin = ["aidlc-admin"]
      }
      requiredClaimValues = ["aidlc-user"]
    }]
  }
}

output "provider_config_json" {
  description = "Compact provider JSON, useful for inspection."
  value = jsonencode({
    providers = [{
      name            = "DisposableCognito"
      displayName     = "Disposable test IdP"
      type            = "oidc"
      issuerUrl       = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.idp.id}"
      clientId        = aws_cognito_user_pool_client.downstream.id
      clientSecretArn = aws_secretsmanager_secret.client_secret.arn
      scopes          = ["openid", "email", "profile"]
      claims = {
        email = "email"
        name  = "name"
        roles = "aidlc_roles"
      }
      roleMappings = {
        platform-admin = ["aidlc-admin"]
      }
      requiredClaimValues = ["aidlc-user"]
    }]
  })
}
