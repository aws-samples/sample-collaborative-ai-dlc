# =============================================================================
# Partition-Aware Data Sources
# =============================================================================
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  dns_suffix = data.aws_partition.current.dns_suffix
}

# =============================================================================
# API Routes Configuration
# =============================================================================

# -----------------------------------------------------------------------------
# /users Resource (top-level - list Cognito users)
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "cognito_users" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "users"
}

# -----------------------------------------------------------------------------
# /projects Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "projects" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "projects"
}

resource "aws_api_gateway_resource" "project" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.projects.id
  path_part   = "{projectId}"
}

# -----------------------------------------------------------------------------
# /projects/{projectId}/members Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "members" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "members"
}

resource "aws_api_gateway_resource" "member" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.members.id
  path_part   = "{userId}"
}

# -----------------------------------------------------------------------------
# /projects/{projectId}/mcp-servers Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "project_mcp_servers" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "mcp-servers"
}

# -----------------------------------------------------------------------------
# /projects/{projectId}/steering-docs Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "project_steering_docs" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "steering-docs"
}

# -----------------------------------------------------------------------------
# /sprints/{sprintId}/tasks/{taskId}/config Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "task_config" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.task.id
  path_part   = "config"
}

# -----------------------------------------------------------------------------
# /projects/{projectId}/sprints Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "sprints" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "sprints"
}

resource "aws_api_gateway_resource" "sprint" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprints.id
  path_part   = "{sprintId}"
}

# -----------------------------------------------------------------------------
# /sprints Resource (top-level for sprint-scoped entities)
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "sprints_root" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "sprints"
}

resource "aws_api_gateway_resource" "sprint_root" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprints_root.id
  path_part   = "{sprintId}"
}

# /sprints/{sprintId}/requirements
resource "aws_api_gateway_resource" "requirements" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "requirements"
}
resource "aws_api_gateway_resource" "requirement" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.requirements.id
  path_part   = "{requirementId}"
}

# /sprints/{sprintId}/user-stories
resource "aws_api_gateway_resource" "user_stories" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "user-stories"
}
resource "aws_api_gateway_resource" "user_story" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.user_stories.id
  path_part   = "{storyId}"
}

# /sprints/{sprintId}/tasks
resource "aws_api_gateway_resource" "tasks" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "tasks"
}
resource "aws_api_gateway_resource" "task" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.tasks.id
  path_part   = "{taskId}"
}

# /sprints/{sprintId}/general-info
resource "aws_api_gateway_resource" "general_info" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "general-info"
}
resource "aws_api_gateway_resource" "general_info_item" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.general_info.id
  path_part   = "{infoId}"
}

# /sprints/{sprintId}/code-files
resource "aws_api_gateway_resource" "code_files" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "code-files"
}
resource "aws_api_gateway_resource" "code_file" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.code_files.id
  path_part   = "{codeFileId}"
}

# /sprints/{sprintId}/review
resource "aws_api_gateway_resource" "review" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "review"
}

# /sprints/{sprintId}/questions
resource "aws_api_gateway_resource" "questions" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "questions"
}
resource "aws_api_gateway_resource" "question" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.questions.id
  path_part   = "{questionId}"
}

# /sprints/{sprintId}/graph
resource "aws_api_gateway_resource" "sprint_graph" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "graph"
}

# =============================================================================
# Projects Methods (GET list, POST create)
# =============================================================================
resource "aws_api_gateway_method" "projects_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.projects.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_method" "projects_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.projects.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "projects_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.projects.id
  http_method             = aws_api_gateway_method.projects_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "projects_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.projects.id
  http_method             = aws_api_gateway_method.projects_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

# =============================================================================
# Project Methods (GET, PUT, DELETE single project)
# =============================================================================
resource "aws_api_gateway_method" "project_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "project_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "project_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "project_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project.id
  http_method             = aws_api_gateway_method.project_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "project_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project.id
  http_method             = aws_api_gateway_method.project_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "project_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project.id
  http_method             = aws_api_gateway_method.project_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

# =============================================================================
# Members Methods (GET list, POST invite)
# =============================================================================
resource "aws_api_gateway_method" "members_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.members.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "members_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.members.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "members_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.members.id
  http_method             = aws_api_gateway_method.members_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.users_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "members_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.members.id
  http_method             = aws_api_gateway_method.members_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.users_lambda_invoke_arn
}

# =============================================================================
# Member Methods (PUT update role, DELETE remove)
# =============================================================================
resource "aws_api_gateway_method" "member_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.member.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
    "method.request.path.userId"    = true
  }
}

resource "aws_api_gateway_method" "member_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.member.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
    "method.request.path.userId"    = true
  }
}

resource "aws_api_gateway_integration" "member_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.member.id
  http_method             = aws_api_gateway_method.member_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.users_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "member_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.member.id
  http_method             = aws_api_gateway_method.member_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.users_lambda_invoke_arn
}

# =============================================================================
# Project MCP Servers Methods (GET, PUT)
# /projects/{projectId}/mcp-servers
# =============================================================================
resource "aws_api_gateway_method" "project_mcp_servers_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_mcp_servers.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = { "method.request.path.projectId" = true }
}

resource "aws_api_gateway_method" "project_mcp_servers_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_mcp_servers.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = { "method.request.path.projectId" = true }
}

resource "aws_api_gateway_integration" "project_mcp_servers_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_mcp_servers.id
  http_method             = aws_api_gateway_method.project_mcp_servers_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "project_mcp_servers_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_mcp_servers.id
  http_method             = aws_api_gateway_method.project_mcp_servers_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

# =============================================================================
# Project Steering Docs Methods (GET, PUT)
# /projects/{projectId}/steering-docs
# =============================================================================
resource "aws_api_gateway_method" "project_steering_docs_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_steering_docs.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = { "method.request.path.projectId" = true }
}

resource "aws_api_gateway_method" "project_steering_docs_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_steering_docs.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = { "method.request.path.projectId" = true }
}

resource "aws_api_gateway_integration" "project_steering_docs_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_steering_docs.id
  http_method             = aws_api_gateway_method.project_steering_docs_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "project_steering_docs_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_steering_docs.id
  http_method             = aws_api_gateway_method.project_steering_docs_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

# =============================================================================
# Task Config Methods (GET, PUT)
# /sprints/{sprintId}/tasks/{taskId}/config
# =============================================================================
resource "aws_api_gateway_method" "task_config_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.task_config.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.sprintId" = true
    "method.request.path.taskId"   = true
  }
}

resource "aws_api_gateway_method" "task_config_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.task_config.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.sprintId" = true
    "method.request.path.taskId"   = true
  }
}

resource "aws_api_gateway_integration" "task_config_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.task_config.id
  http_method             = aws_api_gateway_method.task_config_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.tasks_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "task_config_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.task_config.id
  http_method             = aws_api_gateway_method.task_config_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.tasks_lambda_invoke_arn
}

# =============================================================================
# Sprints Methods (nested under project)
# =============================================================================
resource "aws_api_gateway_method" "sprints_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprints.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.projectId" = true }
}
resource "aws_api_gateway_method" "sprints_post" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprints.id
  http_method        = "POST"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.projectId" = true }
}
resource "aws_api_gateway_method" "sprint_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprint.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.projectId" = true, "method.request.path.sprintId" = true }
}
resource "aws_api_gateway_method" "sprint_put" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprint.id
  http_method        = "PUT"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.projectId" = true, "method.request.path.sprintId" = true }
}
resource "aws_api_gateway_method" "sprint_delete" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprint.id
  http_method        = "DELETE"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.projectId" = true, "method.request.path.sprintId" = true }
}

resource "aws_api_gateway_integration" "sprints_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprints.id
  http_method             = aws_api_gateway_method.sprints_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.sprints_lambda_invoke_arn
}
resource "aws_api_gateway_integration" "sprints_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprints.id
  http_method             = aws_api_gateway_method.sprints_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.sprints_lambda_invoke_arn
}
resource "aws_api_gateway_integration" "sprint_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprint.id
  http_method             = aws_api_gateway_method.sprint_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.sprints_lambda_invoke_arn
}
resource "aws_api_gateway_integration" "sprint_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprint.id
  http_method             = aws_api_gateway_method.sprint_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.sprints_lambda_invoke_arn
}
resource "aws_api_gateway_integration" "sprint_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprint.id
  http_method             = aws_api_gateway_method.sprint_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.sprints_lambda_invoke_arn
}

# /sprints/{sprintId}/timeline-events
resource "aws_api_gateway_resource" "timeline_events" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "timeline-events"
}

# =============================================================================
# Helper locals for sprint-scoped CRUD pattern
# =============================================================================
locals {
  sprint_entities = {
    requirements = {
      collection_resource = aws_api_gateway_resource.requirements.id
      item_resource       = aws_api_gateway_resource.requirement.id
      invoke_arn          = var.requirements_lambda_invoke_arn
      lambda_name         = var.requirements_lambda_name
      item_param          = "requirementId"
    }
    user_stories = {
      collection_resource = aws_api_gateway_resource.user_stories.id
      item_resource       = aws_api_gateway_resource.user_story.id
      invoke_arn          = var.user_stories_lambda_invoke_arn
      lambda_name         = var.user_stories_lambda_name
      item_param          = "storyId"
    }
    tasks = {
      collection_resource = aws_api_gateway_resource.tasks.id
      item_resource       = aws_api_gateway_resource.task.id
      invoke_arn          = var.tasks_lambda_invoke_arn
      lambda_name         = var.tasks_lambda_name
      item_param          = "taskId"
    }
    general_info = {
      collection_resource = aws_api_gateway_resource.general_info.id
      item_resource       = aws_api_gateway_resource.general_info_item.id
      invoke_arn          = var.general_info_lambda_invoke_arn
      lambda_name         = var.general_info_lambda_name
      item_param          = "infoId"
    }
    code_files = {
      collection_resource = aws_api_gateway_resource.code_files.id
      item_resource       = aws_api_gateway_resource.code_file.id
      invoke_arn          = var.code_files_lambda_invoke_arn
      lambda_name         = var.code_files_lambda_name
      item_param          = "codeFileId"
    }
    questions = {
      collection_resource = aws_api_gateway_resource.questions.id
      item_resource       = aws_api_gateway_resource.question.id
      invoke_arn          = var.questions_lambda_invoke_arn
      lambda_name         = var.questions_lambda_name
      item_param          = "questionId"
    }
  }
}

# =============================================================================
# Sprint-scoped entity CRUD (collection: GET, POST)
# =============================================================================
resource "aws_api_gateway_method" "entity_collection_get" {
  for_each           = local.sprint_entities
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = each.value.collection_resource
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}

resource "aws_api_gateway_method" "entity_collection_post" {
  for_each           = local.sprint_entities
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = each.value.collection_resource
  http_method        = "POST"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}

resource "aws_api_gateway_integration" "entity_collection_get" {
  for_each                = local.sprint_entities
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.collection_resource
  http_method             = aws_api_gateway_method.entity_collection_get[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = each.value.invoke_arn
}

resource "aws_api_gateway_integration" "entity_collection_post" {
  for_each                = local.sprint_entities
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.collection_resource
  http_method             = aws_api_gateway_method.entity_collection_post[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = each.value.invoke_arn
}

# =============================================================================
# Sprint-scoped entity CRUD (item: GET, PUT, DELETE)
# =============================================================================
resource "aws_api_gateway_method" "entity_item_get" {
  for_each           = local.sprint_entities
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = each.value.item_resource
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true, "method.request.path.${each.value.item_param}" = true }
}

resource "aws_api_gateway_method" "entity_item_put" {
  for_each           = local.sprint_entities
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = each.value.item_resource
  http_method        = "PUT"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true, "method.request.path.${each.value.item_param}" = true }
}

resource "aws_api_gateway_method" "entity_item_delete" {
  for_each           = local.sprint_entities
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = each.value.item_resource
  http_method        = "DELETE"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true, "method.request.path.${each.value.item_param}" = true }
}

resource "aws_api_gateway_integration" "entity_item_get" {
  for_each                = local.sprint_entities
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.item_resource
  http_method             = aws_api_gateway_method.entity_item_get[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = each.value.invoke_arn
}

resource "aws_api_gateway_integration" "entity_item_put" {
  for_each                = local.sprint_entities
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.item_resource
  http_method             = aws_api_gateway_method.entity_item_put[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = each.value.invoke_arn
}

resource "aws_api_gateway_integration" "entity_item_delete" {
  for_each                = local.sprint_entities
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.item_resource
  http_method             = aws_api_gateway_method.entity_item_delete[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = each.value.invoke_arn
}

# =============================================================================
# Review Methods (singleton per sprint: GET, POST, PUT)
# =============================================================================
resource "aws_api_gateway_method" "review_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.review.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}
resource "aws_api_gateway_method" "review_post" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.review.id
  http_method        = "POST"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}
resource "aws_api_gateway_method" "review_put" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.review.id
  http_method        = "PUT"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}

resource "aws_api_gateway_integration" "review_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.review.id
  http_method             = aws_api_gateway_method.review_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.reviews_lambda_invoke_arn
}
resource "aws_api_gateway_integration" "review_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.review.id
  http_method             = aws_api_gateway_method.review_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.reviews_lambda_invoke_arn
}
resource "aws_api_gateway_integration" "review_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.review.id
  http_method             = aws_api_gateway_method.review_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.reviews_lambda_invoke_arn
}

# =============================================================================
# Sprint Graph (GET only)
# =============================================================================
resource "aws_api_gateway_method" "sprint_graph_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprint_graph.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}
resource "aws_api_gateway_integration" "sprint_graph_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprint_graph.id
  http_method             = aws_api_gateway_method.sprint_graph_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.sprint_graph_lambda_invoke_arn
}

# =============================================================================
# Timeline Events Methods (GET list, POST create)
# =============================================================================
resource "aws_api_gateway_method" "timeline_events_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.timeline_events.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}
resource "aws_api_gateway_method" "timeline_events_post" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.timeline_events.id
  http_method        = "POST"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}

resource "aws_api_gateway_integration" "timeline_events_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.timeline_events.id
  http_method             = aws_api_gateway_method.timeline_events_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.timeline_events_lambda_invoke_arn
}
resource "aws_api_gateway_integration" "timeline_events_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.timeline_events.id
  http_method             = aws_api_gateway_method.timeline_events_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.timeline_events_lambda_invoke_arn
}

# =============================================================================
# CORS OPTIONS Methods for all resources
# =============================================================================
module "cors_projects" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.projects.id
}

module "cors_project" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project.id
}

module "cors_members" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.members.id
}

module "cors_member" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.member.id
}

module "cors_project_mcp_servers" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_mcp_servers.id
}

module "cors_project_steering_docs" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_steering_docs.id
}

module "cors_task_config" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.task_config.id
}

module "cors_sprints" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.sprints.id
}
module "cors_sprint" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.sprint.id
}
module "cors_requirements" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.requirements.id
}
module "cors_requirement" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.requirement.id
}
module "cors_user_stories" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.user_stories.id
}
module "cors_user_story" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.user_story.id
}
module "cors_tasks" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.tasks.id
}
module "cors_task" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.task.id
}
module "cors_general_info" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.general_info.id
}
module "cors_general_info_item" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.general_info_item.id
}
module "cors_code_files" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.code_files.id
}
module "cors_code_file" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.code_file.id
}
module "cors_review" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.review.id
}
module "cors_questions" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.questions.id
}
module "cors_question" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.question.id
}
module "cors_sprint_graph" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.sprint_graph.id
}
module "cors_timeline_events" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.timeline_events.id
}

# =============================================================================
# Lambda Permissions
# =============================================================================
resource "aws_lambda_permission" "projects" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.projects_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "users" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.users_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "sprints" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.sprints_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "entity_lambdas" {
  for_each      = local.sprint_entities
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value.lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "reviews" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.reviews_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "sprint_graph" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.sprint_graph_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "timeline_events" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.timeline_events_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}


# =============================================================================
# GitHub OAuth Routes
# =============================================================================

# -----------------------------------------------------------------------------
# /github Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "github" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "github"
}

resource "aws_api_gateway_resource" "github_auth" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "auth"
}

resource "aws_api_gateway_resource" "github_callback" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "callback"
}

resource "aws_api_gateway_resource" "github_repos" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "repos"
}

resource "aws_api_gateway_resource" "github_status" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "status"
}

resource "aws_api_gateway_resource" "github_disconnect" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "disconnect"
}

# /github/repos/{owner}
resource "aws_api_gateway_resource" "github_repos_owner" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos.id
  path_part   = "{owner}"
}

# /github/repos/{owner}/{repo}
resource "aws_api_gateway_resource" "github_repos_owner_repo" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner.id
  path_part   = "{repo}"
}

# /github/repos/{owner}/{repo}/branches
resource "aws_api_gateway_resource" "github_repos_branches" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner_repo.id
  path_part   = "branches"
}

# /github/repos/{owner}/{repo}/tree
resource "aws_api_gateway_resource" "github_repos_tree" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner_repo.id
  path_part   = "tree"
}

# /github/repos/{owner}/{repo}/contents
resource "aws_api_gateway_resource" "github_repos_contents" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner_repo.id
  path_part   = "contents"
}

# -----------------------------------------------------------------------------
# GitHub Methods
# -----------------------------------------------------------------------------

# GET /github/auth (authenticated)
resource "aws_api_gateway_method" "github_auth_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_auth.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_auth_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_auth.id
  http_method             = aws_api_gateway_method.github_auth_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/callback (no auth - OAuth redirect)
resource "aws_api_gateway_method" "github_callback_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_callback.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "github_callback_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_callback.id
  http_method             = aws_api_gateway_method.github_callback_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/repos (authenticated)
resource "aws_api_gateway_method" "github_repos_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos.id
  http_method             = aws_api_gateway_method.github_repos_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/status (authenticated)
resource "aws_api_gateway_method" "github_status_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_status.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_status_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_status.id
  http_method             = aws_api_gateway_method.github_status_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# DELETE /github/disconnect (authenticated)
resource "aws_api_gateway_method" "github_disconnect_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_disconnect.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_disconnect_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_disconnect.id
  http_method             = aws_api_gateway_method.github_disconnect_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/repos/{owner}/{repo}/branches (authenticated)
resource "aws_api_gateway_method" "github_repos_branches_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_branches.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_branches_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_branches.id
  http_method             = aws_api_gateway_method.github_repos_branches_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/repos/{owner}/{repo}/tree (authenticated)
resource "aws_api_gateway_method" "github_repos_tree_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_tree.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_tree_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_tree.id
  http_method             = aws_api_gateway_method.github_repos_tree_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/repos/{owner}/{repo}/contents (authenticated)
resource "aws_api_gateway_method" "github_repos_contents_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_contents.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_contents_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_contents.id
  http_method             = aws_api_gateway_method.github_repos_contents_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# -----------------------------------------------------------------------------
# GitHub CORS
# -----------------------------------------------------------------------------
module "cors_github_auth" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_auth.id
}

module "cors_github_callback" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_callback.id
}

module "cors_github_repos" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos.id
}

module "cors_github_status" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_status.id
}

module "cors_github_disconnect" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_disconnect.id
}

module "cors_github_repos_branches" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_branches.id
}

module "cors_github_repos_tree" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_tree.id
}

module "cors_github_repos_contents" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_contents.id
}

# /github/repos/{owner}/{repo}/pulls
resource "aws_api_gateway_resource" "github_repos_pulls" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner_repo.id
  path_part   = "pulls"
}

# /github/repos/{owner}/{repo}/pulls/{prNumber}
resource "aws_api_gateway_resource" "github_repos_pulls_number" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_pulls.id
  path_part   = "{prNumber}"
}

# /github/repos/{owner}/{repo}/pulls/{prNumber}/comments
resource "aws_api_gateway_resource" "github_repos_pulls_comments" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_pulls_number.id
  path_part   = "comments"
}

# GET /github/repos/{owner}/{repo}/pulls/{prNumber}/comments (authenticated)
resource "aws_api_gateway_method" "github_pulls_comments_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_pulls_comments.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_pulls_comments_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_pulls_comments.id
  http_method             = aws_api_gateway_method.github_pulls_comments_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# POST /github/repos/{owner}/{repo}/pulls/{prNumber}/comments (authenticated)
resource "aws_api_gateway_method" "github_pulls_comments_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_pulls_comments.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_pulls_comments_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_pulls_comments.id
  http_method             = aws_api_gateway_method.github_pulls_comments_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

module "cors_github_repos_pulls_comments" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_pulls_comments.id
}

# -----------------------------------------------------------------------------
# GitHub Lambda Permission
# -----------------------------------------------------------------------------
resource "aws_lambda_permission" "github" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.github_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# -----------------------------------------------------------------------------
# /github/repos/{owner}/{repo}/issues — backed by github-issues lambda
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "github_repos_issues" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner_repo.id
  path_part   = "issues"
}

resource "aws_api_gateway_resource" "github_repos_issues_number" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_issues.id
  path_part   = "{issueNumber}"
}

# GET /github/repos/{owner}/{repo}/issues
resource "aws_api_gateway_method" "github_repos_issues_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_issues.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_issues_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_issues.id
  http_method             = aws_api_gateway_method.github_repos_issues_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_issues_lambda_invoke_arn
}

# GET /github/repos/{owner}/{repo}/issues/{issueNumber}
resource "aws_api_gateway_method" "github_repos_issues_number_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_issues_number.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_issues_number_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_issues_number.id
  http_method             = aws_api_gateway_method.github_repos_issues_number_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_issues_lambda_invoke_arn
}

module "cors_github_repos_issues" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_issues.id
}

module "cors_github_repos_issues_number" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_issues_number.id
}

# /github/repos/{owner}/{repo}/issues/{issueNumber}/comments
resource "aws_api_gateway_resource" "github_repos_issues_number_comments" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_issues_number.id
  path_part   = "comments"
}

resource "aws_api_gateway_method" "github_repos_issues_number_comments_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_issues_number_comments.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_issues_number_comments_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_issues_number_comments.id
  http_method             = aws_api_gateway_method.github_repos_issues_number_comments_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_issues_lambda_invoke_arn
}

module "cors_github_repos_issues_number_comments" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_issues_number_comments.id
}

resource "aws_lambda_permission" "github_issues" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.github_issues_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# =============================================================================
# Cognito Users (GET /users - list all Cognito users)
# =============================================================================
resource "aws_api_gateway_method" "cognito_users_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.cognito_users.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "cognito_users_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.cognito_users.id
  http_method             = aws_api_gateway_method.cognito_users_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.cognito_users_lambda_invoke_arn
}

module "cors_cognito_users" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.cognito_users.id
}

resource "aws_lambda_permission" "cognito_users" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.cognito_users_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}
