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
  description = "Domain of the Cognito User Pool"
  value       = aws_cognito_user_pool.main.domain
}

output "group_names" {
  description = "Names of the Cognito User Pool Groups"
  value = {
    member   = aws_cognito_user_group.member.name
    approver = aws_cognito_user_group.approver.name
    owner    = aws_cognito_user_group.owner.name
  }
}