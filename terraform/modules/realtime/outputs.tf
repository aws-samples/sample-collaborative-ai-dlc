output "websocket_api_id" {
  description = "ID of the WebSocket API"
  value       = aws_apigatewayv2_api.websocket.id
}

output "websocket_api_endpoint" {
  description = "WebSocket API endpoint URL"
  value       = aws_apigatewayv2_stage.main.invoke_url
}

output "websocket_execution_arn" {
  description = "Execution ARN of the WebSocket API"
  value       = aws_apigatewayv2_api.websocket.execution_arn
}

output "connection_lambda_arn" {
  description = "ARN of the connection Lambda"
  value       = module.connection_lambda.lambda_function_arn
}

output "message_lambda_arn" {
  description = "ARN of the message Lambda"
  value       = module.message_lambda.lambda_function_arn
}
