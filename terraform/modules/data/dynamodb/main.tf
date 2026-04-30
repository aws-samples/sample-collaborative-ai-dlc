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
