# IAM setup needs the actual broker principal for the inference role trust policy.
output "credential_broker_role_arn" {
  description = "Credential broker role that Bedrock IAM inference roles trust"
  value       = aws_iam_role.credential_broker.arn
}
