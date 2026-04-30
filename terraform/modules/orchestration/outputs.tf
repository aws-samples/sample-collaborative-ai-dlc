output "state_machine_arn" {
  description = "ARN of the agent workflow state machine"
  value       = aws_sfn_state_machine.agent_workflow.arn
}

output "state_machine_name" {
  description = "Name of the agent workflow state machine"
  value       = aws_sfn_state_machine.agent_workflow.name
}

output "step_functions_role_arn" {
  description = "ARN of the Step Functions IAM role"
  value       = aws_iam_role.step_functions.arn
}

output "agent_answers_queue_url" {
  description = "URL of the agent answers SQS queue"
  value       = aws_sqs_queue.agent_answers.url
}

output "agent_answers_queue_arn" {
  description = "ARN of the agent answers SQS queue"
  value       = aws_sqs_queue.agent_answers.arn
}

output "answer_question_lambda_arn" {
  description = "ARN of the answer question Lambda"
  value       = module.answer_question_lambda.lambda_function_arn
}

output "create_pr_lambda_arn" {
  description = "ARN of the create PR Lambda"
  value       = module.create_pr_lambda.lambda_function_arn
}

output "create_pr_lambda_name" {
  description = "Name of the create PR Lambda"
  value       = module.create_pr_lambda.lambda_function_name
}
