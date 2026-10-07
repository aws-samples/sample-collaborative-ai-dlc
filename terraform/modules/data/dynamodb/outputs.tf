output "sessions_table_name" {
  description = "Name of the sessions table"
  value       = aws_dynamodb_table.sessions.name
}

output "sessions_table_arn" {
  description = "ARN of the sessions table"
  value       = aws_dynamodb_table.sessions.arn
}

output "notifications_table_name" {
  description = "Name of the notifications table"
  value       = aws_dynamodb_table.notifications.name
}

output "notifications_table_arn" {
  description = "ARN of the notifications table"
  value       = aws_dynamodb_table.notifications.arn
}

output "notifications_source_index_name" {
  description = "Sparse GSI on sourceKey used to resolve every inbox item raised by one source"
  value       = local.notifications_source_index
}

output "notifications_digest_index_name" {
  description = "Sparse GSI on digestBucket used by the morning digest"
  value       = local.notifications_digest_index
}

output "preferences_table_name" {
  description = "Name of the namespaced preferences table"
  value       = aws_dynamodb_table.preferences.name
}

output "preferences_table_arn" {
  description = "ARN of the namespaced preferences table"
  value       = aws_dynamodb_table.preferences.arn
}

output "agent_questions_table_name" {
  description = "Name of the agent questions table"
  value       = aws_dynamodb_table.agent_questions.name
}

output "agent_questions_table_arn" {
  description = "ARN of the agent questions table"
  value       = aws_dynamodb_table.agent_questions.arn
}

output "yjs_documents_table_name" {
  description = "Name of the YJS documents table"
  value       = aws_dynamodb_table.yjs_documents.name
}

output "yjs_documents_table_arn" {
  description = "ARN of the YJS documents table"
  value       = aws_dynamodb_table.yjs_documents.arn
}

output "connections_table_name" {
  description = "Name of the WebSocket connections table"
  value       = aws_dynamodb_table.connections.name
}

output "connections_table_arn" {
  description = "ARN of the WebSocket connections table"
  value       = aws_dynamodb_table.connections.arn
}


output "agent_outputs_table_name" {
  description = "Name of the agent outputs table"
  value       = aws_dynamodb_table.agent_outputs.name
}

output "agent_outputs_table_arn" {
  description = "ARN of the agent outputs table"
  value       = aws_dynamodb_table.agent_outputs.arn
}

output "discussion_locks_table_name" {
  value = aws_dynamodb_table.discussion_locks.name
}

output "discussion_locks_table_arn" {
  value = aws_dynamodb_table.discussion_locks.arn
}

output "discussion_read_state_table_name" {
  value = aws_dynamodb_table.discussion_read_state.name
}

output "discussion_read_state_table_arn" {
  value = aws_dynamodb_table.discussion_read_state.arn
}

output "blocks_table_name" {
  description = "Name of the building-blocks table"
  value       = aws_dynamodb_table.blocks.name
}

output "blocks_table_arn" {
  description = "ARN of the building-blocks table"
  value       = aws_dynamodb_table.blocks.arn
}

output "environment_registry_table_name" {
  description = "Name of the managed environment registry table"
  value       = aws_dynamodb_table.environment_registry.name
}

output "environment_registry_table_arn" {
  description = "ARN of the managed environment registry table"
  value       = aws_dynamodb_table.environment_registry.arn
}
