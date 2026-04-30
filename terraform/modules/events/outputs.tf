output "event_bus_name" {
  description = "Name of the agent event bus"
  value       = aws_cloudwatch_event_bus.agents.name
}

output "event_bus_arn" {
  description = "ARN of the agent event bus"
  value       = aws_cloudwatch_event_bus.agents.arn
}

output "notify_lambda_arn" {
  description = "ARN of the notification Lambda"
  value       = module.notify_lambda.lambda_function_arn
}
