# Note: Uses local.dns_suffix from routes.tf (same module)
#
# The agents lambda is the v1 agent HISTORY + admin surface. The v1 execution
# engine (ECS pool dispatch) was removed when v2 became the only runtime:
# v1 projects are read-only. What remains:
#   - GET  /projects/{projectId}/agents        — sprint agent status (read)
#   - GET  /projects/{projectId}/agents/tasks  — per-task agent statuses (read)
#   - GET  /agents/{taskId}                    — execution status/output (read)
#   - GET  /agents/{taskId}/questions          — recorded agent questions (read)
#   - GET  /agents/capabilities                — CLI/model discovery (v2 model
#     picker; probes the AgentCore runtime and refreshes model-pricing SSM)
#   - GET/PUT /agents/settings                 — Admin CLI auth + model defaults
#     (SSM parameters consumed by the v2 AgentCore runtime and intents lambda)

# Agents Lambda
module "agents_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-agents-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30

  source_path = [
    {
      path             = "${path.module}/../../../lambda/agents"
      npm_requirements = true
    },
    {
      path          = "${path.module}/../../../lambda/shared"
      prefix_in_zip = "shared"
    }
  ]

  create_role = false
  lambda_role = var.agents_lambda_role_arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = var.lambda_security_group_ids

  environment_variables = {
    QUESTIONS_TABLE           = var.agent_questions_table_name
    NEPTUNE_ENDPOINT          = var.neptune_endpoint
    AGENT_OUTPUTS_TABLE       = var.agent_outputs_table_name
    AGENT_SETTINGS_SSM_PREFIX = "/${var.project_name}/${var.environment}"
    CORS_ALLOWED_ORIGINS      = var.cors_allowed_origins
    # v2 model discovery: lets GET /agents/capabilities?models=1 invoke the
    # runtime's `capabilities` command for Kiro's model list + auth state.
    AGENTCORE_RUNTIME_ARN = var.agentcore_runtime_arn
  }
}


resource "aws_lambda_permission" "agents" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = module.agents_lambda.lambda_function_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# /projects/{projectId}/agents
resource "aws_api_gateway_resource" "project_agents" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "agents"
}

resource "aws_api_gateway_method" "project_agents_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_agents.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "project_agents_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_agents.id
  http_method             = aws_api_gateway_method.project_agents_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /projects/{projectId}/agents/tasks
resource "aws_api_gateway_resource" "project_agents_tasks" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project_agents.id
  path_part   = "tasks"
}

resource "aws_api_gateway_method" "project_agents_tasks_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_agents_tasks.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "project_agents_tasks_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_agents_tasks.id
  http_method             = aws_api_gateway_method.project_agents_tasks_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /agents resource
resource "aws_api_gateway_resource" "agents_root" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "agents"
}

# /agents/{taskId}
resource "aws_api_gateway_resource" "agent_task" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agents_root.id
  path_part   = "{taskId}"
}

resource "aws_api_gateway_method" "agent_task_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_task.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_task_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_task.id
  http_method             = aws_api_gateway_method.agent_task_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /agents/{taskId}/questions
resource "aws_api_gateway_resource" "agent_questions" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agent_task.id
  path_part   = "questions"
}

resource "aws_api_gateway_method" "agent_questions_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_questions.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_questions_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_questions.id
  http_method             = aws_api_gateway_method.agent_questions_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /agents/capabilities
resource "aws_api_gateway_resource" "agent_capabilities" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agents_root.id
  path_part   = "capabilities"
}

resource "aws_api_gateway_method" "agent_capabilities_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_capabilities.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_capabilities_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_capabilities.id
  http_method             = aws_api_gateway_method.agent_capabilities_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

module "cors_agent_capabilities" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_capabilities.id
}

# /agents/settings
resource "aws_api_gateway_resource" "agent_settings" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agents_root.id
  path_part   = "settings"
}

resource "aws_api_gateway_method" "agent_settings_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_settings.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_settings_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_settings.id
  http_method             = aws_api_gateway_method.agent_settings_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

resource "aws_api_gateway_method" "agent_settings_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_settings.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_settings_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_settings.id
  http_method             = aws_api_gateway_method.agent_settings_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

module "cors_agent_settings" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_settings.id
}

# CORS for agents endpoints
module "cors_project_agents_tasks" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_agents_tasks.id
}

module "cors_project_agents" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_agents.id
}

module "cors_agents_root" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agents_root.id
}

module "cors_agent_task" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_task.id
}

module "cors_agent_questions" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_questions.id
}

# ---------------------------------------------------------------------------
# State moves: these resources were previously conditional on the removed
# `enable_agents` flag (count = 1). Moving [0] → unindexed preserves the live
# API Gateway resources (and thus deployed routes) across the refactor.
# ---------------------------------------------------------------------------

moved {
  from = aws_lambda_permission.agents[0]
  to   = aws_lambda_permission.agents
}

moved {
  from = aws_api_gateway_resource.project_agents[0]
  to   = aws_api_gateway_resource.project_agents
}

moved {
  from = aws_api_gateway_method.project_agents_get[0]
  to   = aws_api_gateway_method.project_agents_get
}

moved {
  from = aws_api_gateway_integration.project_agents_get[0]
  to   = aws_api_gateway_integration.project_agents_get
}

moved {
  from = aws_api_gateway_resource.project_agents_tasks[0]
  to   = aws_api_gateway_resource.project_agents_tasks
}

moved {
  from = aws_api_gateway_method.project_agents_tasks_get[0]
  to   = aws_api_gateway_method.project_agents_tasks_get
}

moved {
  from = aws_api_gateway_integration.project_agents_tasks_get[0]
  to   = aws_api_gateway_integration.project_agents_tasks_get
}

moved {
  from = aws_api_gateway_resource.agents_root[0]
  to   = aws_api_gateway_resource.agents_root
}

moved {
  from = aws_api_gateway_resource.agent_task[0]
  to   = aws_api_gateway_resource.agent_task
}

moved {
  from = aws_api_gateway_method.agent_task_get[0]
  to   = aws_api_gateway_method.agent_task_get
}

moved {
  from = aws_api_gateway_integration.agent_task_get[0]
  to   = aws_api_gateway_integration.agent_task_get
}

moved {
  from = aws_api_gateway_resource.agent_questions[0]
  to   = aws_api_gateway_resource.agent_questions
}

moved {
  from = aws_api_gateway_method.agent_questions_get[0]
  to   = aws_api_gateway_method.agent_questions_get
}

moved {
  from = aws_api_gateway_integration.agent_questions_get[0]
  to   = aws_api_gateway_integration.agent_questions_get
}

moved {
  from = aws_api_gateway_resource.agent_capabilities[0]
  to   = aws_api_gateway_resource.agent_capabilities
}

moved {
  from = aws_api_gateway_method.agent_capabilities_get[0]
  to   = aws_api_gateway_method.agent_capabilities_get
}

moved {
  from = aws_api_gateway_integration.agent_capabilities_get[0]
  to   = aws_api_gateway_integration.agent_capabilities_get
}

moved {
  from = module.cors_agent_capabilities[0]
  to   = module.cors_agent_capabilities
}

moved {
  from = aws_api_gateway_resource.agent_settings[0]
  to   = aws_api_gateway_resource.agent_settings
}

moved {
  from = aws_api_gateway_method.agent_settings_get[0]
  to   = aws_api_gateway_method.agent_settings_get
}

moved {
  from = aws_api_gateway_integration.agent_settings_get[0]
  to   = aws_api_gateway_integration.agent_settings_get
}

moved {
  from = aws_api_gateway_method.agent_settings_put[0]
  to   = aws_api_gateway_method.agent_settings_put
}

moved {
  from = aws_api_gateway_integration.agent_settings_put[0]
  to   = aws_api_gateway_integration.agent_settings_put
}

moved {
  from = module.cors_agent_settings[0]
  to   = module.cors_agent_settings
}

moved {
  from = module.cors_project_agents_tasks[0]
  to   = module.cors_project_agents_tasks
}

moved {
  from = module.cors_project_agents[0]
  to   = module.cors_project_agents
}

moved {
  from = module.cors_agents_root[0]
  to   = module.cors_agents_root
}

moved {
  from = module.cors_agent_task[0]
  to   = module.cors_agent_task
}

moved {
  from = module.cors_agent_questions[0]
  to   = module.cors_agent_questions
}
