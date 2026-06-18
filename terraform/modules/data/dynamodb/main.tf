locals {
  billing_mode   = var.environment == "prod" ? "PROVISIONED" : "PAY_PER_REQUEST"
  read_capacity  = var.environment == "prod" ? 5 : null
  write_capacity = var.environment == "prod" ? 5 : null
}

resource "aws_dynamodb_table" "sessions" {
  name           = "${var.project_name}-sessions-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "sessionId"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

  attribute {
    name = "sessionId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "notifications" {
  name           = "${var.project_name}-notifications-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "userId"
  range_key      = "timestamp"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "N"
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "agent_questions" {
  name           = "${var.project_name}-agent-questions-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "questionId"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

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

  tags = var.tags
}

resource "aws_dynamodb_table" "yjs_documents" {
  name           = "${var.project_name}-yjs-documents-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "documentId"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

  attribute {
    name = "documentId"
    type = "S"
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

  tags = var.tags
}


resource "aws_dynamodb_table" "agent_outputs" {
  name           = "${var.project_name}-agent-outputs-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "executionId"
  range_key      = "agentType"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

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

  tags = var.tags
}

resource "aws_dynamodb_table" "agent_pool" {
  name           = "${var.project_name}-agent-pool-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "workerId"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

  attribute {
    name = "workerId"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  global_secondary_index {
    name            = "StatusIndex"
    projection_type = "ALL"
    read_capacity   = local.read_capacity
    write_capacity  = local.write_capacity

    key_schema {
      attribute_name = "status"
      key_type       = "HASH"
    }
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
  name           = "${var.project_name}-blocks-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "pk"
  range_key      = "sk"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

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

  tags = var.tags
}

# Per-user composite read cursors: {lastReadAt,
# lastReadMessageId, sprintId}. High-churn per-user KV — wrong shape for the
# graph.
resource "aws_dynamodb_table" "discussion_read_state" {
  name           = "${var.project_name}-discussion-read-state-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "userId"
  range_key      = "discussionId"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "discussionId"
    type = "S"
  }

  tags = var.tags
}
