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
# /projects/{projectId}/migrate-tracker Resource (issue #194)
# Per-project migration to the tracker provider abstraction. Owner/admin
# only. The bulk admin counterpart is the migrate-tracker-fields Lambda.
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "migrate_tracker" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "migrate-tracker"
}

# -----------------------------------------------------------------------------
# /admin Resource (issue #194 phase #198)
# Operator-facing routes. The migration counterpart of the per-project
# /projects/{id}/migrate-tracker route lives under /admin/tracker-migration
# so a bulk run is invokable from the Admin UI without shell access. Same
# Cognito posture as the surrounding admin-config endpoints.
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "admin" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "admin"
}

resource "aws_api_gateway_resource" "admin_tracker_migration" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.admin.id
  path_part   = "tracker-migration"
}

resource "aws_api_gateway_resource" "admin_tracker_migration_status" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.admin_tracker_migration.id
  path_part   = "status"
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
# /sprints/{sprintId}/tasks/{taskId}/mcp-servers Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "task_mcp_servers" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.task.id
  path_part   = "mcp-servers"
}

# -----------------------------------------------------------------------------
# /sprints/{sprintId}/tasks/{taskId}/steering-docs Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "task_steering_docs" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.task.id
  path_part   = "steering-docs"
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
# Migrate-Tracker Method (POST — owner/admin only)
# =============================================================================
resource "aws_api_gateway_method" "migrate_tracker_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.migrate_tracker.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "migrate_tracker_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.migrate_tracker.id
  http_method             = aws_api_gateway_method.migrate_tracker_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

# =============================================================================
# Admin Tracker-Migration Methods (issue #194 phase #198)
# Bulk counterpart of /projects/{id}/migrate-tracker. Both bound to the
# projects lambda — the shared core in lambda/shared/tracker-migration.js
# already supports both per-project and whole-graph scopes.
# =============================================================================
resource "aws_api_gateway_method" "admin_tracker_migration_status_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.admin_tracker_migration_status.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "admin_tracker_migration_status_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.admin_tracker_migration_status.id
  http_method             = aws_api_gateway_method.admin_tracker_migration_status_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_method" "admin_tracker_migration_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.admin_tracker_migration.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "admin_tracker_migration_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.admin_tracker_migration.id
  http_method             = aws_api_gateway_method.admin_tracker_migration_post.http_method
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
# Task MCP Servers Methods (GET, PUT)
# /sprints/{sprintId}/tasks/{taskId}/mcp-servers
# =============================================================================
resource "aws_api_gateway_method" "task_mcp_servers_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.task_mcp_servers.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.sprintId" = true
    "method.request.path.taskId"   = true
  }
}

resource "aws_api_gateway_method" "task_mcp_servers_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.task_mcp_servers.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.sprintId" = true
    "method.request.path.taskId"   = true
  }
}

resource "aws_api_gateway_integration" "task_mcp_servers_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.task_mcp_servers.id
  http_method             = aws_api_gateway_method.task_mcp_servers_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.tasks_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "task_mcp_servers_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.task_mcp_servers.id
  http_method             = aws_api_gateway_method.task_mcp_servers_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.tasks_lambda_invoke_arn
}

# =============================================================================
# Task Steering Docs Methods (GET, PUT)
# /sprints/{sprintId}/tasks/{taskId}/steering-docs
# =============================================================================
resource "aws_api_gateway_method" "task_steering_docs_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.task_steering_docs.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.sprintId" = true
    "method.request.path.taskId"   = true
  }
}

resource "aws_api_gateway_method" "task_steering_docs_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.task_steering_docs.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.sprintId" = true
    "method.request.path.taskId"   = true
  }
}

resource "aws_api_gateway_integration" "task_steering_docs_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.task_steering_docs.id
  http_method             = aws_api_gateway_method.task_steering_docs_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.tasks_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "task_steering_docs_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.task_steering_docs.id
  http_method             = aws_api_gateway_method.task_steering_docs_put.http_method
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

# /sprints/{sprintId}/realtime-token
resource "aws_api_gateway_resource" "sprint_realtime_token" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "realtime-token"
}

# /projects/{projectId}/realtime-token
resource "aws_api_gateway_resource" "project_realtime_token" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "realtime-token"
}

# /sprints/{sprintId}/discussions
resource "aws_api_gateway_resource" "discussions" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "discussions"
}
resource "aws_api_gateway_resource" "discussion" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussions.id
  path_part   = "{discussionId}"
}
resource "aws_api_gateway_resource" "discussion_messages" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussion.id
  path_part   = "messages"
}
resource "aws_api_gateway_resource" "discussion_message" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussion_messages.id
  path_part   = "{messageId}"
}
resource "aws_api_gateway_resource" "discussion_message_redact" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussion_message.id
  path_part   = "redact"
}
resource "aws_api_gateway_resource" "discussion_read" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussion.id
  path_part   = "read"
}
resource "aws_api_gateway_resource" "discussion_assist" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussion.id
  path_part   = "assist"
}
# Static sibling of {discussionId} — API Gateway resolves static parts first.
resource "aws_api_gateway_resource" "discussions_search" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussions.id
  path_part   = "search"
}

# -----------------------------------------------------------------------------
# /blocks Resources (reusable-block library)
# Top-level (tenant-scoped, not project/sprint-scoped). Generic over block type:
#   /blocks/{type}                 GET (list), POST (create)
#   /blocks/{type}/{id}            GET, PUT, DELETE
#   /blocks/{type}/{id}/body       GET (lazy-load the S3 body/script)
# All routes hit the single building-blocks Lambda, which routes by path+method.
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "blocks" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "blocks"
}

resource "aws_api_gateway_resource" "block_type" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.blocks.id
  path_part   = "{type}"
}

resource "aws_api_gateway_resource" "block_item" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.block_type.id
  path_part   = "{id}"
}

resource "aws_api_gateway_resource" "block_item_body" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.block_item.id
  path_part   = "body"
}

# Collection: GET (list), POST (create)
resource "aws_api_gateway_method" "block_collection_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_type.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true }
}

resource "aws_api_gateway_method" "block_collection_post" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_type.id
  http_method        = "POST"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true }
}

resource "aws_api_gateway_integration" "block_collection_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_type.id
  http_method             = aws_api_gateway_method.block_collection_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "block_collection_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_type.id
  http_method             = aws_api_gateway_method.block_collection_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

# Item: GET, PUT, DELETE
resource "aws_api_gateway_method" "block_item_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_item.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true, "method.request.path.id" = true }
}

resource "aws_api_gateway_method" "block_item_put" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_item.id
  http_method        = "PUT"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true, "method.request.path.id" = true }
}

resource "aws_api_gateway_method" "block_item_delete" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_item.id
  http_method        = "DELETE"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true, "method.request.path.id" = true }
}

resource "aws_api_gateway_integration" "block_item_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_item.id
  http_method             = aws_api_gateway_method.block_item_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "block_item_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_item.id
  http_method             = aws_api_gateway_method.block_item_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "block_item_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_item.id
  http_method             = aws_api_gateway_method.block_item_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

# Item body: GET (lazy-load the S3-stored body/script)
resource "aws_api_gateway_method" "block_item_body_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_item_body.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true, "method.request.path.id" = true }
}

resource "aws_api_gateway_integration" "block_item_body_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_item_body.id
  http_method             = aws_api_gateway_method.block_item_body_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

module "cors_block_type" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.block_type.id
}

module "cors_block_item" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.block_item.id
}

module "cors_block_item_body" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.block_item_body.id
}

resource "aws_lambda_permission" "building_blocks" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.building_blocks_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# -----------------------------------------------------------------------------
# /workflows Resources (composition over the block library)
# Top-level (tenant-scoped). A workflow loads whole in one request:
#   /workflows                              GET (list), POST (create)
#   /workflows/{workflowId}                 GET (full composition), PUT, DELETE
#   /workflows/{workflowId}/groupings       PUT (replace the grouping tree)
#   /workflows/{workflowId}/placements      POST (add a skill placement)
#   /workflows/{workflowId}/placements/{skillId}   PUT, DELETE
# All routes hit the single workflows Lambda, which routes by path + method.
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "workflows" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "workflows"
}

resource "aws_api_gateway_resource" "workflow" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflows.id
  path_part   = "{workflowId}"
}

resource "aws_api_gateway_resource" "workflow_groupings" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow.id
  path_part   = "groupings"
}

resource "aws_api_gateway_resource" "workflow_placements" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow.id
  path_part   = "placements"
}

resource "aws_api_gateway_resource" "workflow_placement" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow_placements.id
  path_part   = "{skillId}"
}

# Method + AWS_PROXY integration for every (resource, verb) the workflows
# lambda serves. Driven by a map so the boilerplate stays in one place.
locals {
  workflow_routes = {
    collection_get   = { resource = aws_api_gateway_resource.workflows.id, method = "GET" }
    collection_post  = { resource = aws_api_gateway_resource.workflows.id, method = "POST" }
    item_get         = { resource = aws_api_gateway_resource.workflow.id, method = "GET" }
    item_put         = { resource = aws_api_gateway_resource.workflow.id, method = "PUT" }
    item_delete      = { resource = aws_api_gateway_resource.workflow.id, method = "DELETE" }
    groupings_put    = { resource = aws_api_gateway_resource.workflow_groupings.id, method = "PUT" }
    placements_post  = { resource = aws_api_gateway_resource.workflow_placements.id, method = "POST" }
    placement_put    = { resource = aws_api_gateway_resource.workflow_placement.id, method = "PUT" }
    placement_delete = { resource = aws_api_gateway_resource.workflow_placement.id, method = "DELETE" }
  }
}

resource "aws_api_gateway_method" "workflow" {
  for_each      = local.workflow_routes
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = each.value.resource
  http_method   = each.value.method
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "workflow" {
  for_each                = local.workflow_routes
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.resource
  http_method             = aws_api_gateway_method.workflow[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.workflows_lambda_invoke_arn
}

module "cors_workflows" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflows.id
}

module "cors_workflow" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow.id
}

module "cors_workflow_groupings" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_groupings.id
}

module "cors_workflow_placements" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_placements.id
}

module "cors_workflow_placement" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_placement.id
}

resource "aws_lambda_permission" "workflows" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.workflows_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
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
# Realtime-token Methods (POST sprint + project variants)
# =============================================================================
resource "aws_api_gateway_method" "sprint_realtime_token_post" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprint_realtime_token.id
  http_method        = "POST"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}
resource "aws_api_gateway_method" "project_realtime_token_post" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.project_realtime_token.id
  http_method        = "POST"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.projectId" = true }
}

resource "aws_api_gateway_integration" "sprint_realtime_token_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprint_realtime_token.id
  http_method             = aws_api_gateway_method.sprint_realtime_token_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.discussions_lambda_invoke_arn
}
resource "aws_api_gateway_integration" "project_realtime_token_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_realtime_token.id
  http_method             = aws_api_gateway_method.project_realtime_token_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.discussions_lambda_invoke_arn
}

# =============================================================================
# Discussions Methods
#   GET/POST /sprints/{sprintId}/discussions
#   GET/POST /sprints/{sprintId}/discussions/{discussionId}/messages
# =============================================================================
locals {
  discussion_routes = {
    discussions_get = {
      resource = "discussions"
      method   = "GET"
      params   = { "method.request.path.sprintId" = true }
    }
    discussions_post = {
      resource = "discussions"
      method   = "POST"
      params   = { "method.request.path.sprintId" = true }
    }
    discussions_search_get = {
      resource = "discussions_search"
      method   = "GET"
      params   = { "method.request.path.sprintId" = true }
    }
    discussion_put = {
      resource = "discussion"
      method   = "PUT"
      params   = { "method.request.path.sprintId" = true, "method.request.path.discussionId" = true }
    }
    discussion_read_put = {
      resource = "discussion_read"
      method   = "PUT"
      params   = { "method.request.path.sprintId" = true, "method.request.path.discussionId" = true }
    }
    discussion_assist_post = {
      resource = "discussion_assist"
      method   = "POST"
      params   = { "method.request.path.sprintId" = true, "method.request.path.discussionId" = true }
    }
    discussion_messages_get = {
      resource = "discussion_messages"
      method   = "GET"
      params   = { "method.request.path.sprintId" = true, "method.request.path.discussionId" = true }
    }
    discussion_messages_post = {
      resource = "discussion_messages"
      method   = "POST"
      params   = { "method.request.path.sprintId" = true, "method.request.path.discussionId" = true }
    }
    discussion_message_redact_post = {
      resource = "discussion_message_redact"
      method   = "POST"
      params = {
        "method.request.path.sprintId"     = true,
        "method.request.path.discussionId" = true,
        "method.request.path.messageId"    = true,
      }
    }
  }
  discussion_resource_ids = {
    discussions               = aws_api_gateway_resource.discussions.id
    discussions_search        = aws_api_gateway_resource.discussions_search.id
    discussion                = aws_api_gateway_resource.discussion.id
    discussion_read           = aws_api_gateway_resource.discussion_read.id
    discussion_assist         = aws_api_gateway_resource.discussion_assist.id
    discussion_messages       = aws_api_gateway_resource.discussion_messages.id
    discussion_message_redact = aws_api_gateway_resource.discussion_message_redact.id
  }
}

resource "aws_api_gateway_method" "discussion_routes" {
  for_each           = local.discussion_routes
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = local.discussion_resource_ids[each.value.resource]
  http_method        = each.value.method
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = each.value.params
}

resource "aws_api_gateway_integration" "discussion_routes" {
  for_each                = local.discussion_routes
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = local.discussion_resource_ids[each.value.resource]
  http_method             = aws_api_gateway_method.discussion_routes[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.discussions_lambda_invoke_arn
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

module "cors_migrate_tracker" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.migrate_tracker.id
}

module "cors_admin_tracker_migration" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.admin_tracker_migration.id
}

module "cors_admin_tracker_migration_status" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.admin_tracker_migration_status.id
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

module "cors_task_mcp_servers" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.task_mcp_servers.id
}

module "cors_task_steering_docs" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.task_steering_docs.id
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

module "cors_sprint_realtime_token" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.sprint_realtime_token.id
}

module "cors_project_realtime_token" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_realtime_token.id
}

module "cors_discussions" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussions.id
}

module "cors_discussion" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussion.id
}

module "cors_discussion_messages" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussion_messages.id
}

module "cors_discussion_message_redact" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussion_message_redact.id
}

module "cors_discussion_read" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussion_read.id
}

module "cors_discussion_assist" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussion_assist.id
}

module "cors_discussions_search" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussions_search.id
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

resource "aws_lambda_permission" "discussions" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.discussions_lambda_name
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

# =============================================================================
# /trackers — provider-agnostic tracker provider routes (issue #196)
#
# Backs the post-Phase-2 frontend. Replaces /github/repos/{o}/{r}/issues* —
# old route paths are no longer registered; clients call the binding-keyed
# routes under /projects/{projectId}/trackers/{bindingId}/issues instead.
# =============================================================================

# /trackers
resource "aws_api_gateway_resource" "trackers_root" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "trackers"
}

# /trackers/auth/{provider}
resource "aws_api_gateway_resource" "trackers_auth" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "auth"
}

resource "aws_api_gateway_resource" "trackers_auth_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_auth.id
  path_part   = "{provider}"
}

# /trackers/callback/{provider}
resource "aws_api_gateway_resource" "trackers_callback" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "callback"
}

resource "aws_api_gateway_resource" "trackers_callback_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_callback.id
  path_part   = "{provider}"
}

# /trackers/external-projects/{provider}/{instance} — picker for listing
# resources the user can bind (Jira projects today; future providers'
# equivalents). Phase 3 / #197.
resource "aws_api_gateway_resource" "trackers_external_projects" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "external-projects"
}

resource "aws_api_gateway_resource" "trackers_external_projects_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_external_projects.id
  path_part   = "{provider}"
}

resource "aws_api_gateway_resource" "trackers_external_projects_provider_instance" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_external_projects_provider.id
  path_part   = "{instance}"
}

# /trackers/connections/{provider}/{instance} — finalize an OAuth flow that
# returned a pendingChoice (Jira multi-site picker). POST only.
resource "aws_api_gateway_resource" "trackers_connections" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "connections"
}

resource "aws_api_gateway_resource" "trackers_connections_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_connections.id
  path_part   = "{provider}"
}

resource "aws_api_gateway_resource" "trackers_connections_provider_instance" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_connections_provider.id
  path_part   = "{instance}"
}

# /trackers/providers — operator OAuth-config status + admin secret
# writer. Sibling to the `{provider}` path parameter below; API Gateway
# matches the literal `providers` first when both are present.
resource "aws_api_gateway_resource" "trackers_providers" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "providers"
}

resource "aws_api_gateway_resource" "trackers_providers_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_providers.id
  path_part   = "{provider}"
}

resource "aws_api_gateway_resource" "trackers_providers_provider_oauth_config" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_providers_provider.id
  path_part   = "oauth-config"
}

# /trackers/{provider}/{instance}
resource "aws_api_gateway_resource" "trackers_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "{provider}"
}

resource "aws_api_gateway_resource" "trackers_provider_instance" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_provider.id
  path_part   = "{instance}"
}

# /projects/{projectId}/trackers
resource "aws_api_gateway_resource" "project_trackers" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "trackers"
}

resource "aws_api_gateway_resource" "project_tracker_binding" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project_trackers.id
  path_part   = "{bindingId}"
}

resource "aws_api_gateway_resource" "project_tracker_binding_issues" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project_tracker_binding.id
  path_part   = "issues"
}

resource "aws_api_gateway_resource" "project_tracker_binding_issue" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project_tracker_binding_issues.id
  path_part   = "{resourceId}"
}

resource "aws_api_gateway_resource" "project_tracker_binding_issue_comments" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project_tracker_binding_issue.id
  path_part   = "comments"
}

# Helper local for the tracker integration uri — every method below points here.
locals {
  trackers_integration_uri = var.trackers_lambda_invoke_arn
}

# GET /trackers
resource "aws_api_gateway_method" "trackers_root_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_root.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "trackers_root_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_root.id
  http_method             = aws_api_gateway_method.trackers_root_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_root" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_root.id
}

# GET /trackers/auth/{provider}
resource "aws_api_gateway_method" "trackers_auth_provider_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_auth_provider.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.provider" = true
  }
}

resource "aws_api_gateway_integration" "trackers_auth_provider_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_auth_provider.id
  http_method             = aws_api_gateway_method.trackers_auth_provider_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_auth_provider" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_auth_provider.id
}

# GET /trackers/callback/{provider} — no auth (the OAuth provider redirects
# the user's browser here without a Cognito JWT). The handler validates the
# HMAC-signed `state` parameter to bind the callback to the user who started
# the flow.
resource "aws_api_gateway_method" "trackers_callback_provider_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_callback_provider.id
  http_method   = "GET"
  authorization = "NONE"
  request_parameters = {
    "method.request.path.provider" = true
  }
}

resource "aws_api_gateway_integration" "trackers_callback_provider_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_callback_provider.id
  http_method             = aws_api_gateway_method.trackers_callback_provider_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_callback_provider" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_callback_provider.id
}

# GET /trackers/external-projects/{provider}/{instance}
resource "aws_api_gateway_method" "trackers_external_projects_provider_instance_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_external_projects_provider_instance.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.provider" = true
    "method.request.path.instance" = true
  }
}

resource "aws_api_gateway_integration" "trackers_external_projects_provider_instance_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_external_projects_provider_instance.id
  http_method             = aws_api_gateway_method.trackers_external_projects_provider_instance_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_external_projects_provider_instance" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_external_projects_provider_instance.id
}

# POST /trackers/connections/{provider}/{instance}
resource "aws_api_gateway_method" "trackers_connections_provider_instance_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_connections_provider_instance.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.provider" = true
    "method.request.path.instance" = true
  }
}

resource "aws_api_gateway_integration" "trackers_connections_provider_instance_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_connections_provider_instance.id
  http_method             = aws_api_gateway_method.trackers_connections_provider_instance_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_connections_provider_instance" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_connections_provider_instance.id
}

# GET /trackers/providers — operator OAuth-config status
resource "aws_api_gateway_method" "trackers_providers_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_providers.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "trackers_providers_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_providers.id
  http_method             = aws_api_gateway_method.trackers_providers_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_providers" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_providers.id
}

# PUT /trackers/providers/{provider}/oauth-config — admin secret writer
resource "aws_api_gateway_method" "trackers_providers_provider_oauth_config_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_providers_provider_oauth_config.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.provider" = true
  }
}

resource "aws_api_gateway_integration" "trackers_providers_provider_oauth_config_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_providers_provider_oauth_config.id
  http_method             = aws_api_gateway_method.trackers_providers_provider_oauth_config_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_providers_provider_oauth_config" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_providers_provider_oauth_config.id
}

# DELETE /trackers/{provider}/{instance}
resource "aws_api_gateway_method" "trackers_provider_instance_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_provider_instance.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.provider" = true
    "method.request.path.instance" = true
  }
}

resource "aws_api_gateway_integration" "trackers_provider_instance_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_provider_instance.id
  http_method             = aws_api_gateway_method.trackers_provider_instance_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_provider_instance" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_provider_instance.id
}

# GET /projects/{projectId}/trackers
resource "aws_api_gateway_method" "project_trackers_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_trackers.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "project_trackers_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_trackers.id
  http_method             = aws_api_gateway_method.project_trackers_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

# POST /projects/{projectId}/trackers
resource "aws_api_gateway_method" "project_trackers_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_trackers.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "project_trackers_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_trackers.id
  http_method             = aws_api_gateway_method.project_trackers_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_project_trackers" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_trackers.id
}

# DELETE /projects/{projectId}/trackers/{bindingId}
resource "aws_api_gateway_method" "project_tracker_binding_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_tracker_binding.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId" = true
    "method.request.path.bindingId" = true
  }
}

resource "aws_api_gateway_integration" "project_tracker_binding_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_tracker_binding.id
  http_method             = aws_api_gateway_method.project_tracker_binding_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_project_tracker_binding" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_tracker_binding.id
}

# GET /projects/{projectId}/trackers/{bindingId}/issues
resource "aws_api_gateway_method" "project_tracker_binding_issues_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_tracker_binding_issues.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId" = true
    "method.request.path.bindingId" = true
  }
}

resource "aws_api_gateway_integration" "project_tracker_binding_issues_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_tracker_binding_issues.id
  http_method             = aws_api_gateway_method.project_tracker_binding_issues_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_project_tracker_binding_issues" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_tracker_binding_issues.id
}

# GET /projects/{projectId}/trackers/{bindingId}/issues/{resourceId}
resource "aws_api_gateway_method" "project_tracker_binding_issue_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_tracker_binding_issue.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId"  = true
    "method.request.path.bindingId"  = true
    "method.request.path.resourceId" = true
  }
}

resource "aws_api_gateway_integration" "project_tracker_binding_issue_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_tracker_binding_issue.id
  http_method             = aws_api_gateway_method.project_tracker_binding_issue_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_project_tracker_binding_issue" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_tracker_binding_issue.id
}

# GET /projects/{projectId}/trackers/{bindingId}/issues/{resourceId}/comments
resource "aws_api_gateway_method" "project_tracker_binding_issue_comments_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_tracker_binding_issue_comments.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId"  = true
    "method.request.path.bindingId"  = true
    "method.request.path.resourceId" = true
  }
}

resource "aws_api_gateway_integration" "project_tracker_binding_issue_comments_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_tracker_binding_issue_comments.id
  http_method             = aws_api_gateway_method.project_tracker_binding_issue_comments_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_project_tracker_binding_issue_comments" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_tracker_binding_issue_comments.id
}

resource "aws_lambda_permission" "trackers" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.trackers_lambda_name
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

# ===========================================================================
# Multi-repo project /repos routes (projects lambda, PR #183)
# ===========================================================================
# -----------------------------------------------------------------------------
# /projects/{projectId}/repos Resource (multi-repo support, projects lambda)
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "repos" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "repos"
}

# =============================================================================
# Repos Methods (GET list, POST add, DELETE remove — projects lambda)
# DELETE takes the repo url as a ?url= query param, so it lives on the same
# resource (no child resource needed).
# =============================================================================
resource "aws_api_gateway_method" "repos_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.repos.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "repos_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.repos.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "repos_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.repos.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "repos_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.repos.id
  http_method             = aws_api_gateway_method.repos_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "repos_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.repos.id
  http_method             = aws_api_gateway_method.repos_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "repos_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.repos.id
  http_method             = aws_api_gateway_method.repos_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

module "cors_repos" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.repos.id
}
