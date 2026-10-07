# Published contract (contract-notifications-data-plane). Downstream units
# depend on these names; renaming or removing one is a breaking change.

output "escalation_queue_url" {
  description = "URL of the notification escalation queue"
  value       = aws_sqs_queue.escalation.url
}

output "escalation_queue_arn" {
  description = "ARN of the notification escalation queue"
  value       = aws_sqs_queue.escalation.arn
}

output "escalation_dlq_arn" {
  description = "ARN of the escalation dead-letter queue"
  value       = aws_sqs_queue.escalation_dlq.arn
}

output "escalation_dlq_name" {
  description = "Name of the escalation dead-letter queue"
  value       = aws_sqs_queue.escalation_dlq.name
}

output "capture_dlq_arn" {
  description = "ARN of the execution-event capture dead-letter queue"
  value       = aws_sqs_queue.capture_dlq.arn
}

output "capture_dlq_name" {
  description = "Name of the execution-event capture dead-letter queue"
  value       = aws_sqs_queue.capture_dlq.name
}

output "unsubscribe_secret_arn" {
  description = "ARN of the unsubscribe HMAC signing secret"
  value       = aws_secretsmanager_secret.unsubscribe_hmac.arn
}
