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

output "realtime_doc_secret_param_name" {
  description = "SSM parameter name of the realtime doc-token secret"
  value       = aws_ssm_parameter.realtime_doc_secret.name
}

output "realtime_doc_secret_param_arn" {
  description = "SSM parameter ARN of the realtime doc-token secret"
  value       = aws_ssm_parameter.realtime_doc_secret.arn
}
