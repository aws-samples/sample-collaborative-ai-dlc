# SQS Queue for Agent Question Answers
resource "aws_sqs_queue" "agent_answers" {
  name                       = "${var.project_name}-agent-answers-${var.environment}"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 86400
  sqs_managed_sse_enabled    = true

  tags = var.tags
}

# Lambda Execution Role for Answer Lambda
resource "aws_iam_role" "answer_lambda" {
  name = "${var.project_name}-answer-lambda-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.${local.dns_suffix}" }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "answer_lambda" {
  name = "answer-lambda-policy"
  role = aws_iam_role.answer_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = var.agent_questions_table_arn
      },
      # states:SendTaskSuccess / SendTaskFailure must use Resource = "*" per AWS IAM service
      # authorization reference — these actions do not support resource-level permissions
      # (the target task token is opaque). Scoping is achieved via the execution context:
      # only this Lambda (triggered by our SQS answer queue) can obtain a valid task token.
      {
        Effect   = "Allow"
        Action   = ["states:SendTaskSuccess", "states:SendTaskFailure"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:${local.partition}:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.agent_answers.arn
      }
    ]
  })
}

# Answer Question Lambda
module "answer_question_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-answer-question-${var.environment}"
  handler       = "answer-question.handler"
  runtime       = "nodejs24.x"

  source_path = [
    {
      path = "${path.module}/../../../lambda/answer-question"
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.answer_lambda.arn

  environment_variables = {
    QUESTIONS_TABLE = var.agent_questions_table_name
  }

  tags = var.tags
}

# SQS trigger for answer Lambda
resource "aws_lambda_event_source_mapping" "answer_queue" {
  event_source_arn = aws_sqs_queue.agent_answers.arn
  function_name    = module.answer_question_lambda.lambda_function_arn
  batch_size       = 1
}
