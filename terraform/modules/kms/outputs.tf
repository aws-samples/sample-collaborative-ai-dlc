output "key_arn" {
  description = "ARN of the shared customer-managed data key"
  value       = aws_kms_key.data.arn
}

output "key_id" {
  description = "ID of the shared customer-managed data key"
  value       = aws_kms_key.data.key_id
}
