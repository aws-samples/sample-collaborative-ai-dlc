output "user_pool_id" {
  description = "ID of the Cognito User Pool"
  value       = aws_cognito_user_pool.main.id
}

output "user_pool_arn" {
  description = "ARN of the Cognito User Pool"
  value       = aws_cognito_user_pool.main.arn
}

output "user_pool_client_id" {
  description = "ID of the Cognito User Pool Client"
  value       = aws_cognito_user_pool_client.main.id
}

output "user_pool_domain" {
  description = "Cognito managed-login domain prefix"
  value       = aws_cognito_user_pool_domain.main.domain
}

output "hosted_ui_domain" {
  description = "Full Cognito managed-login origin"
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
}

output "oidc_idp_callback_url" {
  description = "Callback URL to register with an upstream OIDC provider"
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${data.aws_region.current.region}.amazoncognito.com/oauth2/idpresponse"
}

output "saml_acs_url" {
  description = "SAML assertion consumer service URL"
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${data.aws_region.current.region}.amazoncognito.com/saml2/idpresponse"
}

output "saml_entity_id" {
  description = "SAML service-provider entity ID"
  value       = "urn:amazon:cognito:sp:${aws_cognito_user_pool.main.id}"
}

output "public_sso_providers" {
  description = "Provider names and labels safe to expose in the frontend bundle"
  value = nonsensitive([
    for name in sort(keys(var.sso_providers)) : {
      name        = name
      displayName = var.sso_providers[name].display_name
      type        = lower(var.sso_providers[name].type)
    }
  ])
}

output "group_names" {
  description = "Names of the Cognito User Pool Groups"
  value = {
    member   = aws_cognito_user_group.member.name
    approver = aws_cognito_user_group.approver.name
    owner    = aws_cognito_user_group.owner.name
  }
}
