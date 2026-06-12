# Note: Uses local.dns_suffix from routes.tf (same module)

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
    ECS_CLUSTER_ARN           = var.ecs_cluster_arn
    AGENT_TASK_DEFINITION_ARN = var.agent_task_definition_arn
    POOL_TABLE                = var.agent_pool_table_name
    POOL_SIZE                 = tostring(var.pool_size)
    POOL_VERSION              = var.agent_image_tag
    PRIVATE_SUBNET_IDS        = jsonencode(var.private_subnet_ids)
    AGENT_SECURITY_GROUP_ID   = var.agent_security_group_id
    QUESTIONS_TABLE           = var.agent_questions_table_name
    NEPTUNE_ENDPOINT          = var.neptune_endpoint
    AGENT_OUTPUTS_TABLE       = var.agent_outputs_table_name
    GIT_CONNECTIONS_TABLE     = var.git_connections_table_name
    AGENT_SETTINGS_SSM_PREFIX = "/${var.project_name}/${var.environment}"
    CORS_ALLOWED_ORIGINS      = var.cors_allowed_origins
    # Server-origin question.answered fanout: the agents lambda pushes the
    # event to sprint-channel WS connections.
    CONNECTIONS_TABLE  = var.connections_table_name
    WEBSOCKET_ENDPOINT = var.websocket_api_endpoint_https
  }
}


resource "aws_lambda_permission" "agents" {
  count         = var.enable_agents ? 1 : 0
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = module.agents_lambda.lambda_function_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# /projects/{projectId}/agents
resource "aws_api_gateway_resource" "project_agents" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "agents"
}

resource "aws_api_gateway_method" "project_agents_post" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_agents[0].id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "project_agents_post" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_agents[0].id
  http_method             = aws_api_gateway_method.project_agents_post[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

resource "aws_api_gateway_method" "project_agents_get" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_agents[0].id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "project_agents_get" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_agents[0].id
  http_method             = aws_api_gateway_method.project_agents_get[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /projects/{projectId}/agents/tasks
resource "aws_api_gateway_resource" "project_agents_tasks" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project_agents[0].id
  path_part   = "tasks"
}

resource "aws_api_gateway_method" "project_agents_tasks_get" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_agents_tasks[0].id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "project_agents_tasks_get" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_agents_tasks[0].id
  http_method             = aws_api_gateway_method.project_agents_tasks_get[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /agents resource
resource "aws_api_gateway_resource" "agents_root" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "agents"
}

# /agents/{taskId}
resource "aws_api_gateway_resource" "agent_task" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agents_root[0].id
  path_part   = "{taskId}"
}

resource "aws_api_gateway_method" "agent_task_get" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_task[0].id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_task_get" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_task[0].id
  http_method             = aws_api_gateway_method.agent_task_get[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

resource "aws_api_gateway_method" "agent_task_delete" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_task[0].id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_task_delete" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_task[0].id
  http_method             = aws_api_gateway_method.agent_task_delete[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /agents/{taskId}/questions
resource "aws_api_gateway_resource" "agent_questions" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agent_task[0].id
  path_part   = "questions"
}

resource "aws_api_gateway_method" "agent_questions_get" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_questions[0].id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_questions_get" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_questions[0].id
  http_method             = aws_api_gateway_method.agent_questions_get[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /agents/{taskId}/questions/{questionId}
resource "aws_api_gateway_resource" "agent_question" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agent_questions[0].id
  path_part   = "{questionId}"
}

# /agents/{taskId}/questions/{questionId}/answer
resource "aws_api_gateway_resource" "agent_question_answer" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agent_question[0].id
  path_part   = "answer"
}

resource "aws_api_gateway_method" "agent_question_answer_post" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_question_answer[0].id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_question_answer_post" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_question_answer[0].id
  http_method             = aws_api_gateway_method.agent_question_answer_post[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /agents/capabilities
resource "aws_api_gateway_resource" "agent_capabilities" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agents_root[0].id
  path_part   = "capabilities"
}

resource "aws_api_gateway_method" "agent_capabilities_get" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_capabilities[0].id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_capabilities_get" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_capabilities[0].id
  http_method             = aws_api_gateway_method.agent_capabilities_get[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

module "cors_agent_capabilities" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_capabilities[0].id
}

# /agents/settings
resource "aws_api_gateway_resource" "agent_settings" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agents_root[0].id
  path_part   = "settings"
}

resource "aws_api_gateway_method" "agent_settings_get" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_settings[0].id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_settings_get" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_settings[0].id
  http_method             = aws_api_gateway_method.agent_settings_get[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

resource "aws_api_gateway_method" "agent_settings_put" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_settings[0].id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_settings_put" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_settings[0].id
  http_method             = aws_api_gateway_method.agent_settings_put[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

module "cors_agent_settings" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_settings[0].id
}

# /agents/pool
resource "aws_api_gateway_resource" "agent_pool" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agents_root[0].id
  path_part   = "pool"
}

resource "aws_api_gateway_method" "agent_pool_get" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_pool[0].id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_pool_get" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_pool[0].id
  http_method             = aws_api_gateway_method.agent_pool_get[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /agents/pool/recycle
resource "aws_api_gateway_resource" "agent_pool_recycle" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agent_pool[0].id
  path_part   = "recycle"
}

resource "aws_api_gateway_method" "agent_pool_recycle_post" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_pool_recycle[0].id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_pool_recycle_post" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_pool_recycle[0].id
  http_method             = aws_api_gateway_method.agent_pool_recycle_post[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /agents/pool/warm
resource "aws_api_gateway_resource" "agent_pool_warm" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agent_pool[0].id
  path_part   = "warm"
}

resource "aws_api_gateway_method" "agent_pool_warm_post" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_pool_warm[0].id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_pool_warm_post" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_pool_warm[0].id
  http_method             = aws_api_gateway_method.agent_pool_warm_post[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}

# /agents/pool/{workerId}
resource "aws_api_gateway_resource" "agent_pool_worker" {
  count       = var.enable_agents ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.agent_pool[0].id
  path_part   = "{workerId}"
}

resource "aws_api_gateway_method" "agent_pool_worker_delete" {
  count         = var.enable_agents ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.agent_pool_worker[0].id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "agent_pool_worker_delete" {
  count                   = var.enable_agents ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.agent_pool_worker[0].id
  http_method             = aws_api_gateway_method.agent_pool_worker_delete[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.agents_lambda.lambda_function_invoke_arn
}


# CORS for agents endpoints
module "cors_project_agents_tasks" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_agents_tasks[0].id
}

module "cors_project_agents" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_agents[0].id
}

module "cors_agents_root" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agents_root[0].id
}

module "cors_agent_task" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_task[0].id
}

module "cors_agent_questions" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_questions[0].id
}

module "cors_agent_question_answer" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_question_answer[0].id
}

module "cors_agent_pool_recycle" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_pool_recycle[0].id
}

module "cors_agent_pool" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_pool[0].id
}

module "cors_agent_pool_warm" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_pool_warm[0].id
}

module "cors_agent_pool_worker" {
  count       = var.enable_agents ? 1 : 0
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.agent_pool_worker[0].id
}
