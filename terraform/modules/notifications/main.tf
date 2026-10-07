# Attention-notifications data plane: queues and the unsubscribe signing secret.
# Only the notifications-data-infra unit edits main.tf, variables.tf and
# outputs.tf. Downstream units add their own <unit>.tf files to this module and
# consume the outputs; renaming an output breaks them.

locals {
  dlq_retention_seconds        = 1209600 # 14 days, matching the existing DLQs
  escalation_retention_seconds = 345600  # 4 days
  # Matches the 2-minute unread grace window before email escalation. Producers
  # also set DelaySeconds per message; this queue default is a safety net.
  escalation_delay_seconds = 120
  escalation_max_receives  = 5
}

resource "aws_sqs_queue" "escalation_dlq" {
  name                      = "${var.project_name}-notifications-escalation-dlq-${var.environment}"
  message_retention_seconds = local.dlq_retention_seconds
  sqs_managed_sse_enabled   = true

  tags = var.tags
}

resource "aws_sqs_queue" "escalation" {
  name                      = "${var.project_name}-notifications-escalation-${var.environment}"
  delay_seconds             = local.escalation_delay_seconds
  message_retention_seconds = local.escalation_retention_seconds
  # AWS guidance for Lambda event source mappings: six times the function timeout.
  visibility_timeout_seconds = 6 * var.escalation_worker_timeout_seconds
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.escalation_dlq.arn
    maxReceiveCount     = local.escalation_max_receives
  })

  tags = var.tags
}

# A separate resource avoids a cycle between the queue and its DLQ.
resource "aws_sqs_queue_redrive_allow_policy" "escalation_dlq" {
  queue_url = aws_sqs_queue.escalation_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.escalation.arn]
  })
}

# On-failure destination for the v2_executions stream event source mapping.
# execution-event-capture configures the mapping and grants its role
# sqs:SendMessage in its own file.
resource "aws_sqs_queue" "capture_dlq" {
  name                      = "${var.project_name}-notifications-capture-dlq-${var.environment}"
  message_retention_seconds = local.dlq_retention_seconds
  sqs_managed_sse_enabled   = true

  tags = var.tags
}

# HMAC key for one-click unsubscribe links. Terraform owns only the container:
# scripts/seed-notifications-secret.mjs puts the value once after apply, so the
# key never enters Terraform state or plans. Value shape:
#   {"current":{"kid":"k1","key":"<base64url>"},"previous":null}
resource "aws_secretsmanager_secret" "unsubscribe_hmac" {
  name_prefix = "${var.project_name}-${var.environment}-notifications-unsubscribe-hmac-"
  description = "HMAC signing key for notification unsubscribe links (seeded by deploy-terraform.sh)"
  kms_key_id  = var.kms_key_arn != "" ? var.kms_key_arn : null

  tags = var.tags
}
