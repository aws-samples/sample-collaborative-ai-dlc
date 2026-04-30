output "submit_question_lambda_arn" {
  description = "ARN of the submit question Lambda"
  value       = module.submit_question_lambda.lambda_function_arn
}

output "submit_question_lambda_name" {
  description = "Name of the submit question Lambda"
  value       = module.submit_question_lambda.lambda_function_name
}

output "submit_question_role_arn" {
  description = "ARN of the submit question Lambda role"
  value       = aws_iam_role.submit_question.arn
}
