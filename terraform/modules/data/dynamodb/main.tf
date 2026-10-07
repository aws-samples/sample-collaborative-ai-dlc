locals {
  # Keep billing independent from the environment name. Capacity attributes set to
  # null are omitted by Terraform when PAY_PER_REQUEST is active.
  billing_mode   = "PAY_PER_REQUEST"
  read_capacity  = null
  write_capacity = null

  # Published through outputs; the deploy pre-flight treats SourceIndex as the
  # "notifications table already upgraded" marker.
  notifications_source_index = "SourceIndex"
  notifications_digest_index = "DigestIndex"
}

resource "aws_dynamodb_table" "sessions" {
  name                        = "${var.project_name}-sessions-${var.environment}"
  billing_mode                = local.billing_mode
  hash_key                    = "sessionId"
  read_capacity               = local.read_capacity
  write_capacity              = local.write_capacity
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "sessionId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "notifications" {
  name                        = "${var.project_name}-notifications-${var.environment}"
  billing_mode                = local.billing_mode
  hash_key                    = "userId"
  range_key                   = "timestamp"
  read_capacity               = local.read_capacity
  write_capacity              = local.write_capacity
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "N"
  }

  # Attention-notification inbox. The key schema above is unchanged on purpose:
  # changing it would replace the table, which deletion protection blocks on
  # existing installs. TTL and the two sparse GSIs below are online, in-place
  # updates. The provider creates one GSI per UpdateTable call and waits for it.
  attribute {
    name = "sourceKey"
    type = "S"
  }

  attribute {
    name = "digestBucket"
    type = "S"
  }

  # Resolve-on-answer: every inbox item raised by one gate shares a sourceKey.
  # Only base keys are needed to update those items, so KEYS_ONLY is enough.
  # deploy-terraform.sh's notifications pre-flight uses this index as the
  # "already upgraded" marker; do not rename it.
  global_secondary_index {
    name            = local.notifications_source_index
    projection_type = "KEYS_ONLY"
    read_capacity   = local.read_capacity
    write_capacity  = local.write_capacity

    key_schema {
      attribute_name = "sourceKey"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "timestamp"
      key_type       = "RANGE"
    }
  }

  # Morning digest: items carry digestBucket (UTC YYYY-MM-DDTHH) until the
  # digest is sent and the writer removes it. The range key groups items by user.
  global_secondary_index {
    name            = local.notifications_digest_index
    projection_type = "ALL"
    read_capacity   = local.read_capacity
    write_capacity  = local.write_capacity

    key_schema {
      attribute_name = "digestBucket"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "userId"
      key_type       = "RANGE"
    }
  }

  # 30-day retention: writers set expiresAt (epoch seconds) to createdAt + 30 days.
  # TTL deletion is lazy, so readers also filter expiresAt > now.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}

# Generic namespaced preferences: PK scope (user#<sub> | platform | project#<id>),
# SK namespace (notifications, email-channel, ...). Accessed only through
# lambda/shared/preferences-store.js. Preferences never expire, so there is no TTL.
resource "aws_dynamodb_table" "preferences" {
  name                        = "${var.project_name}-preferences-${var.environment}"
  billing_mode                = local.billing_mode
  hash_key                    = "scope"
  range_key                   = "namespace"
  read_capacity               = local.read_capacity
  write_capacity              = local.write_capacity
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "scope"
    type = "S"
  }

  attribute {
    name = "namespace"
    type = "S"
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "agent_questions" {
  name                        = "${var.project_name}-agent-questions-${var.environment}"
  billing_mode                = local.billing_mode
  hash_key                    = "questionId"
  read_capacity               = local.read_capacity
  write_capacity              = local.write_capacity
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "questionId"
    type = "S"
  }

  attribute {
    name = "agentTaskId"
    type = "S"
  }

  global_secondary_index {
    name            = "AgentTaskIdIndex"
    projection_type = "ALL"
    read_capacity   = local.read_capacity
    write_capacity  = local.write_capacity

    key_schema {
      attribute_name = "agentTaskId"
      key_type       = "HASH"
    }
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "yjs_documents" {
  name                        = "${var.project_name}-yjs-documents-${var.environment}"
  billing_mode                = local.billing_mode
  hash_key                    = "documentId"
  read_capacity               = local.read_capacity
  write_capacity              = local.write_capacity
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "documentId"
    type = "S"
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "connections" {
  name           = "${var.project_name}-connections-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "connectionId"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

  attribute {
    name = "connectionId"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "documentId"
    type = "S"
  }

  global_secondary_index {
    name            = "UserIdIndex"
    projection_type = "ALL"
    read_capacity   = local.read_capacity
    write_capacity  = local.write_capacity

    key_schema {
      attribute_name = "userId"
      key_type       = "HASH"
    }
  }

  global_secondary_index {
    name            = "DocumentIdIndex"
    projection_type = "ALL"
    read_capacity   = local.read_capacity
    write_capacity  = local.write_capacity

    key_schema {
      attribute_name = "documentId"
      key_type       = "HASH"
    }
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  tags = var.tags
}


resource "aws_dynamodb_table" "agent_outputs" {
  name                        = "${var.project_name}-agent-outputs-${var.environment}"
  billing_mode                = local.billing_mode
  hash_key                    = "executionId"
  range_key                   = "agentType"
  read_capacity               = local.read_capacity
  write_capacity              = local.write_capacity
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "executionId"
    type = "S"
  }

  attribute {
    name = "agentType"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}

# Discussions feature: one table, three record kinds —
# assist locks (`assist:{discussionId}`), creation guards
# (`create:{sprintId}:{entityType}:{entityId}`), and stateful message guards
# (`msg:{discussionId}:{messageId}`, pending|complete). All access is via
# conditional writes with in-condition expiry checks — lazy TTL deletion is
# never trusted.
resource "aws_dynamodb_table" "discussion_locks" {
  name           = "${var.project_name}-discussion-locks-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "lockId"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

  attribute {
    name = "lockId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  tags = var.tags
}

# Reusable workflow building blocks — single-table design. Unlike the other
# tables here this holds DOMAIN data, not infra: imported SYSTEM definitions plus
# the shared default user-owned library of reusable blocks and the workflows that
# compose them.
#   PK = BLOCK#<tenant>#<TYPE>#<id>   SK = V#latest | V#<n> (immutable versions)
# GSI1 is the catalog browse index (list blocks of a type for a tenant). Large
# bodies/scripts live in the artifacts S3 bucket under blocks/, referenced by a
# content-addressed pointer — never inline.
resource "aws_dynamodb_table" "blocks" {
  name                        = "${var.project_name}-blocks-${var.environment}"
  billing_mode                = local.billing_mode
  hash_key                    = "pk"
  range_key                   = "sk"
  read_capacity               = local.read_capacity
  write_capacity              = local.write_capacity
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    projection_type = "ALL"
    read_capacity   = local.read_capacity
    write_capacity  = local.write_capacity

    key_schema {
      attribute_name = "GSI1PK"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "GSI1SK"
      key_type       = "RANGE"
    }
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "environment_registry" {
  name                        = "${var.project_name}-environment-registry-${var.environment}"
  billing_mode                = local.billing_mode
  hash_key                    = "pk"
  range_key                   = "sk"
  read_capacity               = local.read_capacity
  write_capacity              = local.write_capacity
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    projection_type = "ALL"
    read_capacity   = local.read_capacity
    write_capacity  = local.write_capacity

    key_schema {
      attribute_name = "GSI1PK"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "GSI1SK"
      key_type       = "RANGE"
    }
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}

# Per-user composite read cursors: {lastReadAt,
# lastReadMessageId, sprintId}. High-churn per-user KV — wrong shape for the
# graph.
resource "aws_dynamodb_table" "discussion_read_state" {
  name                        = "${var.project_name}-discussion-read-state-${var.environment}"
  billing_mode                = local.billing_mode
  hash_key                    = "userId"
  range_key                   = "discussionId"
  read_capacity               = local.read_capacity
  write_capacity              = local.write_capacity
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "discussionId"
    type = "S"
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}
